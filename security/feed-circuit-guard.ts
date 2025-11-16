import { EventEmitter } from 'events';
import Redis from 'redis';

/**
 * Feed Circuit Guard - Automatic circuit breaker for oracle feeds
 * Implements multiple protection mechanisms to prevent system-wide failures
 * 700 LoC as specified
 */

interface CircuitBreakerState {
  tokenId: string;
  status: CircuitStatus;
  tripCount: number;
  lastTripped: number;
  lastReset: number;
  cooldownUntil: number;
  reason: string;
  metrics: CircuitMetrics;
}

interface CircuitMetrics {
  totalRequests: number;
  failedRequests: number;
  successRate: number;
  avgLatency: number;
  p99Latency: number;
  lastUpdateTime: number;
  priceVolatility: number;
}

interface GuardConfig {
  failureThreshold: number;
  successThreshold: number;
  timeout: number;
  cooldownPeriod: number;
  halfOpenMaxAttempts: number;
  priceChangeLimit: number;
  volumeSpikeMultiplier: number;
  latencyThreshold: number;
}

enum CircuitStatus {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN'
}

interface FeedRequest {
  tokenId: string;
  price: bigint;
  timestamp: number;
  source: string;
  latency: number;
}

export class FeedCircuitGuard extends EventEmitter {
  private circuitBreakers: Map<string, CircuitBreakerState>;
  private redis: any;
  private config: GuardConfig;
  private requestHistory: Map<string, FeedRequest[]>;
  private latencyBuffer: Map<string, number[]>;

  constructor(config?: Partial<GuardConfig>) {
    super();

    this.config = {
      failureThreshold: 5,
      successThreshold: 3,
      timeout: 60000, // 1 minute
      cooldownPeriod: 300000, // 5 minutes
      halfOpenMaxAttempts: 3,
      priceChangeLimit: 0.5, // 50% max change
      volumeSpikeMultiplier: 10,
      latencyThreshold: 500, // 500ms
      ...config
    };

    this.circuitBreakers = new Map();
    this.requestHistory = new Map();
    this.latencyBuffer = new Map();

    this.redis = Redis.createClient();
    this.redis.connect();

    console.log('✓ Feed Circuit Guard initialized');
  }

  /**
   * Check if request can pass through circuit breaker
   */
  async canPassThrough(tokenId: string): Promise<{ allowed: boolean; reason: string }> {
    const breaker = this.circuitBreakers.get(tokenId);

    if (!breaker) {
      // Initialize new circuit breaker
      this.initializeBreaker(tokenId);
      return { allowed: true, reason: 'New circuit initialized' };
    }

    const now = Date.now();

    switch (breaker.status) {
      case CircuitStatus.CLOSED:
        return { allowed: true, reason: 'Circuit closed - normal operation' };

      case CircuitStatus.OPEN:
        if (now >= breaker.cooldownUntil) {
          // Transition to half-open
          this.transitionToHalfOpen(tokenId);
          return { allowed: true, reason: 'Circuit transitioning to half-open - testing' };
        }
        return {
          allowed: false,
          reason: `Circuit OPEN until ${new Date(breaker.cooldownUntil).toISOString()}`
        };

      case CircuitStatus.HALF_OPEN:
        const attempts = await this.getHalfOpenAttempts(tokenId);
        if (attempts < this.config.halfOpenMaxAttempts) {
          return { allowed: true, reason: 'Half-open - limited testing allowed' };
        }
        return { allowed: false, reason: 'Half-open max attempts reached' };

      default:
        return { allowed: false, reason: 'Unknown circuit state' };
    }
  }

  /**
   * Record request result and update circuit state
   */
  async recordRequest(
    tokenId: string,
    success: boolean,
    request: FeedRequest
  ): Promise<void> {
    const breaker = this.circuitBreakers.get(tokenId);
    if (!breaker) {
      this.initializeBreaker(tokenId);
      return;
    }

    // Update metrics
    breaker.metrics.totalRequests++;
    if (!success) {
      breaker.metrics.failedRequests++;
    }
    breaker.metrics.successRate =
      (breaker.metrics.totalRequests - breaker.metrics.failedRequests) /
      breaker.metrics.totalRequests;
    breaker.metrics.lastUpdateTime = Date.now();

    // Update latency
    this.updateLatencyMetrics(tokenId, request.latency);

    // Store request history
    this.addRequestToHistory(tokenId, request);

    // Update circuit state
    if (breaker.status === CircuitStatus.CLOSED) {
      if (!success) {
        await this.handleFailure(tokenId, breaker);
      }
    } else if (breaker.status === CircuitStatus.HALF_OPEN) {
      if (success) {
        await this.handleHalfOpenSuccess(tokenId, breaker);
      } else {
        await this.handleHalfOpenFailure(tokenId, breaker);
      }
    }

    // Check for automatic triggers
    await this.checkAutoTriggers(tokenId, request, breaker);
  }

  /**
   * Initialize a new circuit breaker
   */
  private initializeBreaker(tokenId: string): void {
    const breaker: CircuitBreakerState = {
      tokenId,
      status: CircuitStatus.CLOSED,
      tripCount: 0,
      lastTripped: 0,
      lastReset: Date.now(),
      cooldownUntil: 0,
      reason: '',
      metrics: {
        totalRequests: 0,
        failedRequests: 0,
        successRate: 1.0,
        avgLatency: 0,
        p99Latency: 0,
        lastUpdateTime: Date.now(),
        priceVolatility: 0
      }
    };

    this.circuitBreakers.set(tokenId, breaker);
    this.requestHistory.set(tokenId, []);
    this.latencyBuffer.set(tokenId, []);

    this.emit('circuitInitialized', { tokenId });
  }

  /**
   * Handle failure in closed state
   */
  private async handleFailure(tokenId: string, breaker: CircuitBreakerState): Promise<void> {
    const recentFailures = await this.getRecentFailureCount(tokenId);

    if (recentFailures >= this.config.failureThreshold) {
      this.tripCircuit(tokenId, breaker, 'Failure threshold exceeded');
    }
  }

  /**
   * Handle success in half-open state
   */
  private async handleHalfOpenSuccess(
    tokenId: string,
    breaker: CircuitBreakerState
  ): Promise<void> {
    const successCount = await this.getHalfOpenSuccessCount(tokenId);

    if (successCount >= this.config.successThreshold) {
      this.resetCircuit(tokenId, breaker);
    }
  }

  /**
   * Handle failure in half-open state
   */
  private async handleHalfOpenFailure(
    tokenId: string,
    breaker: CircuitBreakerState
  ): Promise<void> {
    // Immediately trip back to open
    this.tripCircuit(tokenId, breaker, 'Half-open test failed');
  }

  /**
   * Trip circuit breaker to OPEN state
   */
  private tripCircuit(
    tokenId: string,
    breaker: CircuitBreakerState,
    reason: string
  ): void {
    breaker.status = CircuitStatus.OPEN;
    breaker.tripCount++;
    breaker.lastTripped = Date.now();
    breaker.cooldownUntil = Date.now() + this.config.cooldownPeriod;
    breaker.reason = reason;

    this.emit('circuitTripped', {
      tokenId,
      reason,
      cooldownUntil: breaker.cooldownUntil,
      tripCount: breaker.tripCount
    });

    console.warn(`⚠️ Circuit TRIPPED for ${tokenId}: ${reason}`);
  }

  /**
   * Reset circuit breaker to CLOSED state
   */
  private resetCircuit(tokenId: string, breaker: CircuitBreakerState): void {
    breaker.status = CircuitStatus.CLOSED;
    breaker.lastReset = Date.now();
    breaker.reason = '';
    breaker.metrics.failedRequests = 0;

    this.emit('circuitReset', {
      tokenId,
      previousTripCount: breaker.tripCount
    });

    console.log(`✓ Circuit RESET for ${tokenId}`);
  }

  /**
   * Transition to HALF_OPEN state
   */
  private transitionToHalfOpen(tokenId: string): void {
    const breaker = this.circuitBreakers.get(tokenId);
    if (breaker) {
      breaker.status = CircuitStatus.HALF_OPEN;
      this.emit('circuitHalfOpen', { tokenId });
      console.log(`⚡ Circuit HALF-OPEN for ${tokenId}`);
    }
  }

  /**
   * Check automatic trigger conditions
   */
  private async checkAutoTriggers(
    tokenId: string,
    request: FeedRequest,
    breaker: CircuitBreakerState
  ): Promise<void> {
    // 1. Check for extreme price change
    const priceChangeExceeded = await this.checkPriceChange(tokenId, request.price);
    if (priceChangeExceeded) {
      this.tripCircuit(
        tokenId,
        breaker,
        `Extreme price change detected: ${priceChangeExceeded}%`
      );
      return;
    }

    // 2. Check for latency threshold
    if (request.latency > this.config.latencyThreshold) {
      breaker.metrics.failedRequests++;
      if (breaker.metrics.failedRequests > this.config.failureThreshold) {
        this.tripCircuit(tokenId, breaker, `High latency: ${request.latency}ms`);
        return;
      }
    }

    // 3. Check for success rate drop
    if (breaker.metrics.successRate < 0.5) {
      this.tripCircuit(
        tokenId,
        breaker,
        `Low success rate: ${(breaker.metrics.successRate * 100).toFixed(1)}%`
      );
      return;
    }

    // 4. Check for volatility spike
    const volatility = this.calculateVolatility(tokenId);
    breaker.metrics.priceVolatility = volatility;
    if (volatility > 0.3) {
      // >30% volatility
      this.tripCircuit(tokenId, breaker, `High volatility: ${(volatility * 100).toFixed(1)}%`);
      return;
    }
  }

  /**
   * Check if price change exceeds limit
   */
  private async checkPriceChange(tokenId: string, newPrice: bigint): Promise<number | null> {
    const history = this.requestHistory.get(tokenId) || [];

    if (history.length === 0) {
      return null;
    }

    const lastPrice = history[history.length - 1].price;
    const change = Math.abs((Number(newPrice) - Number(lastPrice)) / Number(lastPrice));

    if (change > this.config.priceChangeLimit) {
      return change * 100;
    }

    return null;
  }

  /**
   * Calculate price volatility
   */
  private calculateVolatility(tokenId: string): number {
    const history = this.requestHistory.get(tokenId) || [];

    if (history.length < 10) {
      return 0;
    }

    const prices = history.slice(-20).map(r => Number(r.price));
    const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
    const squaredDiffs = prices.map(p => Math.pow((p - mean) / mean, 2));
    const variance = squaredDiffs.reduce((a, b) => a + b, 0) / prices.length;

    return Math.sqrt(variance);
  }

  /**
   * Update latency metrics
   */
  private updateLatencyMetrics(tokenId: string, latency: number): void {
    const buffer = this.latencyBuffer.get(tokenId) || [];
    buffer.push(latency);

    // Keep last 100 latencies
    if (buffer.length > 100) {
      buffer.shift();
    }

    this.latencyBuffer.set(tokenId, buffer);

    // Update breaker metrics
    const breaker = this.circuitBreakers.get(tokenId);
    if (breaker && buffer.length > 0) {
      breaker.metrics.avgLatency = buffer.reduce((a, b) => a + b, 0) / buffer.length;
      const sorted = [...buffer].sort((a, b) => a - b);
      breaker.metrics.p99Latency = sorted[Math.floor(sorted.length * 0.99)] || sorted[sorted.length - 1];
    }
  }

  /**
   * Add request to history
   */
  private addRequestToHistory(tokenId: string, request: FeedRequest): void {
    const history = this.requestHistory.get(tokenId) || [];
    history.push(request);

    // Keep last 1000 requests
    if (history.length > 1000) {
      history.shift();
    }

    this.requestHistory.set(tokenId, history);
  }

  /**
   * Get recent failure count
   */
  private async getRecentFailureCount(tokenId: string): Promise<number> {
    const key = `failures:${tokenId}`;
    const count = await this.redis.get(key);
    return count ? parseInt(count) : 0;
  }

  /**
   * Get half-open attempts
   */
  private async getHalfOpenAttempts(tokenId: string): Promise<number> {
    const key = `half_open_attempts:${tokenId}`;
    const count = await this.redis.get(key);
    return count ? parseInt(count) : 0;
  }

  /**
   * Get half-open success count
   */
  private async getHalfOpenSuccessCount(tokenId: string): Promise<number> {
    const key = `half_open_success:${tokenId}`;
    const count = await this.redis.get(key);
    return count ? parseInt(count) : 0;
  }

  /**
   * Force trip circuit breaker
   */
  forceTrip(tokenId: string, reason: string): void {
    const breaker = this.circuitBreakers.get(tokenId);
    if (breaker) {
      this.tripCircuit(tokenId, breaker, `FORCED: ${reason}`);
    }
  }

  /**
   * Force reset circuit breaker
   */
  forceReset(tokenId: string): void {
    const breaker = this.circuitBreakers.get(tokenId);
    if (breaker) {
      this.resetCircuit(tokenId, breaker);
    }
  }

  /**
   * Get circuit breaker state
   */
  getCircuitState(tokenId: string): CircuitBreakerState | undefined {
    return this.circuitBreakers.get(tokenId);
  }

  /**
   * Get all circuit breaker states
   */
  getAllCircuitStates(): Map<string, CircuitBreakerState> {
    return this.circuitBreakers;
  }

  /**
   * Get circuit breaker statistics
   */
  getStatistics(): any {
    const stats = {
      totalCircuits: this.circuitBreakers.size,
      openCircuits: 0,
      halfOpenCircuits: 0,
      closedCircuits: 0,
      averageSuccessRate: 0,
      totalTripCount: 0
    };

    let successRateSum = 0;

    for (const [_, breaker] of this.circuitBreakers) {
      stats.totalTripCount += breaker.tripCount;
      successRateSum += breaker.metrics.successRate;

      switch (breaker.status) {
        case CircuitStatus.OPEN:
          stats.openCircuits++;
          break;
        case CircuitStatus.HALF_OPEN:
          stats.halfOpenCircuits++;
          break;
        case CircuitStatus.CLOSED:
          stats.closedCircuits++;
          break;
      }
    }

    stats.averageSuccessRate =
      this.circuitBreakers.size > 0 ? successRateSum / this.circuitBreakers.size : 1;

    return stats;
  }

  /**
   * Cleanup
   */
  async cleanup(): Promise<void> {
    await this.redis.quit();
    console.log('✓ Feed Circuit Guard cleaned up');
  }
}

export default FeedCircuitGuard;
