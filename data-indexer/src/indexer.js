const { ethers } = require('ethers');
const EventEmitter = require('events');
const fs = require('fs').promises;
const path = require('path');
const config = require('../../config.json');

/**
 * DeFi Historical Data Indexer
 * Tracks on-chain state, token volumes, slippage, and lending rates
 * Provides time-series data for analytics
 */
class DeFiIndexer extends EventEmitter {
  constructor(configOverride = {}) {
    super();
    this.config = { ...config.indexer, ...configOverride };
    this.providers = new Map();
    this.snapshots = new Map();
    this.timeSeries = new Map();
    this.currentBlock = new Map();
    this.dataPath = path.join(__dirname, '../data');
    this.initializeProviders();
  }

  async initializeProviders() {
    // Initialize providers for each chain
    for (const chain of this.config.chains) {
      try {
        const rpcUrl = this.getRPCUrl(chain);
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        this.providers.set(chain, provider);

        // Get current block
        const blockNumber = await provider.getBlockNumber();
        this.currentBlock.set(chain, blockNumber);

        console.log(`✓ Connected to ${chain} at block ${blockNumber}`);
      } catch (error) {
        console.error(`Failed to connect to ${chain}:`, error.message);
      }
    }

    // Ensure data directory exists
    try {
      await fs.mkdir(this.dataPath, { recursive: true });
      await fs.mkdir(path.join(this.dataPath, 'snapshots'), { recursive: true });
      await fs.mkdir(path.join(this.dataPath, 'timeseries'), { recursive: true });
    } catch (error) {
      console.error('Error creating data directories:', error.message);
    }
  }

  getRPCUrl(chain) {
    const urls = {
      ethereum: 'https://eth-mainnet.g.alchemy.com/v2/YOUR_API_KEY',
      polygon: 'https://polygon-mainnet.g.alchemy.com/v2/YOUR_API_KEY',
      arbitrum: 'https://arb-mainnet.g.alchemy.com/v2/YOUR_API_KEY',
      optimism: 'https://opt-mainnet.g.alchemy.com/v2/YOUR_API_KEY',
      base: 'https://base-mainnet.g.alchemy.com/v2/YOUR_API_KEY'
    };
    return urls[chain] || urls.ethereum;
  }

  /**
   * Index a block and extract DeFi data
   */
  async indexBlock(chain, blockNumber) {
    const provider = this.providers.get(chain);
    if (!provider) {
      throw new Error(`No provider for chain: ${chain}`);
    }

    const block = await provider.getBlock(blockNumber, true);
    if (!block) {
      throw new Error(`Block ${blockNumber} not found on ${chain}`);
    }

    const blockData = {
      chain,
      blockNumber,
      timestamp: block.timestamp,
      gasUsed: block.gasUsed.toString(),
      transactions: block.transactions.length,
      baseFeePerGas: block.baseFeePerGas?.toString(),
      protocols: {}
    };

    // Index protocol-specific data
    for (const protocol of this.config.protocols) {
      const protocolData = await this.indexProtocol(
        chain,
        protocol,
        block
      );
      blockData.protocols[protocol] = protocolData;
    }

    // Store snapshot if at interval
    if (blockNumber % this.config.snapshotInterval === 0) {
      await this.saveSnapshot(chain, blockNumber, blockData);
    }

    // Update time series
    this.updateTimeSeries(chain, blockData);

    this.emit('blockIndexed', blockData);
    return blockData;
  }

  /**
   * Index protocol-specific data (Uniswap, Aave, etc.)
   */
  async indexProtocol(chain, protocol, block) {
    const data = {
      volume: 0,
      tvl: 0,
      transactions: 0,
      pairs: []
    };

    try {
      switch (protocol) {
        case 'uniswap':
          return await this.indexUniswap(chain, block);
        case 'aave':
          return await this.indexAave(chain, block);
        case 'compound':
          return await this.indexCompound(chain, block);
        case 'curve':
          return await this.indexCurve(chain, block);
        default:
          return data;
      }
    } catch (error) {
      console.error(`Error indexing ${protocol} on ${chain}:`, error.message);
      return data;
    }
  }

  /**
   * Index Uniswap V3 data
   */
  async indexUniswap(chain, block) {
    const provider = this.providers.get(chain);
    const data = {
      volume: 0,
      tvl: 0,
      transactions: 0,
      swaps: [],
      pairs: []
    };

    // Uniswap V3 Factory address
    const factoryAddress = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
    const swapEventTopic = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'; // Swap event

    // Filter swap events in block
    const logs = await provider.getLogs({
      fromBlock: block.number,
      toBlock: block.number,
      topics: [swapEventTopic]
    });

    data.transactions = logs.length;

    // Parse swap events (simplified)
    for (const log of logs.slice(0, 10)) { // Limit to first 10 for performance
      try {
        data.swaps.push({
          address: log.address,
          txHash: log.transactionHash,
          blockNumber: log.blockNumber
        });
      } catch (error) {
        // Skip unparseable logs
      }
    }

    return data;
  }

  /**
   * Index Aave lending data
   */
  async indexAave(chain, block) {
    const data = {
      totalDeposits: 0,
      totalBorrows: 0,
      utilizationRate: 0,
      assets: []
    };

    // Aave V3 Pool address (Ethereum)
    const poolAddress = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2';

    // In production, read reserve data from Aave contracts
    // This is a simplified version
    data.assets = [
      { symbol: 'USDC', supplyAPY: 2.5, borrowAPY: 4.2, utilization: 0.75 },
      { symbol: 'DAI', supplyAPY: 2.3, borrowAPY: 4.0, utilization: 0.72 },
      { symbol: 'ETH', supplyAPY: 1.8, borrowAPY: 3.5, utilization: 0.65 }
    ];

    return data;
  }

  /**
   * Index Compound lending data
   */
  async indexCompound(chain, block) {
    const data = {
      markets: [],
      totalSupply: 0,
      totalBorrow: 0
    };

    // Simplified Compound data
    data.markets = [
      { asset: 'USDC', supplyRate: 2.1, borrowRate: 3.8 },
      { asset: 'DAI', supplyRate: 2.0, borrowRate: 3.7 },
      { asset: 'ETH', supplyRate: 1.5, borrowRate: 3.2 }
    ];

    return data;
  }

  /**
   * Index Curve pool data
   */
  async indexCurve(chain, block) {
    const data = {
      pools: [],
      totalVolume: 0,
      totalTVL: 0
    };

    // Simplified Curve data
    data.pools = [
      { name: '3pool', tvl: 1500000000, volume24h: 50000000 },
      { name: 'stETH', tvl: 800000000, volume24h: 30000000 }
    ];

    return data;
  }

  /**
   * Update time series data
   */
  updateTimeSeries(chain, blockData) {
    const key = `${chain}-${blockData.blockNumber}`;

    if (!this.timeSeries.has(chain)) {
      this.timeSeries.set(chain, []);
    }

    const series = this.timeSeries.get(chain);
    series.push({
      block: blockData.blockNumber,
      timestamp: blockData.timestamp,
      gasUsed: blockData.gasUsed,
      transactions: blockData.transactions,
      protocols: blockData.protocols
    });

    // Keep only last 10000 blocks in memory
    if (series.length > 10000) {
      series.shift();
    }
  }

  /**
   * Get historical volume for a trading pair
   */
  async getHistoricalVolume(chain, pair, startBlock, endBlock) {
    const series = this.timeSeries.get(chain) || [];

    const filtered = series.filter(
      s => s.block >= startBlock && s.block <= endBlock
    );

    const volumes = filtered.map(s => {
      const uniswapData = s.protocols?.uniswap || {};
      return {
        block: s.block,
        timestamp: s.timestamp,
        volume: uniswapData.volume || 0,
        transactions: uniswapData.transactions || 0
      };
    });

    return {
      chain,
      pair,
      startBlock,
      endBlock,
      dataPoints: volumes.length,
      totalVolume: volumes.reduce((sum, v) => sum + v.volume, 0),
      data: volumes
    };
  }

  /**
   * Get lending rates time series
   */
  async getLendingRates(chain, protocol, asset, startBlock, endBlock) {
    const series = this.timeSeries.get(chain) || [];

    const filtered = series.filter(
      s => s.block >= startBlock && s.block <= endBlock
    );

    const rates = filtered.map(s => {
      const protocolData = s.protocols?.[protocol] || {};
      const assetData = protocolData.assets?.find(a => a.symbol === asset) ||
                       protocolData.markets?.find(m => m.asset === asset);

      return {
        block: s.block,
        timestamp: s.timestamp,
        supplyAPY: assetData?.supplyAPY || assetData?.supplyRate || 0,
        borrowAPY: assetData?.borrowAPY || assetData?.borrowRate || 0,
        utilization: assetData?.utilization || 0
      };
    });

    return {
      chain,
      protocol,
      asset,
      startBlock,
      endBlock,
      dataPoints: rates.length,
      data: rates
    };
  }

  /**
   * Save snapshot to disk
   */
  async saveSnapshot(chain, blockNumber, data) {
    const filename = `${chain}-${blockNumber}.json`;
    const filepath = path.join(this.dataPath, 'snapshots', filename);

    try {
      await fs.writeFile(filepath, JSON.stringify(data, null, 2));
      console.log(`✓ Saved snapshot: ${filename}`);
    } catch (error) {
      console.error(`Error saving snapshot ${filename}:`, error.message);
    }
  }

  /**
   * Load snapshot from disk
   */
  async loadSnapshot(chain, blockNumber) {
    const filename = `${chain}-${blockNumber}.json`;
    const filepath = path.join(this.dataPath, 'snapshots', filename);

    try {
      const data = await fs.readFile(filepath, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      return null;
    }
  }

  /**
   * Export time series to JSON
   */
  async exportTimeSeries(chain, startBlock, endBlock, outputPath) {
    const series = this.timeSeries.get(chain) || [];
    const filtered = series.filter(
      s => s.block >= startBlock && s.block <= endBlock
    );

    const exportData = {
      chain,
      startBlock,
      endBlock,
      dataPoints: filtered.length,
      exported: Date.now(),
      data: filtered
    };

    await fs.writeFile(outputPath, JSON.stringify(exportData, null, 2));
    console.log(`✓ Exported ${filtered.length} data points to ${outputPath}`);

    return exportData;
  }

  /**
   * Start continuous indexing
   */
  async startIndexing(chain, intervalMs = 12000) {
    console.log(`Starting indexer for ${chain} (interval: ${intervalMs}ms)`);

    const indexLoop = async () => {
      try {
        const provider = this.providers.get(chain);
        const latestBlock = await provider.getBlockNumber();
        const lastIndexed = this.currentBlock.get(chain);

        if (latestBlock > lastIndexed) {
          for (let block = lastIndexed + 1; block <= latestBlock; block++) {
            await this.indexBlock(chain, block);
            this.currentBlock.set(chain, block);

            // Process in batches to avoid overload
            if ((block - lastIndexed) % this.config.batchSize === 0) {
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          }
        }
      } catch (error) {
        console.error(`Indexing error for ${chain}:`, error.message);
      }
    };

    // Initial index
    await indexLoop();

    // Set up interval
    setInterval(indexLoop, intervalMs);
  }

  /**
   * Get current state snapshot
   */
  getCurrentState(chain) {
    const series = this.timeSeries.get(chain) || [];
    return series[series.length - 1] || null;
  }
}

module.exports = DeFiIndexer;

// CLI usage
if (require.main === module) {
  const indexer = new DeFiIndexer();

  // Listen to events
  indexer.on('blockIndexed', (data) => {
    console.log(`📊 Indexed block ${data.blockNumber} on ${data.chain}`);
    console.log(`   Transactions: ${data.transactions}`);
    console.log(`   Protocols: ${Object.keys(data.protocols).join(', ')}`);
  });

  // Example: Index recent blocks
  (async () => {
    try {
      const chain = 'ethereum';
      const provider = indexer.providers.get(chain);
      const latestBlock = await provider.getBlockNumber();

      console.log(`\nIndexing blocks on ${chain}...`);

      // Index last 10 blocks
      for (let i = 0; i < 10; i++) {
        const blockNumber = latestBlock - i;
        await indexer.indexBlock(chain, blockNumber);
      }

      // Get historical volume
      const volume = await indexer.getHistoricalVolume(
        chain,
        'ETH/USDC',
        latestBlock - 100,
        latestBlock
      );
      console.log('\n✓ Historical Volume:');
      console.log(JSON.stringify(volume, null, 2));

      // Export data
      const exportPath = path.join(__dirname, '../data/export.json');
      await indexer.exportTimeSeries(chain, latestBlock - 100, latestBlock, exportPath);

    } catch (error) {
      console.error('Error:', error.message);
    }
  })();
}
