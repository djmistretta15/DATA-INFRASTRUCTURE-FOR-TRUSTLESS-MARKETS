const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const OracleAggregator = require('../../oracle-feeds/src/aggregator');
const DeFiIndexer = require('../../data-indexer/src/indexer');
const config = require('../../config.json');

/**
 * Analytics API Server
 * Exposes REST endpoints for oracle data, DeFi analytics, and attestations
 */
class AnalyticsAPI {
  constructor(port = 3000) {
    this.app = express();
    this.port = port;
    this.oracle = new OracleAggregator();
    this.indexer = new DeFiIndexer();
    this.cache = new Map();
    this.setupMiddleware();
    this.setupRoutes();
  }

  setupMiddleware() {
    // Security
    this.app.use(helmet());
    this.app.use(cors());

    // Performance
    this.app.use(compression());
    this.app.use(express.json());

    // Rate limiting (simple implementation)
    this.app.use((req, res, next) => {
      const ip = req.ip;
      const now = Date.now();
      const windowMs = config.api.rateLimit.windowMs;
      const max = config.api.rateLimit.max;

      if (!this.cache.has(`ratelimit-${ip}`)) {
        this.cache.set(`ratelimit-${ip}`, { count: 1, resetTime: now + windowMs });
        return next();
      }

      const data = this.cache.get(`ratelimit-${ip}`);
      if (now > data.resetTime) {
        data.count = 1;
        data.resetTime = now + windowMs;
      } else {
        data.count++;
      }

      if (data.count > max) {
        return res.status(429).json({
          error: 'Too many requests',
          message: `Rate limit exceeded. Max ${max} requests per ${windowMs}ms`
        });
      }

      next();
    });

    // Logging
    this.app.use((req, res, next) => {
      console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
      next();
    });
  }

  setupRoutes() {
    // Health check
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        timestamp: Date.now(),
        uptime: process.uptime(),
        version: '1.0.0'
      });
    });

    // ==================== ORACLE ENDPOINTS ====================

    /**
     * GET /api/oracle/price/:token
     * Get verified price for a token
     */
    this.app.get('/api/oracle/price/:token', async (req, res) => {
      try {
        const { token } = req.params;
        const { chainlink, pyth } = req.query;

        const feedAddresses = {
          chainlink,
          pyth
        };

        const price = await this.oracle.getVerifiedPrice(token, feedAddresses);
        res.json({
          success: true,
          data: price
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    /**
     * GET /api/oracle/cached/:token
     * Get cached price
     */
    this.app.get('/api/oracle/cached/:token', (req, res) => {
      const { token } = req.params;
      const cached = this.oracle.getCachedPrice(token);

      if (!cached) {
        return res.status(404).json({
          success: false,
          error: 'No cached price found'
        });
      }

      res.json({
        success: true,
        data: cached
      });
    });

    /**
     * GET /api/oracle/slashing/:source
     * Get slashing history
     */
    this.app.get('/api/oracle/slashing/:source', (req, res) => {
      const { source } = req.params;
      const { token } = req.query;

      const history = this.oracle.getSlashingHistory(source, token);

      res.json({
        success: true,
        data: {
          source,
          token: token || 'all',
          events: history.length,
          history
        }
      });
    });

    // ==================== INDEXER ENDPOINTS ====================

    /**
     * GET /api/indexer/block/:chain/:blockNumber
     * Get block data
     */
    this.app.get('/api/indexer/block/:chain/:blockNumber', async (req, res) => {
      try {
        const { chain, blockNumber } = req.params;
        const blockData = await this.indexer.indexBlock(chain, parseInt(blockNumber));

        res.json({
          success: true,
          data: blockData
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    /**
     * GET /api/indexer/volume/:chain/:pair
     * Get historical volume
     */
    this.app.get('/api/indexer/volume/:chain/:pair', async (req, res) => {
      try {
        const { chain, pair } = req.params;
        const { startBlock, endBlock } = req.query;

        if (!startBlock || !endBlock) {
          return res.status(400).json({
            success: false,
            error: 'startBlock and endBlock are required'
          });
        }

        const volume = await this.indexer.getHistoricalVolume(
          chain,
          pair,
          parseInt(startBlock),
          parseInt(endBlock)
        );

        res.json({
          success: true,
          data: volume
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    /**
     * GET /api/indexer/rates/:chain/:protocol/:asset
     * Get lending rates
     */
    this.app.get('/api/indexer/rates/:chain/:protocol/:asset', async (req, res) => {
      try {
        const { chain, protocol, asset } = req.params;
        const { startBlock, endBlock } = req.query;

        if (!startBlock || !endBlock) {
          return res.status(400).json({
            success: false,
            error: 'startBlock and endBlock are required'
          });
        }

        const rates = await this.indexer.getLendingRates(
          chain,
          protocol,
          asset,
          parseInt(startBlock),
          parseInt(endBlock)
        );

        res.json({
          success: true,
          data: rates
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    /**
     * GET /api/indexer/state/:chain
     * Get current state
     */
    this.app.get('/api/indexer/state/:chain', (req, res) => {
      const { chain } = req.params;
      const state = this.indexer.getCurrentState(chain);

      if (!state) {
        return res.status(404).json({
          success: false,
          error: 'No state data found'
        });
      }

      res.json({
        success: true,
        data: state
      });
    });

    /**
     * POST /api/indexer/export
     * Export time series data
     */
    this.app.post('/api/indexer/export', async (req, res) => {
      try {
        const { chain, startBlock, endBlock, outputPath } = req.body;

        if (!chain || !startBlock || !endBlock || !outputPath) {
          return res.status(400).json({
            success: false,
            error: 'chain, startBlock, endBlock, and outputPath are required'
          });
        }

        const exportData = await this.indexer.exportTimeSeries(
          chain,
          parseInt(startBlock),
          parseInt(endBlock),
          outputPath
        );

        res.json({
          success: true,
          data: exportData
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    // ==================== ANALYTICS ENDPOINTS ====================

    /**
     * GET /api/analytics/summary/:chain
     * Get analytics summary
     */
    this.app.get('/api/analytics/summary/:chain', (req, res) => {
      const { chain } = req.params;
      const state = this.indexer.getCurrentState(chain);

      if (!state) {
        return res.status(404).json({
          success: false,
          error: 'No data found'
        });
      }

      const summary = {
        chain,
        block: state.block,
        timestamp: state.timestamp,
        transactions: state.transactions,
        protocols: {}
      };

      // Aggregate protocol data
      for (const [protocol, data] of Object.entries(state.protocols || {})) {
        summary.protocols[protocol] = {
          volume: data.volume || data.totalVolume || 0,
          tvl: data.tvl || data.totalTVL || 0,
          transactions: data.transactions || 0
        };
      }

      res.json({
        success: true,
        data: summary
      });
    });

    /**
     * GET /api/analytics/compare
     * Compare metrics across chains
     */
    this.app.get('/api/analytics/compare', (req, res) => {
      const chains = config.indexer.chains;
      const comparison = {};

      for (const chain of chains) {
        const state = this.indexer.getCurrentState(chain);
        if (state) {
          comparison[chain] = {
            block: state.block,
            transactions: state.transactions,
            gasUsed: state.gasUsed
          };
        }
      }

      res.json({
        success: true,
        data: comparison
      });
    });

    // ==================== ATTESTATION ENDPOINTS ====================

    /**
     * POST /api/attest/feed
     * Create attestation (placeholder - would call Python service)
     */
    this.app.post('/api/attest/feed', async (req, res) => {
      try {
        const { feedName, value, source } = req.body;

        if (!feedName || value === undefined || !source) {
          return res.status(400).json({
            success: false,
            error: 'feedName, value, and source are required'
          });
        }

        // In production, this would call the Python attestation service
        const attestation = {
          feed_name: feedName,
          value,
          source,
          timestamp: Date.now(),
          signature: '0x' + '0'.repeat(128), // Placeholder
          commitment_hash: '0x' + '0'.repeat(64) // Placeholder
        };

        res.json({
          success: true,
          data: attestation,
          message: 'Attestation created (demo mode)'
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    // ==================== BATCH ENDPOINTS ====================

    /**
     * POST /api/batch/prices
     * Get multiple prices at once
     */
    this.app.post('/api/batch/prices', async (req, res) => {
      try {
        const { tokens } = req.body;

        if (!Array.isArray(tokens)) {
          return res.status(400).json({
            success: false,
            error: 'tokens must be an array'
          });
        }

        const results = await Promise.allSettled(
          tokens.map(token =>
            this.oracle.getVerifiedPrice(token.symbol, token.feedAddresses)
          )
        );

        const prices = results.map((result, i) => ({
          token: tokens[i].symbol,
          success: result.status === 'fulfilled',
          data: result.status === 'fulfilled' ? result.value : null,
          error: result.status === 'rejected' ? result.reason.message : null
        }));

        res.json({
          success: true,
          data: prices
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    // Error handler
    this.app.use((err, req, res, next) => {
      console.error('Error:', err);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: err.message
      });
    });
  }

  start() {
    this.app.listen(this.port, () => {
      console.log('');
      console.log('╔═══════════════════════════════════════════════╗');
      console.log('║   Trustless Data Infrastructure API          ║');
      console.log('╚═══════════════════════════════════════════════╝');
      console.log('');
      console.log(`🚀 Server running on port ${this.port}`);
      console.log('');
      console.log('📡 Endpoints:');
      console.log(`   Oracle:    http://localhost:${this.port}/api/oracle/*`);
      console.log(`   Indexer:   http://localhost:${this.port}/api/indexer/*`);
      console.log(`   Analytics: http://localhost:${this.port}/api/analytics/*`);
      console.log(`   Attest:    http://localhost:${this.port}/api/attest/*`);
      console.log('');
      console.log(`📊 Health:    http://localhost:${this.port}/health`);
      console.log('');
    });
  }
}

module.exports = AnalyticsAPI;

// Start server if run directly
if (require.main === module) {
  const port = process.env.PORT || 3000;
  const api = new AnalyticsAPI(port);
  api.start();
}
