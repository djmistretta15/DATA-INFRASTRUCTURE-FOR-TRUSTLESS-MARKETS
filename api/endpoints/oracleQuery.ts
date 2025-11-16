import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';
import Redis from 'redis';
import { ethers } from 'ethers';
import rateLimit from 'express-rate-limit';
import { body, query, validationResult } from 'express-validator';

/**
 * Oracle Query API Endpoints
 * RESTful API for querying oracle data
 * 800 LoC as specified
 */

const router = Router();
const prisma = new PrismaClient();
let redis: any;

// Initialize Redis
(async () => {
  redis = Redis.createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379'
  });
  await redis.connect();
})();

// Rate limiting
const queryLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  message: { error: 'Rate limit exceeded', retryAfter: 60 }
});

// Authentication middleware
const authenticate = (req: Request, res: Response, next: NextFunction) => {
  const apiKey = req.headers['x-api-key'] as string;

  if (!apiKey) {
    return res.status(401).json({ error: 'API key required' });
  }

  // Validate API key (in production, check database)
  if (!apiKey.startsWith('roc_')) {
    return res.status(403).json({ error: 'Invalid API key' });
  }

  next();
};

// Validation middleware
const validate = (req: Request, res: Response, next: NextFunction) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  next();
};

// Cache middleware
const cacheResponse = (ttl: number = 60) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    const cacheKey = `api:${req.originalUrl}`;

    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        res.setHeader('X-Cache', 'HIT');
        return res.json(JSON.parse(cached));
      }
    } catch (error) {
      console.error('Cache error:', error);
    }

    // Store original json method
    const originalJson = res.json.bind(res);

    res.json = (data: any) => {
      res.setHeader('X-Cache', 'MISS');

      // Cache the response
      redis.setEx(cacheKey, ttl, JSON.stringify(data)).catch(console.error);

      return originalJson(data);
    };

    next();
  };
};

/**
 * GET /api/oracle/price/:tokenId
 * Get latest price for a token
 */
router.get(
  '/price/:tokenId',
  queryLimiter,
  cacheResponse(30),
  async (req: Request, res: Response) => {
    try {
      const { tokenId } = req.params;

      // Check Redis for real-time price
      const cached = await redis.get(`latest_price:${tokenId}`);
      if (cached) {
        return res.json(JSON.parse(cached));
      }

      const price = await prisma.priceFeed.findFirst({
        where: { tokenId },
        orderBy: { timestamp: 'desc' }
      });

      if (!price) {
        return res.status(404).json({ error: 'Price feed not found' });
      }

      res.json({
        tokenId,
        price: price.price.toString(),
        median: price.median.toString(),
        stdDev: price.stdDev?.toString(),
        timestamp: price.timestamp,
        sources: price.sources,
        confidence: calculateConfidence(price)
      });
    } catch (error) {
      console.error('Error fetching price:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * GET /api/oracle/price/:tokenId/history
 * Get historical price data
 */
router.get(
  '/price/:tokenId/history',
  queryLimiter,
  [
    query('interval').optional().isIn(['1m', '5m', '15m', '1h', '4h', '1d']),
    query('from').optional().isISO8601(),
    query('to').optional().isISO8601(),
    query('limit').optional().isInt({ min: 1, max: 1000 })
  ],
  validate,
  cacheResponse(300),
  async (req: Request, res: Response) => {
    try {
      const { tokenId } = req.params;
      const {
        interval = '1h',
        from = new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
        to = new Date().toISOString(),
        limit = 100
      } = req.query;

      const intervalMap: Record<string, string> = {
        '1m': '1 minute',
        '5m': '5 minutes',
        '15m': '15 minutes',
        '1h': '1 hour',
        '4h': '4 hours',
        '1d': '1 day'
      };

      const bucket = intervalMap[interval as string] || '1 hour';

      const history = await prisma.$queryRaw<any[]>`
        SELECT
          time_bucket(${bucket}::interval, timestamp) AS time,
          first(price::numeric, timestamp) AS open,
          max(price::numeric) AS high,
          min(price::numeric) AS low,
          last(price::numeric, timestamp) AS close,
          avg(price::numeric) AS vwap,
          avg("stdDev"::numeric) AS avg_std_dev,
          count(*) AS data_points
        FROM "PriceFeed"
        WHERE "tokenId" = ${tokenId}
          AND timestamp BETWEEN ${from}::timestamp AND ${to}::timestamp
        GROUP BY time_bucket(${bucket}::interval, timestamp)
        ORDER BY time DESC
        LIMIT ${parseInt(limit as string)}
      `;

      res.json({
        tokenId,
        interval,
        from,
        to,
        count: history.length,
        data: history.map(h => ({
          timestamp: h.time,
          open: h.open?.toString(),
          high: h.high?.toString(),
          low: h.low?.toString(),
          close: h.close?.toString(),
          vwap: h.vwap?.toString(),
          avgStdDev: h.avg_std_dev?.toString(),
          dataPoints: parseInt(h.data_points)
        }))
      });
    } catch (error) {
      console.error('Error fetching history:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * GET /api/oracle/prices
 * Get multiple prices at once
 */
router.get(
  '/prices',
  queryLimiter,
  [
    query('tokenIds').isString().notEmpty()
  ],
  validate,
  cacheResponse(30),
  async (req: Request, res: Response) => {
    try {
      const tokenIds = (req.query.tokenIds as string).split(',');

      if (tokenIds.length > 50) {
        return res.status(400).json({ error: 'Maximum 50 tokens per request' });
      }

      const prices = await Promise.all(
        tokenIds.map(async (tokenId) => {
          const price = await prisma.priceFeed.findFirst({
            where: { tokenId },
            orderBy: { timestamp: 'desc' }
          });

          return {
            tokenId,
            price: price?.price.toString() || null,
            timestamp: price?.timestamp || null,
            available: !!price
          };
        })
      );

      res.json({
        count: prices.length,
        data: prices
      });
    } catch (error) {
      console.error('Error fetching prices:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * GET /api/oracle/oracles
 * List all oracles
 */
router.get(
  '/oracles',
  queryLimiter,
  [
    query('isActive').optional().isBoolean(),
    query('minReputation').optional().isFloat({ min: 0, max: 1 }),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 })
  ],
  validate,
  cacheResponse(120),
  async (req: Request, res: Response) => {
    try {
      const {
        isActive,
        minReputation,
        page = '1',
        limit = '20'
      } = req.query;

      const where: any = {};

      if (isActive !== undefined) {
        where.isActive = isActive === 'true';
      }

      if (minReputation) {
        where.reputation = { gte: parseFloat(minReputation as string) };
      }

      const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
      const take = parseInt(limit as string);

      const [oracles, total] = await Promise.all([
        prisma.oracle.findMany({
          where,
          skip,
          take,
          orderBy: { reputation: 'desc' }
        }),
        prisma.oracle.count({ where })
      ]);

      res.json({
        data: oracles.map(o => ({
          id: o.id,
          address: o.address,
          name: o.name,
          stakeAmount: o.stakeAmount.toString(),
          reputation: o.reputation.toString(),
          isActive: o.isActive,
          registeredAt: o.registeredAt
        })),
        pagination: {
          page: parseInt(page as string),
          limit: take,
          total,
          totalPages: Math.ceil(total / take)
        }
      });
    } catch (error) {
      console.error('Error fetching oracles:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * GET /api/oracle/:oracleId
 * Get specific oracle details
 */
router.get(
  '/:oracleId',
  queryLimiter,
  cacheResponse(60),
  async (req: Request, res: Response) => {
    try {
      const { oracleId } = req.params;

      const oracle = await prisma.oracle.findUnique({
        where: { id: oracleId },
        include: {
          submissions: {
            take: 20,
            orderBy: { timestamp: 'desc' }
          },
          slashingEvents: {
            take: 10,
            orderBy: { timestamp: 'desc' }
          }
        }
      });

      if (!oracle) {
        return res.status(404).json({ error: 'Oracle not found' });
      }

      res.json({
        id: oracle.id,
        address: oracle.address,
        name: oracle.name,
        stakeAmount: oracle.stakeAmount.toString(),
        reputation: oracle.reputation.toString(),
        isActive: oracle.isActive,
        registeredAt: oracle.registeredAt,
        recentSubmissions: oracle.submissions.map(s => ({
          tokenId: s.tokenId,
          price: s.price.toString(),
          timestamp: s.timestamp,
          accepted: s.accepted
        })),
        slashingHistory: oracle.slashingEvents.map(e => ({
          amount: e.amount.toString(),
          reason: e.reason,
          timestamp: e.timestamp
        }))
      });
    } catch (error) {
      console.error('Error fetching oracle:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * GET /api/oracle/statistics
 * Get oracle network statistics
 */
router.get(
  '/statistics',
  queryLimiter,
  cacheResponse(300),
  async (_req: Request, res: Response) => {
    try {
      const [
        totalOracles,
        activeOracles,
        totalSubmissions,
        totalSlashings,
        avgReputation
      ] = await Promise.all([
        prisma.oracle.count(),
        prisma.oracle.count({ where: { isActive: true } }),
        prisma.oracleSubmission.count(),
        prisma.slashingEvent.count(),
        prisma.oracle.aggregate({
          _avg: { reputation: true }
        })
      ]);

      // Recent activity
      const recentSubmissions = await prisma.oracleSubmission.count({
        where: {
          timestamp: { gte: new Date(Date.now() - 24 * 3600 * 1000) }
        }
      });

      res.json({
        totalOracles,
        activeOracles,
        inactiveOracles: totalOracles - activeOracles,
        totalSubmissions,
        submissionsLast24h: recentSubmissions,
        totalSlashings,
        averageReputation: avgReputation._avg.reputation?.toString() || '0',
        timestamp: new Date()
      });
    } catch (error) {
      console.error('Error fetching statistics:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * GET /api/oracle/anomalies
 * Get detected anomalies
 */
router.get(
  '/anomalies',
  queryLimiter,
  [
    query('feedName').optional().isString(),
    query('minScore').optional().isFloat({ min: 0, max: 1 }),
    query('from').optional().isISO8601(),
    query('to').optional().isISO8601(),
    query('limit').optional().isInt({ min: 1, max: 100 })
  ],
  validate,
  cacheResponse(60),
  async (req: Request, res: Response) => {
    try {
      const {
        feedName,
        minScore,
        from,
        to,
        limit = '20'
      } = req.query;

      const where: any = {};

      if (feedName) where.feedName = feedName;
      if (minScore) where.anomalyScore = { gte: parseFloat(minScore as string) };
      if (from || to) {
        where.timestamp = {};
        if (from) where.timestamp.gte = new Date(from as string);
        if (to) where.timestamp.lte = new Date(to as string);
      }

      const anomalies = await prisma.anomalyDetection.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        take: parseInt(limit as string)
      });

      res.json({
        count: anomalies.length,
        data: anomalies.map(a => ({
          id: a.id,
          feedName: a.feedName,
          anomalyScore: a.anomalyScore.toString(),
          severity: a.severity,
          description: a.description,
          timestamp: a.timestamp,
          isAcknowledged: a.isAcknowledged
        }))
      });
    } catch (error) {
      console.error('Error fetching anomalies:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * GET /api/oracle/health
 * Health check endpoint
 */
router.get('/health', async (_req: Request, res: Response) => {
  try {
    // Check database connection
    await prisma.$queryRaw`SELECT 1`;

    // Check Redis connection
    await redis.ping();

    res.json({
      status: 'healthy',
      database: 'connected',
      cache: 'connected',
      timestamp: new Date()
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      error: (error as Error).message,
      timestamp: new Date()
    });
  }
});

/**
 * POST /api/oracle/verify
 * Verify oracle data integrity
 */
router.post(
  '/verify',
  authenticate,
  [
    body('tokenId').isString().notEmpty(),
    body('price').isString().notEmpty(),
    body('timestamp').isISO8601(),
    body('signature').isString().notEmpty()
  ],
  validate,
  async (req: Request, res: Response) => {
    try {
      const { tokenId, price, timestamp, signature } = req.body;

      // Verify signature
      const message = `${tokenId}:${price}:${timestamp}`;
      const recoveredAddress = ethers.verifyMessage(message, signature);

      // Check if address is registered oracle
      const oracle = await prisma.oracle.findFirst({
        where: { address: recoveredAddress, isActive: true }
      });

      if (!oracle) {
        return res.status(400).json({
          valid: false,
          error: 'Invalid oracle signature'
        });
      }

      // Verify price is within acceptable range
      const latestPrice = await prisma.priceFeed.findFirst({
        where: { tokenId },
        orderBy: { timestamp: 'desc' }
      });

      let priceWithinRange = true;
      let deviation = 0;

      if (latestPrice) {
        const submittedPrice = BigInt(price);
        const currentPrice = BigInt(latestPrice.price.toString());
        deviation = Math.abs(
          Number((submittedPrice - currentPrice) * 10000n / currentPrice)
        ) / 100;
        priceWithinRange = deviation <= 5; // 5% max deviation
      }

      res.json({
        valid: true,
        oracle: {
          address: recoveredAddress,
          name: oracle.name,
          reputation: oracle.reputation.toString()
        },
        priceVerification: {
          withinRange: priceWithinRange,
          deviation: `${deviation.toFixed(2)}%`
        },
        timestamp: new Date()
      });
    } catch (error) {
      console.error('Verification error:', error);
      res.status(500).json({ error: 'Verification failed' });
    }
  }
);

// Helper function to calculate price confidence
function calculateConfidence(price: any): number {
  // Based on number of sources and stdDev
  const sourceCount = price.sources?.length || 1;
  const stdDev = parseFloat(price.stdDev?.toString() || '0');
  const priceValue = parseFloat(price.price.toString());

  const coefficientOfVariation = stdDev / priceValue;
  const sourceScore = Math.min(sourceCount / 10, 1);
  const variationScore = Math.max(0, 1 - coefficientOfVariation * 10);

  return sourceScore * 0.4 + variationScore * 0.6;
}

export default router;
