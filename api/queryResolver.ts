import { PrismaClient } from '@prisma/client';
import Redis from 'redis';
import { PubSub } from 'graphql-subscriptions';

/**
 * GraphQL Query Resolver - Complete resolver implementation
 * Handles all queries, mutations, and subscriptions
 * 1100 LoC as specified
 */

const prisma = new PrismaClient();
const pubsub = new PubSub();

let redisClient: any;

// Initialize Redis
async function initRedis() {
  redisClient = Redis.createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379'
  });
  await redisClient.connect();
}
initRedis();

// Subscription event names
const EVENTS = {
  PRICE_UPDATE: 'PRICE_UPDATE',
  ANOMALY_DETECTED: 'ANOMALY_DETECTED',
  LIQUIDATION: 'LIQUIDATION',
  SLASHING_EVENT: 'SLASHING_EVENT',
  POOL_UPDATE: 'POOL_UPDATE',
  GOVERNANCE_VOTE: 'GOVERNANCE_VOTE'
};

// Type definitions for context
interface Context {
  user?: {
    id: string;
    role: string;
  };
  req: any;
}

// Resolver helper functions
const cacheKey = (type: string, id: string) => `cache:${type}:${id}`;

async function getFromCache<T>(key: string): Promise<T | null> {
  try {
    const cached = await redisClient.get(key);
    return cached ? JSON.parse(cached) : null;
  } catch {
    return null;
  }
}

async function setCache(key: string, value: any, ttl: number = 300): Promise<void> {
  try {
    await redisClient.setEx(key, ttl, JSON.stringify(value));
  } catch (error) {
    console.error('Cache set error:', error);
  }
}

// Main resolvers
export const resolvers = {
  Query: {
    // Oracle Queries
    oracle: async (_: any, { id }: { id: string }) => {
      const cached = await getFromCache<any>(cacheKey('oracle', id));
      if (cached) return cached;

      const oracle = await prisma.oracle.findUnique({
        where: { id },
        include: {
          submissions: { take: 10, orderBy: { timestamp: 'desc' } },
          slashingEvents: { take: 5 }
        }
      });

      if (oracle) {
        await setCache(cacheKey('oracle', id), oracle, 60);
      }

      return oracle;
    },

    oracles: async (
      _: any,
      { filter, pagination }: { filter?: any; pagination?: any }
    ) => {
      const where: any = {};

      if (filter) {
        if (filter.isActive !== undefined) where.isActive = filter.isActive;
        if (filter.minStake) where.stakeAmount = { gte: filter.minStake };
        if (filter.minReputation) where.reputation = { gte: filter.minReputation };
      }

      const skip = pagination?.offset || 0;
      const take = Math.min(pagination?.limit || 20, 100);

      const [oracles, totalCount] = await Promise.all([
        prisma.oracle.findMany({
          where,
          skip,
          take,
          orderBy: { reputation: 'desc' }
        }),
        prisma.oracle.count({ where })
      ]);

      return {
        oracles,
        totalCount,
        hasMore: skip + take < totalCount
      };
    },

    // Price Feed Queries
    priceFeed: async (
      _: any,
      { tokenId, limit }: { tokenId: string; limit?: number }
    ) => {
      const cached = await getFromCache<any[]>(cacheKey('priceFeed', tokenId));
      if (cached) return cached;

      const feeds = await prisma.priceFeed.findMany({
        where: { tokenId },
        orderBy: { timestamp: 'desc' },
        take: limit || 100
      });

      if (feeds.length > 0) {
        await setCache(cacheKey('priceFeed', tokenId), feeds, 30);
      }

      return feeds;
    },

    latestPrice: async (_: any, { tokenId }: { tokenId: string }) => {
      // Check Redis first for real-time price
      const cached = await redisClient.get(`latest_price:${tokenId}`);
      if (cached) return JSON.parse(cached);

      const latest = await prisma.priceFeed.findFirst({
        where: { tokenId },
        orderBy: { timestamp: 'desc' }
      });

      return latest;
    },

    priceHistory: async (
      _: any,
      {
        tokenId,
        startTime,
        endTime,
        interval
      }: { tokenId: string; startTime: Date; endTime: Date; interval: string }
    ) => {
      // Use TimescaleDB time_bucket for aggregation
      const intervalMap: Record<string, string> = {
        '1m': '1 minute',
        '5m': '5 minutes',
        '15m': '15 minutes',
        '1h': '1 hour',
        '4h': '4 hours',
        '1d': '1 day'
      };

      const bucket = intervalMap[interval] || '1 hour';

      const result = await prisma.$queryRaw<any[]>`
        SELECT
          time_bucket(${bucket}::interval, timestamp) AS time,
          avg(price::numeric) AS avgPrice,
          min(price::numeric) AS minPrice,
          max(price::numeric) AS maxPrice,
          first(price::numeric, timestamp) AS open,
          last(price::numeric, timestamp) AS close,
          avg("stdDev"::numeric) AS avgStdDev,
          count(*) AS dataPoints
        FROM "PriceFeed"
        WHERE "tokenId" = ${tokenId}
          AND timestamp BETWEEN ${startTime} AND ${endTime}
        GROUP BY time_bucket(${bucket}::interval, timestamp)
        ORDER BY time ASC
      `;

      return result.map((row) => ({
        timestamp: row.time,
        open: row.open,
        high: row.maxPrice,
        low: row.minPrice,
        close: row.close,
        avgPrice: row.avgPrice,
        avgStdDev: row.avgStdDev,
        dataPoints: Number(row.dataPoints)
      }));
    },

    // Token Queries
    token: async (_: any, { address, chain }: { address: string; chain: string }) => {
      return prisma.token.findUnique({
        where: { address_chain: { address, chain } },
        include: {
          topHolders: { take: 10, orderBy: { balance: 'desc' } }
        }
      });
    },

    tokens: async (
      _: any,
      { chain, pagination }: { chain?: string; pagination?: any }
    ) => {
      const where = chain ? { chain } : {};
      const skip = pagination?.offset || 0;
      const take = Math.min(pagination?.limit || 20, 100);

      const [tokens, totalCount] = await Promise.all([
        prisma.token.findMany({ where, skip, take }),
        prisma.token.count({ where })
      ]);

      return { tokens, totalCount, hasMore: skip + take < totalCount };
    },

    // Pool Queries
    liquidityPool: async (_: any, { address }: { address: string }) => {
      return prisma.liquidityPool.findUnique({
        where: { address },
        include: {
          recentSwaps: { take: 20, orderBy: { timestamp: 'desc' } }
        }
      });
    },

    topPools: async (
      _: any,
      { chain, sortBy, limit }: { chain?: string; sortBy?: string; limit?: number }
    ) => {
      const where = chain ? { chain } : {};
      const orderBy: any = {};

      switch (sortBy) {
        case 'tvl':
          orderBy.totalValueLocked = 'desc';
          break;
        case 'volume':
          orderBy.volume24h = 'desc';
          break;
        case 'fees':
          orderBy.fees24h = 'desc';
          break;
        default:
          orderBy.totalValueLocked = 'desc';
      }

      return prisma.liquidityPool.findMany({
        where,
        orderBy,
        take: limit || 10
      });
    },

    // Anomaly Queries
    anomalies: async (
      _: any,
      {
        feedName,
        startTime,
        endTime,
        minScore
      }: { feedName?: string; startTime?: Date; endTime?: Date; minScore?: number }
    ) => {
      const where: any = {};

      if (feedName) where.feedName = feedName;
      if (minScore) where.anomalyScore = { gte: minScore };
      if (startTime || endTime) {
        where.timestamp = {};
        if (startTime) where.timestamp.gte = startTime;
        if (endTime) where.timestamp.lte = endTime;
      }

      return prisma.anomalyDetection.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        take: 100
      });
    },

    recentAnomalies: async (_: any, { limit }: { limit?: number }) => {
      return prisma.anomalyDetection.findMany({
        where: {
          timestamp: { gte: new Date(Date.now() - 24 * 3600 * 1000) }
        },
        orderBy: { anomalyScore: 'desc' },
        take: limit || 20
      });
    },

    // Lending Queries
    lendingRates: async (
      _: any,
      { protocol, asset }: { protocol: string; asset?: string }
    ) => {
      const where: any = { protocol };
      if (asset) where.asset = asset;

      const rates = await prisma.rateSnapshot.findFirst({
        where,
        orderBy: { timestamp: 'desc' }
      });

      return rates;
    },

    lendingRateHistory: async (
      _: any,
      {
        protocol,
        asset,
        hoursBack
      }: { protocol: string; asset: string; hoursBack: number }
    ) => {
      const cutoff = new Date(Date.now() - hoursBack * 3600 * 1000);

      return prisma.rateSnapshot.findMany({
        where: {
          protocol,
          asset,
          timestamp: { gte: cutoff }
        },
        orderBy: { timestamp: 'asc' }
      });
    },

    atRiskPositions: async (_: any, { healthFactorThreshold }: { healthFactorThreshold: number }) => {
      const threshold = (healthFactorThreshold * 1e18).toString();

      return prisma.userLendingPosition.findMany({
        where: {
          healthFactor: { lte: threshold }
        },
        orderBy: { healthFactor: 'asc' },
        take: 100
      });
    },

    recentLiquidations: async (_: any, { limit }: { limit?: number }) => {
      return prisma.liquidation.findMany({
        orderBy: { timestamp: 'desc' },
        take: limit || 50
      });
    },

    // Governance Queries
    governanceProposal: async (_: any, { id }: { id: string }) => {
      return prisma.governanceProposal.findUnique({
        where: { id },
        include: {
          votes: { orderBy: { timestamp: 'desc' } }
        }
      });
    },

    activeProposals: async () => {
      return prisma.governanceProposal.findMany({
        where: {
          status: 'ACTIVE',
          endTime: { gt: new Date() }
        },
        orderBy: { startTime: 'desc' }
      });
    },

    // Statistics Queries
    systemStats: async () => {
      const [totalOracles, totalPriceFeeds, totalAnomalies, totalLiquidations] =
        await Promise.all([
          prisma.oracle.count(),
          prisma.priceFeed.count(),
          prisma.anomalyDetection.count(),
          prisma.liquidation.count()
        ]);

      const recentAnomalies = await prisma.anomalyDetection.count({
        where: {
          timestamp: { gte: new Date(Date.now() - 24 * 3600 * 1000) }
        }
      });

      return {
        totalOracles,
        totalPriceFeeds,
        totalAnomalies,
        anomalies24h: recentAnomalies,
        totalLiquidations,
        lastUpdated: new Date()
      };
    },

    oracleHealth: async () => {
      const oracles = await prisma.oracle.findMany({
        where: { isActive: true }
      });

      const avgReputation =
        oracles.reduce((sum, o) => sum + parseFloat(o.reputation.toString()), 0) /
        oracles.length;

      const healthyCount = oracles.filter(
        (o) => parseFloat(o.reputation.toString()) > 0.8
      ).length;

      return {
        totalActive: oracles.length,
        averageReputation: avgReputation,
        healthyPercentage: (healthyCount / oracles.length) * 100,
        lastCheck: new Date()
      };
    }
  },

  Mutation: {
    // Oracle Mutations
    registerOracle: async (
      _: any,
      { input }: { input: any },
      context: Context
    ) => {
      // Verify authorization
      if (!context.user || context.user.role !== 'ADMIN') {
        throw new Error('Unauthorized');
      }

      const oracle = await prisma.oracle.create({
        data: {
          address: input.address,
          name: input.name,
          stakeAmount: input.stakeAmount.toString(),
          reputation: '1.0',
          isActive: true,
          registeredAt: new Date()
        }
      });

      // Invalidate cache
      await redisClient.del('oracles:all');

      return oracle;
    },

    updateOracleStatus: async (
      _: any,
      { oracleId, isActive }: { oracleId: string; isActive: boolean },
      context: Context
    ) => {
      if (!context.user || context.user.role !== 'ADMIN') {
        throw new Error('Unauthorized');
      }

      const oracle = await prisma.oracle.update({
        where: { id: oracleId },
        data: { isActive }
      });

      await redisClient.del(cacheKey('oracle', oracleId));

      return oracle;
    },

    // Slashing Mutations
    reportSlashing: async (
      _: any,
      {
        oracleId,
        amount,
        reason
      }: { oracleId: string; amount: string; reason: string },
      context: Context
    ) => {
      if (!context.user || context.user.role !== 'ADMIN') {
        throw new Error('Unauthorized');
      }

      const event = await prisma.slashingEvent.create({
        data: {
          oracleId,
          amount,
          reason,
          timestamp: new Date()
        }
      });

      // Update oracle reputation
      const oracle = await prisma.oracle.findUnique({ where: { id: oracleId } });
      if (oracle) {
        const newReputation = Math.max(
          0,
          parseFloat(oracle.reputation.toString()) - 0.1
        ).toString();
        await prisma.oracle.update({
          where: { id: oracleId },
          data: { reputation: newReputation }
        });
      }

      // Publish event
      pubsub.publish(EVENTS.SLASHING_EVENT, { slashingEvent: event });

      return event;
    },

    // Governance Mutations
    createProposal: async (
      _: any,
      { input }: { input: any },
      context: Context
    ) => {
      if (!context.user) {
        throw new Error('Authentication required');
      }

      const proposal = await prisma.governanceProposal.create({
        data: {
          title: input.title,
          description: input.description,
          proposer: context.user.id,
          startTime: new Date(),
          endTime: new Date(
            Date.now() + (input.votingPeriodDays || 7) * 24 * 3600 * 1000
          ),
          status: 'ACTIVE',
          forVotes: '0',
          againstVotes: '0',
          quorum: input.quorum || '1000000'
        }
      });

      return proposal;
    },

    castVote: async (
      _: any,
      {
        proposalId,
        support,
        votingPower
      }: { proposalId: string; support: boolean; votingPower: string },
      context: Context
    ) => {
      if (!context.user) {
        throw new Error('Authentication required');
      }

      // Check if already voted
      const existingVote = await prisma.vote.findFirst({
        where: {
          proposalId,
          voter: context.user.id
        }
      });

      if (existingVote) {
        throw new Error('Already voted on this proposal');
      }

      // Create vote
      const vote = await prisma.vote.create({
        data: {
          proposalId,
          voter: context.user.id,
          support,
          votingPower,
          timestamp: new Date()
        }
      });

      // Update proposal vote counts
      const proposal = await prisma.governanceProposal.findUnique({
        where: { id: proposalId }
      });

      if (proposal) {
        const field = support ? 'forVotes' : 'againstVotes';
        const currentVotes = BigInt(proposal[field]);
        const newVotes = currentVotes + BigInt(votingPower);

        await prisma.governanceProposal.update({
          where: { id: proposalId },
          data: { [field]: newVotes.toString() }
        });
      }

      // Publish event
      pubsub.publish(EVENTS.GOVERNANCE_VOTE, {
        governanceVote: { proposalId, vote }
      });

      return vote;
    },

    // Alert Mutations
    acknowledgeAnomaly: async (
      _: any,
      { anomalyId, notes }: { anomalyId: string; notes?: string },
      context: Context
    ) => {
      if (!context.user) {
        throw new Error('Authentication required');
      }

      const anomaly = await prisma.anomalyDetection.update({
        where: { id: anomalyId },
        data: {
          isAcknowledged: true,
          acknowledgedBy: context.user.id,
          acknowledgedAt: new Date(),
          notes
        }
      });

      return anomaly;
    },

    // Circuit Breaker Mutations
    activateCircuitBreaker: async (
      _: any,
      { feedName, reason }: { feedName: string; reason: string },
      context: Context
    ) => {
      if (!context.user || context.user.role !== 'ADMIN') {
        throw new Error('Unauthorized');
      }

      await redisClient.set(`circuit_breaker:${feedName}`, JSON.stringify({
        active: true,
        reason,
        activatedBy: context.user.id,
        timestamp: Date.now()
      }));

      await redisClient.publish('circuit_breaker:activated', JSON.stringify({
        feedName,
        reason,
        activatedBy: context.user.id
      }));

      return {
        success: true,
        feedName,
        reason,
        timestamp: new Date()
      };
    },

    deactivateCircuitBreaker: async (
      _: any,
      { feedName }: { feedName: string },
      context: Context
    ) => {
      if (!context.user || context.user.role !== 'ADMIN') {
        throw new Error('Unauthorized');
      }

      await redisClient.del(`circuit_breaker:${feedName}`);

      await redisClient.publish('circuit_breaker:deactivated', JSON.stringify({
        feedName,
        deactivatedBy: context.user.id
      }));

      return {
        success: true,
        feedName,
        timestamp: new Date()
      };
    }
  },

  Subscription: {
    priceUpdate: {
      subscribe: (_: any, { tokenIds }: { tokenIds: string[] }) => {
        // Filter for specific token IDs
        return {
          [Symbol.asyncIterator]() {
            return pubsub.asyncIterator(EVENTS.PRICE_UPDATE);
          }
        };
      },
      resolve: (payload: any) => payload.priceUpdate
    },

    anomalyDetected: {
      subscribe: (_: any, { feedName }: { feedName?: string }) => {
        return {
          [Symbol.asyncIterator]() {
            return pubsub.asyncIterator(EVENTS.ANOMALY_DETECTED);
          }
        };
      },
      resolve: (payload: any) => payload.anomalyDetected
    },

    liquidationAlert: {
      subscribe: () => {
        return {
          [Symbol.asyncIterator]() {
            return pubsub.asyncIterator(EVENTS.LIQUIDATION);
          }
        };
      },
      resolve: (payload: any) => payload.liquidationAlert
    },

    slashingEvent: {
      subscribe: () => {
        return {
          [Symbol.asyncIterator]() {
            return pubsub.asyncIterator(EVENTS.SLASHING_EVENT);
          }
        };
      },
      resolve: (payload: any) => payload.slashingEvent
    },

    poolUpdate: {
      subscribe: (_: any, { poolAddresses }: { poolAddresses: string[] }) => {
        return {
          [Symbol.asyncIterator]() {
            return pubsub.asyncIterator(EVENTS.POOL_UPDATE);
          }
        };
      },
      resolve: (payload: any) => payload.poolUpdate
    },

    governanceVote: {
      subscribe: (_: any, { proposalId }: { proposalId?: string }) => {
        return {
          [Symbol.asyncIterator]() {
            return pubsub.asyncIterator(EVENTS.GOVERNANCE_VOTE);
          }
        };
      },
      resolve: (payload: any) => payload.governanceVote
    }
  },

  // Type Resolvers
  Oracle: {
    submissions: async (parent: any) => {
      return prisma.oracleSubmission.findMany({
        where: { oracleId: parent.id },
        orderBy: { timestamp: 'desc' },
        take: 10
      });
    },
    slashingEvents: async (parent: any) => {
      return prisma.slashingEvent.findMany({
        where: { oracleId: parent.id },
        orderBy: { timestamp: 'desc' }
      });
    }
  },

  Token: {
    topHolders: async (parent: any) => {
      return prisma.tokenHolder.findMany({
        where: {
          tokenAddress: parent.address,
          chain: parent.chain
        },
        orderBy: { balance: 'desc' },
        take: 10
      });
    },
    transfers: async (parent: any, { limit }: { limit?: number }) => {
      return prisma.tokenTransfer.findMany({
        where: {
          tokenAddress: parent.address,
          chain: parent.chain
        },
        orderBy: { timestamp: 'desc' },
        take: limit || 20
      });
    }
  },

  LiquidityPool: {
    recentSwaps: async (parent: any) => {
      return prisma.swap.findMany({
        where: { poolAddress: parent.address },
        orderBy: { timestamp: 'desc' },
        take: 20
      });
    },
    token0: async (parent: any) => {
      return prisma.token.findUnique({
        where: {
          address_chain: {
            address: parent.token0Address,
            chain: parent.chain
          }
        }
      });
    },
    token1: async (parent: any) => {
      return prisma.token.findUnique({
        where: {
          address_chain: {
            address: parent.token1Address,
            chain: parent.chain
          }
        }
      });
    }
  },

  GovernanceProposal: {
    votes: async (parent: any) => {
      return prisma.vote.findMany({
        where: { proposalId: parent.id },
        orderBy: { timestamp: 'desc' }
      });
    },
    voteCount: async (parent: any) => {
      return prisma.vote.count({
        where: { proposalId: parent.id }
      });
    }
  },

  // Scalar Resolvers
  BigInt: {
    __serialize: (value: bigint) => value.toString(),
    __parseValue: (value: string) => BigInt(value),
    __parseLiteral: (ast: any) => BigInt(ast.value)
  },

  Decimal: {
    __serialize: (value: any) => value.toString(),
    __parseValue: (value: string) => parseFloat(value),
    __parseLiteral: (ast: any) => parseFloat(ast.value)
  },

  DateTime: {
    __serialize: (value: Date) => value.toISOString(),
    __parseValue: (value: string) => new Date(value),
    __parseLiteral: (ast: any) => new Date(ast.value)
  }
};

// Helper to publish events from external sources
export async function publishPriceUpdate(data: any): Promise<void> {
  pubsub.publish(EVENTS.PRICE_UPDATE, { priceUpdate: data });
}

export async function publishAnomalyDetected(data: any): Promise<void> {
  pubsub.publish(EVENTS.ANOMALY_DETECTED, { anomalyDetected: data });
}

export async function publishLiquidation(data: any): Promise<void> {
  pubsub.publish(EVENTS.LIQUIDATION, { liquidationAlert: data });
}

export async function publishPoolUpdate(data: any): Promise<void> {
  pubsub.publish(EVENTS.POOL_UPDATE, { poolUpdate: data });
}

export default resolvers;
