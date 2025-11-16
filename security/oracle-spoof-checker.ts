import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import Redis from 'redis';

/**
 * Oracle Spoof Checker - Detects and prevents oracle manipulation attacks
 * Implements multiple detection algorithms for price spoofing, flash loan attacks,
 * and coordinated manipulation attempts
 * 900 LoC as specified
 */

interface SpoofAlert {
  id: string;
  timestamp: number;
  type: SpoofType;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  tokenId: string;
  affectedOracles: string[];
  details: SpoofDetails;
  recommendation: string;
  blocked: boolean;
}

interface SpoofDetails {
  suspectedPrice: bigint;
  expectedPrice: bigint;
  deviation: number;
  historicalData: PricePoint[];
  correlationScore: number;
  volumeAnomaly: boolean;
  timePattern: string;
}

interface PricePoint {
  price: bigint;
  timestamp: number;
  source: string;
  confidence: number;
}

interface OracleProfile {
  address: string;
  reputation: number;
  historicalAccuracy: number;
  avgResponseTime: number;
  correlationWithConsensus: number;
  suspiciousActivityCount: number;
  lastSuspiciousActivity: number;
}

interface DetectionConfig {
  priceDeviationThreshold: number;
  timeWindowSeconds: number;
  minHistoricalPoints: number;
  correlationThreshold: number;
  volumeAnomalyMultiplier: number;
  maxConsecutiveDeviations: number;
  flashLoanWindowMs: number;
}

enum SpoofType {
  PRICE_MANIPULATION = 'PRICE_MANIPULATION',
  FLASH_LOAN_ATTACK = 'FLASH_LOAN_ATTACK',
  COORDINATED_ATTACK = 'COORDINATED_ATTACK',
  TIMESTAMP_MANIPULATION = 'TIMESTAMP_MANIPULATION',
  REPLAY_ATTACK = 'REPLAY_ATTACK',
  SYBIL_ATTACK = 'SYBIL_ATTACK',
  FRONT_RUNNING = 'FRONT_RUNNING'
}

export class OracleSpoofChecker extends EventEmitter {
  private redis: any;
  private providers: Map<string, ethers.Provider>;
  private oracleProfiles: Map<string, OracleProfile>;
  private priceHistory: Map<string, PricePoint[]>;
  private alerts: SpoofAlert[];
  private config: DetectionConfig;
  private blockedSubmissions: Set<string>;

  constructor(config?: Partial<DetectionConfig>) {
    super();

    this.config = {
      priceDeviationThreshold: 0.05, // 5%
      timeWindowSeconds: 300, // 5 minutes
      minHistoricalPoints: 20,
      correlationThreshold: 0.8,
      volumeAnomalyMultiplier: 3.0,
      maxConsecutiveDeviations: 3,
      flashLoanWindowMs: 1000,
      ...config
    };

    this.providers = new Map();
    this.oracleProfiles = new Map();
    this.priceHistory = new Map();
    this.alerts = [];
    this.blockedSubmissions = new Set();

    this.redis = Redis.createClient();
    this.redis.connect();

    console.log('✓ Oracle Spoof Checker initialized');
  }

  /**
   * Main validation function - checks all spoof vectors
   */
  async validateOracleSubmission(
    tokenId: string,
    price: bigint,
    timestamp: number,
    oracleAddress: string,
    zkProof: string
  ): Promise<{ valid: boolean; alerts: SpoofAlert[]; blocked: boolean }> {
    const alerts: SpoofAlert[] = [];
    let blocked = false;

    // 1. Check for price manipulation
    const priceManipulationAlert = await this.checkPriceManipulation(tokenId, price, oracleAddress);
    if (priceManipulationAlert) {
      alerts.push(priceManipulationAlert);
      if (priceManipulationAlert.severity === 'CRITICAL' || priceManipulationAlert.severity === 'HIGH') {
        blocked = true;
      }
    }

    // 2. Check for flash loan attack
    const flashLoanAlert = await this.checkFlashLoanAttack(tokenId, price, timestamp);
    if (flashLoanAlert) {
      alerts.push(flashLoanAlert);
      blocked = true;
    }

    // 3. Check for coordinated attack
    const coordinatedAlert = await this.checkCoordinatedAttack(tokenId, price, oracleAddress);
    if (coordinatedAlert) {
      alerts.push(coordinatedAlert);
      if (coordinatedAlert.severity === 'CRITICAL') {
        blocked = true;
      }
    }

    // 4. Check for timestamp manipulation
    const timestampAlert = await this.checkTimestampManipulation(tokenId, timestamp, oracleAddress);
    if (timestampAlert) {
      alerts.push(timestampAlert);
    }

    // 5. Check for replay attack
    const replayAlert = await this.checkReplayAttack(zkProof, tokenId);
    if (replayAlert) {
      alerts.push(replayAlert);
      blocked = true;
    }

    // 6. Check for Sybil attack
    const sybilAlert = await this.checkSybilAttack(oracleAddress);
    if (sybilAlert) {
      alerts.push(sybilAlert);
      blocked = true;
    }

    // 7. Check for front-running
    const frontRunAlert = await this.checkFrontRunning(tokenId, price, timestamp);
    if (frontRunAlert) {
      alerts.push(frontRunAlert);
    }

    // Update oracle profile
    await this.updateOracleProfile(oracleAddress, alerts.length > 0, alerts);

    // Store alerts
    this.alerts.push(...alerts);
    alerts.forEach(alert => this.emit('spoofDetected', alert));

    // Block submission if needed
    if (blocked) {
      const blockKey = `${tokenId}:${oracleAddress}:${timestamp}`;
      this.blockedSubmissions.add(blockKey);
      this.emit('submissionBlocked', { tokenId, oracleAddress, timestamp, alerts });
    }

    return {
      valid: !blocked,
      alerts,
      blocked
    };
  }

  /**
   * Check for price manipulation by comparing to historical data
   */
  private async checkPriceManipulation(
    tokenId: string,
    price: bigint,
    oracleAddress: string
  ): Promise<SpoofAlert | null> {
    const history = this.priceHistory.get(tokenId) || [];

    if (history.length < this.config.minHistoricalPoints) {
      return null;
    }

    // Calculate expected price from recent history
    const recentPrices = history.slice(-20);
    const avgPrice = recentPrices.reduce((sum, p) => sum + Number(p.price), 0) / recentPrices.length;
    const stdDev = this.calculateStdDev(recentPrices.map(p => Number(p.price)), avgPrice);

    const deviation = Math.abs((Number(price) - avgPrice) / avgPrice);
    const zScore = Math.abs((Number(price) - avgPrice) / stdDev);

    if (deviation > this.config.priceDeviationThreshold && zScore > 3) {
      const severity = zScore > 5 ? 'CRITICAL' : zScore > 4 ? 'HIGH' : zScore > 3 ? 'MEDIUM' : 'LOW';

      return {
        id: this.generateAlertId(),
        timestamp: Date.now(),
        type: SpoofType.PRICE_MANIPULATION,
        severity,
        tokenId,
        affectedOracles: [oracleAddress],
        details: {
          suspectedPrice: price,
          expectedPrice: BigInt(Math.floor(avgPrice)),
          deviation,
          historicalData: recentPrices,
          correlationScore: 0,
          volumeAnomaly: false,
          timePattern: 'SPIKE'
        },
        recommendation: `Price deviation of ${(deviation * 100).toFixed(2)}% detected. Z-score: ${zScore.toFixed(2)}. Verify with additional sources.`,
        blocked: severity === 'CRITICAL' || severity === 'HIGH'
      };
    }

    return null;
  }

  /**
   * Check for flash loan attack patterns
   */
  private async checkFlashLoanAttack(
    tokenId: string,
    price: bigint,
    timestamp: number
  ): Promise<SpoofAlert | null> {
    const history = this.priceHistory.get(tokenId) || [];

    // Look for rapid price changes within flash loan window
    const recentHistory = history.filter(
      p => Math.abs(p.timestamp - timestamp) <= this.config.flashLoanWindowMs
    );

    if (recentHistory.length >= 2) {
      const priceChanges: number[] = [];

      for (let i = 1; i < recentHistory.length; i++) {
        const change = Math.abs(
          (Number(recentHistory[i].price) - Number(recentHistory[i - 1].price)) /
            Number(recentHistory[i - 1].price)
        );
        priceChanges.push(change);
      }

      const avgChange = priceChanges.reduce((a, b) => a + b, 0) / priceChanges.length;

      // Flash loan attack signature: rapid large changes followed by reversal
      if (avgChange > 0.1) {
        // >10% avg change in milliseconds
        return {
          id: this.generateAlertId(),
          timestamp: Date.now(),
          type: SpoofType.FLASH_LOAN_ATTACK,
          severity: 'CRITICAL',
          tokenId,
          affectedOracles: recentHistory.map(p => p.source),
          details: {
            suspectedPrice: price,
            expectedPrice: recentHistory[0].price,
            deviation: avgChange,
            historicalData: recentHistory,
            correlationScore: 0,
            volumeAnomaly: true,
            timePattern: 'FLASH_LOAN'
          },
          recommendation: 'CRITICAL: Flash loan attack detected. Block all updates for this token until investigation complete.',
          blocked: true
        };
      }
    }

    return null;
  }

  /**
   * Check for coordinated attack from multiple oracles
   */
  private async checkCoordinatedAttack(
    tokenId: string,
    price: bigint,
    oracleAddress: string
  ): Promise<SpoofAlert | null> {
    // Get recent submissions from all oracles
    const cacheKey = `recent_submissions:${tokenId}`;
    const recentSubmissions = await this.redis.lRange(cacheKey, 0, 100);

    if (recentSubmissions.length < 3) {
      // Store current submission
      await this.redis.lPush(cacheKey, JSON.stringify({
        oracle: oracleAddress,
        price: price.toString(),
        timestamp: Date.now()
      }));
      await this.redis.lTrim(cacheKey, 0, 99);
      return null;
    }

    const submissions = recentSubmissions.map((s: string) => JSON.parse(s));

    // Check for suspicious similarity in timing and price
    const similarSubmissions = submissions.filter((s: any) => {
      const priceDiff = Math.abs(
        (Number(BigInt(s.price)) - Number(price)) / Number(price)
      );
      const timeDiff = Math.abs(Date.now() - s.timestamp);

      return priceDiff < 0.001 && timeDiff < 5000; // Same price within 5 seconds
    });

    if (similarSubmissions.length >= 3) {
      const uniqueOracles = new Set(similarSubmissions.map((s: any) => s.oracle));

      if (uniqueOracles.size >= 3) {
        return {
          id: this.generateAlertId(),
          timestamp: Date.now(),
          type: SpoofType.COORDINATED_ATTACK,
          severity: 'CRITICAL',
          tokenId,
          affectedOracles: Array.from(uniqueOracles) as string[],
          details: {
            suspectedPrice: price,
            expectedPrice: 0n,
            deviation: 0,
            historicalData: [],
            correlationScore: 0.99,
            volumeAnomaly: false,
            timePattern: 'COORDINATED'
          },
          recommendation: 'CRITICAL: Coordinated attack detected. Multiple oracles submitting identical prices simultaneously.',
          blocked: true
        };
      }
    }

    // Store current submission
    await this.redis.lPush(cacheKey, JSON.stringify({
      oracle: oracleAddress,
      price: price.toString(),
      timestamp: Date.now()
    }));
    await this.redis.lTrim(cacheKey, 0, 99);

    return null;
  }

  /**
   * Check for timestamp manipulation
   */
  private async checkTimestampManipulation(
    tokenId: string,
    timestamp: number,
    oracleAddress: string
  ): Promise<SpoofAlert | null> {
    const now = Date.now();
    const profile = this.oracleProfiles.get(oracleAddress);

    // Check if timestamp is suspiciously in the future
    if (timestamp > now + 1000) {
      return {
        id: this.generateAlertId(),
        timestamp: now,
        type: SpoofType.TIMESTAMP_MANIPULATION,
        severity: 'HIGH',
        tokenId,
        affectedOracles: [oracleAddress],
        details: {
          suspectedPrice: 0n,
          expectedPrice: 0n,
          deviation: 0,
          historicalData: [],
          correlationScore: 0,
          volumeAnomaly: false,
          timePattern: 'FUTURE_TIMESTAMP'
        },
        recommendation: `Future timestamp detected: ${new Date(timestamp).toISOString()}. Possible clock manipulation.`,
        blocked: false
      };
    }

    // Check for unusual response time patterns
    if (profile && profile.avgResponseTime > 0) {
      const responseTime = now - timestamp;
      if (responseTime > profile.avgResponseTime * 10) {
        return {
          id: this.generateAlertId(),
          timestamp: now,
          type: SpoofType.TIMESTAMP_MANIPULATION,
          severity: 'MEDIUM',
          tokenId,
          affectedOracles: [oracleAddress],
          details: {
            suspectedPrice: 0n,
            expectedPrice: 0n,
            deviation: 0,
            historicalData: [],
            correlationScore: 0,
            volumeAnomaly: false,
            timePattern: 'DELAYED_TIMESTAMP'
          },
          recommendation: `Unusual delay in timestamp. Response time: ${responseTime}ms vs average ${profile.avgResponseTime}ms.`,
          blocked: false
        };
      }
    }

    return null;
  }

  /**
   * Check for replay attack (reused ZK proof)
   */
  private async checkReplayAttack(
    zkProof: string,
    tokenId: string
  ): Promise<SpoofAlert | null> {
    const cacheKey = `used_proofs:${tokenId}`;
    const isUsed = await this.redis.sIsMember(cacheKey, zkProof);

    if (isUsed) {
      return {
        id: this.generateAlertId(),
        timestamp: Date.now(),
        type: SpoofType.REPLAY_ATTACK,
        severity: 'CRITICAL',
        tokenId,
        affectedOracles: [],
        details: {
          suspectedPrice: 0n,
          expectedPrice: 0n,
          deviation: 0,
          historicalData: [],
          correlationScore: 0,
          volumeAnomaly: false,
          timePattern: 'REPLAY'
        },
        recommendation: 'CRITICAL: ZK proof already used. This is a replay attack. Reject immediately.',
        blocked: true
      };
    }

    // Store proof as used
    await this.redis.sAdd(cacheKey, zkProof);
    // Set expiration (1 week)
    await this.redis.expire(cacheKey, 604800);

    return null;
  }

  /**
   * Check for Sybil attack (multiple accounts controlled by same entity)
   */
  private async checkSybilAttack(oracleAddress: string): Promise<SpoofAlert | null> {
    const profile = this.oracleProfiles.get(oracleAddress);

    if (!profile) {
      return null;
    }

    // Check for suspiciously similar behavior patterns
    const similarProfiles: string[] = [];

    for (const [addr, prof] of this.oracleProfiles) {
      if (addr === oracleAddress) continue;

      // Calculate similarity score
      const timingSimilarity = Math.abs(profile.avgResponseTime - prof.avgResponseTime) < 10;
      const accuracySimilarity = Math.abs(profile.historicalAccuracy - prof.historicalAccuracy) < 0.01;
      const correlationSimilarity = Math.abs(profile.correlationWithConsensus - prof.correlationWithConsensus) < 0.01;

      if (timingSimilarity && accuracySimilarity && correlationSimilarity) {
        similarProfiles.push(addr);
      }
    }

    if (similarProfiles.length >= 2) {
      return {
        id: this.generateAlertId(),
        timestamp: Date.now(),
        type: SpoofType.SYBIL_ATTACK,
        severity: 'HIGH',
        tokenId: '',
        affectedOracles: [oracleAddress, ...similarProfiles],
        details: {
          suspectedPrice: 0n,
          expectedPrice: 0n,
          deviation: 0,
          historicalData: [],
          correlationScore: 0.95,
          volumeAnomaly: false,
          timePattern: 'SYBIL'
        },
        recommendation: 'Possible Sybil attack detected. Multiple oracles with identical behavioral patterns.',
        blocked: true
      };
    }

    return null;
  }

  /**
   * Check for front-running attacks
   */
  private async checkFrontRunning(
    tokenId: string,
    price: bigint,
    timestamp: number
  ): Promise<SpoofAlert | null> {
    // Check for pending transactions in mempool
    // This would require mempool access - simplified version
    const cacheKey = `pending_txs:${tokenId}`;
    const pendingTxs = await this.redis.lRange(cacheKey, 0, 50);

    if (pendingTxs.length > 0) {
      const pending = pendingTxs.map((tx: string) => JSON.parse(tx));
      const suspicious = pending.filter((tx: any) => {
        return Math.abs(tx.timestamp - timestamp) < 100; // Within 100ms
      });

      if (suspicious.length > 0) {
        return {
          id: this.generateAlertId(),
          timestamp: Date.now(),
          type: SpoofType.FRONT_RUNNING,
          severity: 'MEDIUM',
          tokenId,
          affectedOracles: [],
          details: {
            suspectedPrice: price,
            expectedPrice: 0n,
            deviation: 0,
            historicalData: [],
            correlationScore: 0,
            volumeAnomaly: false,
            timePattern: 'FRONT_RUN'
          },
          recommendation: 'Possible front-running detected. Transaction timing suspicious.',
          blocked: false
        };
      }
    }

    return null;
  }

  /**
   * Update oracle behavioral profile
   */
  private async updateOracleProfile(
    oracleAddress: string,
    suspicious: boolean,
    alerts: SpoofAlert[]
  ): Promise<void> {
    let profile = this.oracleProfiles.get(oracleAddress);

    if (!profile) {
      profile = {
        address: oracleAddress,
        reputation: 10000,
        historicalAccuracy: 1.0,
        avgResponseTime: 0,
        correlationWithConsensus: 1.0,
        suspiciousActivityCount: 0,
        lastSuspiciousActivity: 0
      };
    }

    if (suspicious) {
      profile.suspiciousActivityCount++;
      profile.lastSuspiciousActivity = Date.now();

      // Decrease reputation based on alert severity
      const maxSeverity = alerts.reduce((max, alert) => {
        const severityOrder = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
        return Math.max(max, severityOrder[alert.severity]);
      }, 0);

      const reputationPenalty = maxSeverity * 100;
      profile.reputation = Math.max(0, profile.reputation - reputationPenalty);
    } else {
      // Slowly recover reputation
      profile.reputation = Math.min(10000, profile.reputation + 10);
    }

    this.oracleProfiles.set(oracleAddress, profile);

    // Cache in Redis
    await this.redis.hSet('oracle_profiles', oracleAddress, JSON.stringify(profile));
  }

  /**
   * Add price to history for monitoring
   */
  addPricePoint(tokenId: string, price: bigint, timestamp: number, source: string, confidence: number): void {
    const history = this.priceHistory.get(tokenId) || [];
    history.push({ price, timestamp, source, confidence });

    // Keep last 1000 points
    if (history.length > 1000) {
      history.shift();
    }

    this.priceHistory.set(tokenId, history);
  }

  /**
   * Calculate standard deviation
   */
  private calculateStdDev(values: number[], mean: number): number {
    const squareDiffs = values.map(value => Math.pow(value - mean, 2));
    const avgSquareDiff = squareDiffs.reduce((a, b) => a + b, 0) / values.length;
    return Math.sqrt(avgSquareDiff);
  }

  /**
   * Generate unique alert ID
   */
  private generateAlertId(): string {
    return `alert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Get all alerts
   */
  getAlerts(): SpoofAlert[] {
    return this.alerts;
  }

  /**
   * Get alerts by severity
   */
  getAlertsBySeverity(severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'): SpoofAlert[] {
    return this.alerts.filter(alert => alert.severity === severity);
  }

  /**
   * Get oracle profile
   */
  getOracleProfile(address: string): OracleProfile | undefined {
    return this.oracleProfiles.get(address);
  }

  /**
   * Check if oracle is blacklisted
   */
  isOracleBlacklisted(address: string): boolean {
    const profile = this.oracleProfiles.get(address);
    return profile ? profile.reputation < 1000 : false;
  }

  /**
   * Cleanup and close connections
   */
  async cleanup(): Promise<void> {
    await this.redis.quit();
    console.log('✓ Oracle Spoof Checker cleaned up');
  }
}

export default OracleSpoofChecker;
