const axios = require('axios');
const { ethers } = require('ethers');
const EventEmitter = require('events');
const config = require('../../config.json');

/**
 * Multi-Source Oracle Aggregator
 * Pulls price data from Chainlink, Pyth, RedStone, and custom APIs
 * Implements median aggregation with standard deviation capping
 */
class OracleAggregator extends EventEmitter {
  constructor(configOverride = {}) {
    super();
    this.config = { ...config.oracle, ...configOverride };
    this.providers = new Map();
    this.priceCache = new Map();
    this.slashingRegistry = new Map();
    this.initializeProviders();
  }

  initializeProviders() {
    // Initialize Chainlink providers
    if (this.config.sources.chainlink.enabled) {
      const chainlinkProvider = new ethers.JsonRpcProvider(
        this.config.sources.chainlink.endpoints.ethereum
      );
      this.providers.set('chainlink', {
        provider: chainlinkProvider,
        weight: this.config.sources.chainlink.weight,
        fetch: this.fetchChainlinkPrice.bind(this)
      });
    }

    // Initialize Pyth
    if (this.config.sources.pyth.enabled) {
      this.providers.set('pyth', {
        endpoint: this.config.sources.pyth.endpoint,
        weight: this.config.sources.pyth.weight,
        fetch: this.fetchPythPrice.bind(this)
      });
    }

    // Initialize RedStone
    if (this.config.sources.redstone.enabled) {
      this.providers.set('redstone', {
        endpoint: this.config.sources.redstone.endpoint,
        weight: this.config.sources.redstone.weight,
        fetch: this.fetchRedStonePrice.bind(this)
      });
    }

    console.log(`✓ Initialized ${this.providers.size} oracle sources`);
  }

  /**
   * Fetch price from Chainlink oracle
   */
  async fetchChainlinkPrice(token, priceFeedAddress) {
    try {
      const provider = this.providers.get('chainlink').provider;
      const aggregatorV3InterfaceABI = [
        {
          inputs: [],
          name: 'latestRoundData',
          outputs: [
            { name: 'roundId', type: 'uint80' },
            { name: 'answer', type: 'int256' },
            { name: 'startedAt', type: 'uint256' },
            { name: 'updatedAt', type: 'uint256' },
            { name: 'answeredInRound', type: 'uint80' }
          ],
          stateMutability: 'view',
          type: 'function'
        }
      ];

      const priceFeed = new ethers.Contract(
        priceFeedAddress,
        aggregatorV3InterfaceABI,
        provider
      );

      const roundData = await priceFeed.latestRoundData();
      const price = Number(roundData.answer) / 1e8;
      const timestamp = Number(roundData.updatedAt);

      return {
        source: 'chainlink',
        price,
        timestamp,
        confidence: 0.95,
        raw: roundData
      };
    } catch (error) {
      console.error(`Chainlink fetch error for ${token}:`, error.message);
      return null;
    }
  }

  /**
   * Fetch price from Pyth Network
   */
  async fetchPythPrice(token, pythPriceId) {
    try {
      const endpoint = this.providers.get('pyth').endpoint;
      const response = await axios.get(
        `${endpoint}/api/latest_price_feeds`,
        {
          params: { ids: [pythPriceId] }
        }
      );

      const priceData = response.data[0];
      if (!priceData) return null;

      const price = Number(priceData.price.price) * Math.pow(10, priceData.price.expo);
      const timestamp = priceData.price.publish_time;
      const confidence = Number(priceData.price.conf) * Math.pow(10, priceData.price.expo);

      return {
        source: 'pyth',
        price,
        timestamp,
        confidence: confidence / price,
        raw: priceData
      };
    } catch (error) {
      console.error(`Pyth fetch error for ${token}:`, error.message);
      return null;
    }
  }

  /**
   * Fetch price from RedStone
   */
  async fetchRedStonePrice(token) {
    try {
      const endpoint = this.providers.get('redstone').endpoint;
      const response = await axios.get(
        `${endpoint}/prices`,
        {
          params: {
            symbol: token,
            provider: 'redstone',
            limit: 1
          }
        }
      );

      const priceData = response.data[0];
      if (!priceData) return null;

      return {
        source: 'redstone',
        price: priceData.value,
        timestamp: priceData.timestamp,
        confidence: 0.9,
        raw: priceData
      };
    } catch (error) {
      console.error(`RedStone fetch error for ${token}:`, error.message);
      return null;
    }
  }

  /**
   * Get verified price with median aggregation and outlier detection
   */
  async getVerifiedPrice(token, feedAddresses = {}) {
    const prices = [];
    const sources = [];

    // Fetch from all sources
    for (const [sourceName, sourceConfig] of this.providers) {
      let priceData;

      if (sourceName === 'chainlink' && feedAddresses.chainlink) {
        priceData = await sourceConfig.fetch(token, feedAddresses.chainlink);
      } else if (sourceName === 'pyth' && feedAddresses.pyth) {
        priceData = await sourceConfig.fetch(token, feedAddresses.pyth);
      } else if (sourceName === 'redstone') {
        priceData = await sourceConfig.fetch(token);
      }

      if (priceData) {
        prices.push({
          ...priceData,
          weight: sourceConfig.weight
        });
        sources.push(sourceName);
      }
    }

    if (prices.length < this.config.aggregation.minSources) {
      throw new Error(
        `Insufficient oracle sources: got ${prices.length}, need ${this.config.aggregation.minSources}`
      );
    }

    // Calculate median and standard deviation
    const priceValues = prices.map(p => p.price);
    const median = this.calculateMedian(priceValues);
    const stdDev = this.calculateStdDev(priceValues, median);

    // Filter outliers based on standard deviation cap
    const filteredPrices = prices.filter(p => {
      const zScore = Math.abs((p.price - median) / stdDev);
      const isOutlier = zScore > this.config.aggregation.stdDevCap;

      if (isOutlier && this.config.slashing.enabled) {
        this.slashSource(p.source, token, p.price, median);
      }

      return !isOutlier;
    });

    // Weighted average of filtered prices
    const weightedSum = filteredPrices.reduce(
      (sum, p) => sum + p.price * p.weight,
      0
    );
    const totalWeight = filteredPrices.reduce((sum, p) => sum + p.weight, 0);
    const aggregatedPrice = weightedSum / totalWeight;

    // Calculate aggregate confidence
    const avgConfidence = filteredPrices.reduce(
      (sum, p) => sum + p.confidence,
      0
    ) / filteredPrices.length;

    const result = {
      token,
      price: aggregatedPrice,
      median,
      stdDev,
      confidence: avgConfidence,
      timestamp: Date.now(),
      sources: filteredPrices.map(p => ({
        source: p.source,
        price: p.price,
        weight: p.weight
      })),
      verification: {
        zkProofHash: this.generateZKProofHash(filteredPrices),
        signatureHash: this.generateSignatureHash(aggregatedPrice, Date.now())
      }
    };

    // Cache the result
    this.priceCache.set(token, result);
    this.emit('priceUpdate', result);

    return result;
  }

  /**
   * Calculate median of an array
   */
  calculateMedian(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }

  /**
   * Calculate standard deviation
   */
  calculateStdDev(values, mean) {
    const squareDiffs = values.map(value => Math.pow(value - mean, 2));
    const avgSquareDiff = squareDiffs.reduce((a, b) => a + b, 0) / values.length;
    return Math.sqrt(avgSquareDiff);
  }

  /**
   * Slash a source for providing outlier data
   */
  slashSource(source, token, reportedPrice, actualPrice) {
    const deviation = Math.abs((reportedPrice - actualPrice) / actualPrice);

    if (deviation > this.config.slashing.threshold) {
      const slashRecord = {
        source,
        token,
        reportedPrice,
        actualPrice,
        deviation,
        timestamp: Date.now(),
        penalty: this.config.slashing.penaltyAmount
      };

      const key = `${source}-${token}`;
      if (!this.slashingRegistry.has(key)) {
        this.slashingRegistry.set(key, []);
      }
      this.slashingRegistry.get(key).push(slashRecord);

      this.emit('slashing', slashRecord);
      console.warn(`⚠ Slashed ${source} for ${token}: ${deviation.toFixed(4)} deviation`);
    }
  }

  /**
   * Generate ZK proof hash (simplified version)
   */
  generateZKProofHash(prices) {
    const data = prices.map(p => `${p.source}:${p.price}:${p.timestamp}`).join('|');
    return ethers.keccak256(ethers.toUtf8Bytes(data));
  }

  /**
   * Generate signature hash for attestation
   */
  generateSignatureHash(price, timestamp) {
    const data = ethers.solidityPacked(
      ['uint256', 'uint256'],
      [Math.floor(price * 1e18), timestamp]
    );
    return ethers.keccak256(data);
  }

  /**
   * Get cached price
   */
  getCachedPrice(token) {
    return this.priceCache.get(token);
  }

  /**
   * Get slashing history
   */
  getSlashingHistory(source, token) {
    const key = token ? `${source}-${token}` : source;
    return this.slashingRegistry.get(key) || [];
  }
}

module.exports = OracleAggregator;

// CLI usage
if (require.main === module) {
  const aggregator = new OracleAggregator();

  // Example: Get ETH/USD price
  const exampleAddresses = {
    chainlink: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419', // ETH/USD on mainnet
    pyth: '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace' // ETH/USD
  };

  aggregator.getVerifiedPrice('ETH', exampleAddresses)
    .then(result => {
      console.log('\n✓ Verified Price Result:');
      console.log(JSON.stringify(result, null, 2));
    })
    .catch(error => {
      console.error('Error:', error.message);
    });

  // Listen to events
  aggregator.on('priceUpdate', (data) => {
    console.log(`📊 Price update: ${data.token} = $${data.price.toFixed(2)}`);
  });

  aggregator.on('slashing', (record) => {
    console.log(`⚠ Slashing event: ${record.source} (${record.deviation.toFixed(4)})`);
  });
}
