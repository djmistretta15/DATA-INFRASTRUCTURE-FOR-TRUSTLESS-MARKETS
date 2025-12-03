import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import Redis from 'redis';
import { ethers } from 'ethers';
import { body, validationResult } from 'express-validator';
import crypto from 'crypto';

/**
 * Index Data Push API - Endpoints for ingesting oracle data
 * Handles price submissions, ZK proofs, and batch updates
 * 700 LoC as specified
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
  console.log('✓ Index Data Push API connected to Redis');
})();

// Authentication middleware for oracles
const authenticateOracle = async (req: Request, res: Response, next: NextFunction) => {
  const signature = req.headers['x-oracle-signature'] as string;
  const timestamp = req.headers['x-timestamp'] as string;
  const oracleAddress = req.headers['x-oracle-address'] as string;

  if (!signature || !timestamp || !oracleAddress) {
    return res.status(401).json({
      error: 'Missing authentication headers',
      required: ['x-oracle-signature', 'x-timestamp', 'x-oracle-address']
    });
  }

  // Check timestamp freshness (5 minute window)
  const timestampMs = parseInt(timestamp);
  if (Math.abs(Date.now() - timestampMs) > 5 * 60 * 1000) {
    return res.status(401).json({ error: 'Request timestamp expired' });
  }

  // Verify signature
  const message = `${timestamp}:${JSON.stringify(req.body)}`;
  try {
    const recoveredAddress = ethers.verifyMessage(message, signature);
    if (recoveredAddress.toLowerCase() !== oracleAddress.toLowerCase()) {
      return res.status(403).json({ error: 'Invalid signature' });
    }

    // Check if oracle is registered and active
    const oracle = await prisma.oracle.findFirst({
      where: {
        address: oracleAddress,
        isActive: true
      }
    });

    if (!oracle) {
      return res.status(403).json({ error: 'Oracle not registered or inactive' });
    }

    // Attach oracle to request
    (req as any).oracle = oracle;
    next();
  } catch (error) {
    return res.status(403).json({ error: 'Signature verification failed' });
  }
};

// Validation middleware
const validate = (req: Request, res: Response, next: NextFunction) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  next();
};

// Rate limiting per oracle
const oracleRateLimit = async (req: Request, res: Response, next: NextFunction) => {
  const oracle = (req as any).oracle;
  const key = `rate_limit:oracle:${oracle.id}`;

  const current = await redis.incr(key);
  if (current === 1) {
    await redis.expire(key, 60); // 1 minute window
  }

  const maxRequests = 100; // 100 submissions per minute
  if (current > maxRequests) {
    return res.status(429).json({
      error: 'Rate limit exceeded',
      retryAfter: await redis.ttl(key)
    });
  }

  next();
};

/**
 * POST /api/index/price
 * Submit single price feed update
 */
router.post(
  '/price',
  [
    body('tokenId').isString().notEmpty(),
    body('price').isString().notEmpty(),
    body('timestamp').isInt(),
    body('sources').isArray({ min: 1 }),
    body('zkProof').optional().isObject()
  ],
  validate,
  authenticateOracle,
  oracleRateLimit,
  async (req: Request, res: Response) => {
    try {
      const oracle = (req as any).oracle;
      const { tokenId, price, timestamp, sources, zkProof } = req.body;

      // Validate price format
      let priceValue: bigint;
      try {
        priceValue = BigInt(price);
        if (priceValue <= 0n) {
          throw new Error('Price must be positive');
        }
      } catch {
        return res.status(400).json({ error: 'Invalid price format' });
      }

      // Check for deviation from current price
      const currentPrice = await prisma.priceFeed.findFirst({
        where: { tokenId },
        orderBy: { timestamp: 'desc' }
      });

      let accepted = true;
      let deviationPercent = 0;

      if (currentPrice) {
        const currentValue = BigInt(currentPrice.price.toString());
        const deviation = priceValue > currentValue
          ? priceValue - currentValue
          : currentValue - priceValue;
        deviationPercent = Number((deviation * 10000n) / currentValue) / 100;

        // Reject if deviation > 10%
        if (deviationPercent > 10) {
          accepted = false;
        }
      }

      // Verify ZK proof if provided
      let zkVerified = false;
      if (zkProof) {
        zkVerified = await verifyZKProof(zkProof, tokenId, price, timestamp);
      }

      // Store submission
      const submission = await prisma.oracleSubmission.create({
        data: {
          oracleId: oracle.id,
          tokenId,
          price: price,
          timestamp: new Date(timestamp),
          accepted,
          deviationPercent,
          zkVerified,
          sources: JSON.stringify(sources)
        }
      });

      // If accepted, update aggregated price
      if (accepted) {
        await updateAggregatedPrice(tokenId, priceValue, sources);

        // Publish to Redis for real-time subscribers
        await redis.publish('price:update', JSON.stringify({
          tokenId,
          price: price,
          oracle: oracle.address,
          timestamp,
          zkVerified
        }));

        // Cache latest price
        await redis.setEx(
          `latest_price:${tokenId}`,
          300,
          JSON.stringify({
            price: price,
            timestamp: Date.now(),
            oracleId: oracle.id
          })
        );
      }

      // Update oracle reputation
      await updateOracleReputation(oracle.id, accepted, deviationPercent);

      res.status(201).json({
        success: true,
        submissionId: submission.id,
        accepted,
        deviationPercent,
        zkVerified,
        timestamp: new Date()
      });
    } catch (error) {
      console.error('Price submission error:', error);
      res.status(500).json({ error: 'Failed to process submission' });
    }
  }
);

/**
 * POST /api/index/price/batch
 * Submit multiple price updates in batch
 */
router.post(
  '/price/batch',
  [
    body('submissions').isArray({ min: 1, max: 100 }),
    body('submissions.*.tokenId').isString().notEmpty(),
    body('submissions.*.price').isString().notEmpty(),
    body('submissions.*.timestamp').isInt()
  ],
  validate,
  authenticateOracle,
  oracleRateLimit,
  async (req: Request, res: Response) => {
    try {
      const oracle = (req as any).oracle;
      const { submissions } = req.body;

      const results = [];
      let successCount = 0;
      let failCount = 0;

      // Process submissions in transaction
      await prisma.$transaction(async (tx) => {
        for (const sub of submissions) {
          try {
            const priceValue = BigInt(sub.price);

            // Check deviation
            const current = await tx.priceFeed.findFirst({
              where: { tokenId: sub.tokenId },
              orderBy: { timestamp: 'desc' }
            });

            let accepted = true;
            if (current) {
              const currentValue = BigInt(current.price.toString());
              const deviation = priceValue > currentValue
                ? priceValue - currentValue
                : currentValue - priceValue;
              const deviationPercent = Number((deviation * 10000n) / currentValue) / 100;
              accepted = deviationPercent <= 10;
            }

            // Store submission
            const submission = await tx.oracleSubmission.create({
              data: {
                oracleId: oracle.id,
                tokenId: sub.tokenId,
                price: sub.price,
                timestamp: new Date(sub.timestamp),
                accepted,
                sources: JSON.stringify(sub.sources || [])
              }
            });

            results.push({
              tokenId: sub.tokenId,
              submissionId: submission.id,
              accepted,
              success: true
            });

            if (accepted) {
              successCount++;
            }
          } catch (error) {
            failCount++;
            results.push({
              tokenId: sub.tokenId,
              success: false,
              error: (error as Error).message
            });
          }
        }
      });

      res.status(201).json({
        success: true,
        total: submissions.length,
        accepted: successCount,
        rejected: submissions.length - successCount - failCount,
        failed: failCount,
        results
      });
    } catch (error) {
      console.error('Batch submission error:', error);
      res.status(500).json({ error: 'Batch processing failed' });
    }
  }
);

/**
 * POST /api/index/zkproof
 * Submit ZK proof for timestamp verification
 */
router.post(
  '/zkproof',
  [
    body('commitment').isString().notEmpty(),
    body('proof').isArray(),
    body('dataHash').isString().notEmpty(),
    body('timestamp').isInt(),
    body('nonce').isString().notEmpty()
  ],
  validate,
  authenticateOracle,
  async (req: Request, res: Response) => {
    try {
      const oracle = (req as any).oracle;
      const { commitment, proof, dataHash, timestamp, nonce } = req.body;

      // Verify commitment
      const expectedCommitment = crypto
        .createHash('sha256')
        .update(`${dataHash}:${timestamp}:${nonce}`)
        .digest('hex');

      if (commitment !== expectedCommitment) {
        return res.status(400).json({ error: 'Invalid commitment' });
      }

      // Verify proof elements
      const proofValid = await verifyZKProof({ proof, dataHash, timestamp }, '', '', 0);

      // Store proof verification
      const verification = await prisma.zkVerification.create({
        data: {
          oracleId: oracle.id,
          commitment,
          dataHash,
          timestamp: new Date(timestamp),
          nonce,
          verified: proofValid,
          verifiedAt: new Date()
        }
      });

      // Publish verification
      await redis.publish('zk:verified', JSON.stringify({
        verificationId: verification.id,
        oracle: oracle.address,
        commitment,
        verified: proofValid,
        timestamp: Date.now()
      }));

      res.status(201).json({
        success: true,
        verificationId: verification.id,
        verified: proofValid,
        commitment,
        timestamp: new Date()
      });
    } catch (error) {
      console.error('ZK proof submission error:', error);
      res.status(500).json({ error: 'ZK proof verification failed' });
    }
  }
);

/**
 * POST /api/index/token
 * Register new token for indexing
 */
router.post(
  '/token',
  [
    body('address').isString().notEmpty(),
    body('chain').isString().notEmpty(),
    body('symbol').isString().notEmpty(),
    body('name').isString().notEmpty(),
    body('decimals').isInt({ min: 0, max: 18 })
  ],
  validate,
  authenticateOracle,
  async (req: Request, res: Response) => {
    try {
      const { address, chain, symbol, name, decimals } = req.body;

      // Check if token already exists
      const existing = await prisma.token.findUnique({
        where: { address_chain: { address, chain } }
      });

      if (existing) {
        return res.status(409).json({
          error: 'Token already registered',
          tokenId: existing.id
        });
      }

      // Create token
      const token = await prisma.token.create({
        data: {
          address,
          chain,
          symbol,
          name,
          decimals,
          totalSupply: '0',
          holderCount: 0,
          lastUpdated: new Date()
        }
      });

      // Publish token registration
      await redis.publish('token:registered', JSON.stringify({
        tokenId: token.id,
        address,
        chain,
        symbol,
        timestamp: Date.now()
      }));

      res.status(201).json({
        success: true,
        tokenId: token.id,
        address,
        chain,
        symbol,
        timestamp: new Date()
      });
    } catch (error) {
      console.error('Token registration error:', error);
      res.status(500).json({ error: 'Token registration failed' });
    }
  }
);

/**
 * POST /api/index/pool
 * Update liquidity pool data
 */
router.post(
  '/pool',
  [
    body('address').isString().notEmpty(),
    body('chain').isString().notEmpty(),
    body('token0').isString().notEmpty(),
    body('token1').isString().notEmpty(),
    body('reserve0').isString().notEmpty(),
    body('reserve1').isString().notEmpty(),
    body('fee').isInt()
  ],
  validate,
  authenticateOracle,
  async (req: Request, res: Response) => {
    try {
      const { address, chain, token0, token1, reserve0, reserve1, fee } = req.body;

      // Upsert pool data
      const pool = await prisma.liquidityPool.upsert({
        where: { address },
        update: {
          reserve0,
          reserve1,
          lastUpdated: new Date()
        },
        create: {
          address,
          chain,
          dex: 'uniswap_v3',
          token0Address: token0,
          token1Address: token1,
          fee: fee.toString(),
          reserve0,
          reserve1,
          totalValueLocked: '0',
          volume24h: '0',
          fees24h: '0',
          apy: '0',
          lastUpdated: new Date()
        }
      });

      // Calculate TVL
      const tvl = await calculatePoolTVL(reserve0, reserve1, token0, token1);
      await prisma.liquidityPool.update({
        where: { address },
        data: { totalValueLocked: tvl }
      });

      // Publish pool update
      await redis.publish('pool:update', JSON.stringify({
        poolAddress: address,
        reserve0,
        reserve1,
        tvl,
        timestamp: Date.now()
      }));

      res.status(200).json({
        success: true,
        poolId: pool.id,
        address,
        tvl,
        timestamp: new Date()
      });
    } catch (error) {
      console.error('Pool update error:', error);
      res.status(500).json({ error: 'Pool update failed' });
    }
  }
);

/**
 * POST /api/index/anomaly
 * Report detected anomaly
 */
router.post(
  '/anomaly',
  [
    body('feedName').isString().notEmpty(),
    body('anomalyScore').isFloat({ min: 0, max: 1 }),
    body('severity').isIn(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
    body('description').isString().notEmpty()
  ],
  validate,
  authenticateOracle,
  async (req: Request, res: Response) => {
    try {
      const { feedName, anomalyScore, severity, description, evidence } = req.body;

      // Store anomaly detection
      const anomaly = await prisma.anomalyDetection.create({
        data: {
          feedName,
          anomalyScore: anomalyScore.toString(),
          severity,
          description,
          evidence: evidence ? JSON.stringify(evidence) : null,
          timestamp: new Date(),
          isAcknowledged: false
        }
      });

      // Publish anomaly alert
      await redis.publish('anomaly:detected', JSON.stringify({
        anomalyId: anomaly.id,
        feedName,
        anomalyScore,
        severity,
        description,
        timestamp: Date.now()
      }));

      // Critical anomalies trigger circuit breaker
      if (severity === 'CRITICAL' && anomalyScore > 0.9) {
        await redis.set(`circuit_breaker:${feedName}`, JSON.stringify({
          active: true,
          reason: description,
          timestamp: Date.now()
        }));

        await redis.publish('circuit_breaker:activated', JSON.stringify({
          feedName,
          reason: 'Critical anomaly detected',
          anomalyId: anomaly.id
        }));
      }

      res.status(201).json({
        success: true,
        anomalyId: anomaly.id,
        severity,
        circuitBreakerActivated: severity === 'CRITICAL' && anomalyScore > 0.9,
        timestamp: new Date()
      });
    } catch (error) {
      console.error('Anomaly report error:', error);
      res.status(500).json({ error: 'Anomaly report failed' });
    }
  }
);

// Helper functions

async function verifyZKProof(
  proof: any,
  _tokenId: string,
  _price: string,
  _timestamp: number
): Promise<boolean> {
  // In production, this would verify actual ZK-STARK proofs
  // For now, basic validation
  if (!proof || !proof.proof || !Array.isArray(proof.proof)) {
    return false;
  }

  // Check proof has minimum elements
  if (proof.proof.length < 10) {
    return false;
  }

  // Verify each proof element is valid hex
  for (const element of proof.proof) {
    if (typeof element !== 'string' || !element.match(/^0x[a-fA-F0-9]{64}$/)) {
      return false;
    }
  }

  return true;
}

async function updateAggregatedPrice(
  tokenId: string,
  newPrice: bigint,
  sources: string[]
): Promise<void> {
  // Get recent prices for aggregation
  const recentPrices = await prisma.oracleSubmission.findMany({
    where: {
      tokenId,
      accepted: true,
      timestamp: { gte: new Date(Date.now() - 5 * 60 * 1000) } // Last 5 minutes
    },
    orderBy: { timestamp: 'desc' },
    take: 10
  });

  if (recentPrices.length === 0) {
    // First price for this token
    await prisma.priceFeed.create({
      data: {
        tokenId,
        price: newPrice.toString(),
        median: newPrice.toString(),
        stdDev: '0',
        sources,
        timestamp: new Date()
      }
    });
    return;
  }

  // Calculate median
  const prices = recentPrices.map(p => BigInt(p.price.toString()));
  prices.push(newPrice);
  prices.sort((a, b) => (a < b ? -1 : 1));

  const median = prices[Math.floor(prices.length / 2)];

  // Calculate standard deviation
  const mean = prices.reduce((a, b) => a + b, 0n) / BigInt(prices.length);
  const squaredDiffs = prices.map(p => (p - mean) * (p - mean));
  const variance = squaredDiffs.reduce((a, b) => a + b, 0n) / BigInt(prices.length);
  const stdDev = BigInt(Math.floor(Math.sqrt(Number(variance))));

  // Store aggregated price
  await prisma.priceFeed.create({
    data: {
      tokenId,
      price: newPrice.toString(),
      median: median.toString(),
      stdDev: stdDev.toString(),
      sources,
      timestamp: new Date()
    }
  });
}

async function updateOracleReputation(
  oracleId: string,
  accepted: boolean,
  deviationPercent: number
): Promise<void> {
  const oracle = await prisma.oracle.findUnique({ where: { id: oracleId } });
  if (!oracle) return;

  let reputationChange = 0;

  if (accepted) {
    // Reward for accepted submission
    reputationChange = 0.001;
    // Extra reward for low deviation
    if (deviationPercent < 1) {
      reputationChange += 0.001;
    }
  } else {
    // Penalty for rejected submission
    reputationChange = -0.01;
    // Extra penalty for high deviation
    if (deviationPercent > 20) {
      reputationChange -= 0.02;
    }
  }

  const currentRep = parseFloat(oracle.reputation.toString());
  const newRep = Math.max(0, Math.min(1, currentRep + reputationChange));

  await prisma.oracle.update({
    where: { id: oracleId },
    data: { reputation: newRep.toString() }
  });
}

async function calculatePoolTVL(
  reserve0: string,
  reserve1: string,
  token0: string,
  token1: string
): Promise<string> {
  // In production, fetch token prices and calculate USD value
  // Simplified version
  const r0 = BigInt(reserve0);
  const r1 = BigInt(reserve1);

  // Assume both tokens worth $1 for simplicity
  const tvl = r0 + r1;

  return tvl.toString();
}

export default router;
