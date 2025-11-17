/**
 * K6 Load Testing Suite - Comprehensive Performance Testing
 * Production-grade load testing with realistic scenarios and metrics
 * 800+ LoC as specified
 */

import http from 'k6/http';
import ws from 'k6/ws';
import { check, group, sleep, fail } from 'k6';
import { Counter, Rate, Trend, Gauge } from 'k6/metrics';
import { randomItem, randomIntBetween } from 'https://jslib.k6.io/k6-utils/1.2.0/index.js';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';
import { htmlReport } from 'https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js';

// Configuration
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const WS_URL = __ENV.WS_URL || 'ws://localhost:3001';
const GRAPHQL_URL = __ENV.GRAPHQL_URL || 'http://localhost:4000/graphql';

// Test tokens
const TOKENS = [
  'ETH_USD', 'BTC_USD', 'USDC_USD', 'DAI_USD', 'LINK_USD',
  'AAVE_USD', 'UNI_USD', 'COMP_USD', 'MKR_USD', 'SNX_USD'
];

// Custom metrics
const oracleLatency = new Trend('oracle_price_latency', true);
const oracleErrors = new Rate('oracle_errors');
const priceUpdates = new Counter('price_updates_total');
const websocketConnections = new Gauge('ws_connections');
const anomalyDetections = new Counter('anomaly_detections');
const graphqlLatency = new Trend('graphql_query_latency', true);
const dbQueryTime = new Trend('database_query_time', true);
const cacheHitRate = new Rate('cache_hit_rate');
const throughput = new Counter('requests_throughput');

// Test options for different scenarios
export const options = {
  scenarios: {
    // Baseline load test - constant rate
    constant_load: {
      executor: 'constant-arrival-rate',
      rate: 100,
      timeUnit: '1s',
      duration: '5m',
      preAllocatedVUs: 50,
      maxVUs: 200,
      startTime: '0s',
      tags: { scenario: 'constant_load' }
    },

    // Spike test - sudden increase
    spike_test: {
      executor: 'ramping-arrival-rate',
      startRate: 10,
      timeUnit: '1s',
      preAllocatedVUs: 100,
      maxVUs: 500,
      stages: [
        { duration: '1m', target: 10 },   // Warm up
        { duration: '30s', target: 500 }, // Spike to 500 RPS
        { duration: '2m', target: 500 },  // Hold spike
        { duration: '30s', target: 10 },  // Recovery
        { duration: '1m', target: 10 }    // Cool down
      ],
      startTime: '6m',
      tags: { scenario: 'spike_test' }
    },

    // Soak test - extended duration
    soak_test: {
      executor: 'constant-vus',
      vus: 30,
      duration: '10m',
      startTime: '12m',
      tags: { scenario: 'soak_test' }
    },

    // WebSocket stress test
    websocket_stress: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m', target: 100 },
        { duration: '5m', target: 100 },
        { duration: '2m', target: 0 }
      ],
      startTime: '23m',
      tags: { scenario: 'websocket_stress' },
      exec: 'websocketTest'
    },

    // GraphQL complex queries
    graphql_load: {
      executor: 'constant-arrival-rate',
      rate: 50,
      timeUnit: '1s',
      duration: '5m',
      preAllocatedVUs: 25,
      maxVUs: 100,
      startTime: '32m',
      tags: { scenario: 'graphql_load' },
      exec: 'graphqlTest'
    },

    // Mixed realistic workload
    realistic_workload: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: 50,
      maxVUs: 300,
      stages: [
        { duration: '2m', target: 50 },   // Ramp up
        { duration: '5m', target: 100 },  // Normal load
        { duration: '3m', target: 200 },  // Peak hours
        { duration: '5m', target: 150 },  // Sustained high
        { duration: '2m', target: 50 },   // Wind down
        { duration: '1m', target: 0 }     // Shutdown
      ],
      startTime: '38m',
      tags: { scenario: 'realistic_workload' },
      exec: 'realisticWorkload'
    }
  },

  thresholds: {
    // HTTP request thresholds
    http_req_duration: ['p(95)<500', 'p(99)<1000'],
    http_req_failed: ['rate<0.01'],

    // Custom metric thresholds
    oracle_price_latency: ['p(95)<200', 'p(99)<500'],
    oracle_errors: ['rate<0.005'],
    graphql_query_latency: ['p(95)<1000', 'p(99)<2000'],
    database_query_time: ['p(95)<300'],
    cache_hit_rate: ['rate>0.6'],

    // Scenario-specific thresholds
    'http_req_duration{scenario:spike_test}': ['p(95)<2000'],
    'http_req_duration{scenario:constant_load}': ['p(95)<300'],
    'http_req_duration{scenario:realistic_workload}': ['p(95)<800']
  },

  // Output configuration
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  noConnectionReuse: false,
  userAgent: 'OracleLoadTest/1.0',
  insecureSkipTLSVerify: true,
  throw: true
};

// Setup function - runs once before test
export function setup() {
  console.log('Setting up load test...');

  // Health check
  const healthCheck = http.get(`${BASE_URL}/v1/health`);
  if (healthCheck.status !== 200) {
    fail('API health check failed');
  }

  // Get initial metrics baseline
  const statsResponse = http.get(`${BASE_URL}/v1/stats`);
  const initialStats = JSON.parse(statsResponse.body);

  return {
    startTime: new Date().toISOString(),
    initialPredictions: initialStats.total_predictions || 0,
    tokens: TOKENS
  };
}

// Default function - main load test
export default function (data) {
  const token = randomItem(data.tokens);

  group('Oracle API Tests', () => {
    // Test 1: Get current price
    group('Get Current Price', () => {
      const start = Date.now();
      const response = http.get(`${BASE_URL}/v1/oracle/price/${token}`, {
        tags: { name: 'GetPrice' }
      });

      const latency = Date.now() - start;
      oracleLatency.add(latency);
      throughput.add(1);

      const success = check(response, {
        'price request succeeded': (r) => r.status === 200,
        'response has price': (r) => {
          try {
            const body = JSON.parse(r.body);
            return body.price !== undefined && body.price > 0;
          } catch {
            return false;
          }
        },
        'response has timestamp': (r) => {
          try {
            const body = JSON.parse(r.body);
            return body.timestamp !== undefined;
          } catch {
            return false;
          }
        },
        'latency under 200ms': () => latency < 200
      });

      if (!success) {
        oracleErrors.add(1);
      }

      // Check for cache hit
      if (response.headers['X-Cache-Hit'] === 'true') {
        cacheHitRate.add(1);
      } else {
        cacheHitRate.add(0);
      }
    });

    // Test 2: Get price history
    group('Get Price History', () => {
      const start = Date.now();
      const response = http.get(
        `${BASE_URL}/v1/oracle/price/${token}/history?interval=1h&limit=24`,
        { tags: { name: 'GetPriceHistory' } }
      );

      dbQueryTime.add(Date.now() - start);
      throughput.add(1);

      check(response, {
        'history request succeeded': (r) => r.status === 200,
        'returns array of prices': (r) => {
          try {
            const body = JSON.parse(r.body);
            return Array.isArray(body.data) && body.data.length > 0;
          } catch {
            return false;
          }
        },
        'has OHLCV data': (r) => {
          try {
            const body = JSON.parse(r.body);
            const first = body.data[0];
            return first.open !== undefined &&
                   first.high !== undefined &&
                   first.low !== undefined &&
                   first.close !== undefined;
          } catch {
            return false;
          }
        }
      });
    });

    // Test 3: Get oracle sources
    group('Get Oracle Sources', () => {
      const response = http.get(
        `${BASE_URL}/v1/oracle/sources/${token}`,
        { tags: { name: 'GetSources' } }
      );
      throughput.add(1);

      check(response, {
        'sources request succeeded': (r) => r.status === 200,
        'has minimum sources': (r) => {
          try {
            const body = JSON.parse(r.body);
            return body.sources && body.sources.length >= 3;
          } catch {
            return false;
          }
        },
        'sources have weights': (r) => {
          try {
            const body = JSON.parse(r.body);
            return body.sources.every(s => s.weight !== undefined);
          } catch {
            return false;
          }
        }
      });
    });

    // Test 4: Submit price update (write operation)
    if (randomIntBetween(1, 10) === 1) { // 10% chance
      group('Submit Price Update', () => {
        const currentPrice = randomIntBetween(1000, 2000) + Math.random();
        const payload = {
          tokenId: token,
          price: currentPrice.toString(),
          timestamp: Date.now(),
          sources: [
            { name: 'source1', price: currentPrice * 0.999 },
            { name: 'source2', price: currentPrice * 1.001 },
            { name: 'source3', price: currentPrice }
          ]
        };

        const response = http.post(
          `${BASE_URL}/v1/oracle/submit`,
          JSON.stringify(payload),
          {
            headers: {
              'Content-Type': 'application/json',
              'X-Oracle-Signature': 'test-signature'
            },
            tags: { name: 'SubmitPrice' }
          }
        );

        priceUpdates.add(1);
        throughput.add(1);

        check(response, {
          'submit succeeded': (r) => r.status === 200 || r.status === 201,
          'returns confirmation': (r) => {
            try {
              const body = JSON.parse(r.body);
              return body.success === true || body.id !== undefined;
            } catch {
              return false;
            }
          }
        });
      });
    }

    // Test 5: Check anomaly status
    group('Check Anomaly Status', () => {
      const response = http.get(
        `${BASE_URL}/v1/anomaly/status/${token}`,
        { tags: { name: 'AnomalyStatus' } }
      );
      throughput.add(1);

      const passed = check(response, {
        'anomaly check succeeded': (r) => r.status === 200,
        'has anomaly score': (r) => {
          try {
            const body = JSON.parse(r.body);
            return body.anomalyScore !== undefined;
          } catch {
            return false;
          }
        }
      });

      if (passed) {
        try {
          const body = JSON.parse(response.body);
          if (body.isAnomaly) {
            anomalyDetections.add(1);
          }
        } catch {
          // Ignore parse errors
        }
      }
    });
  });

  sleep(randomIntBetween(1, 3) / 10); // 0.1-0.3s between iterations
}

// WebSocket test function
export function websocketTest(data) {
  const token = randomItem(data.tokens);

  const url = `${WS_URL}/v1/subscribe?token=${token}`;

  const res = ws.connect(url, {}, function (socket) {
    websocketConnections.add(1);

    socket.on('open', () => {
      console.log(`WebSocket connected for ${token}`);

      // Subscribe to price updates
      socket.send(JSON.stringify({
        type: 'subscribe',
        channel: 'price_updates',
        tokens: [token]
      }));
    });

    socket.on('message', (message) => {
      const data = JSON.parse(message);

      check(data, {
        'message has type': (d) => d.type !== undefined,
        'price update valid': (d) => {
          if (d.type === 'price_update') {
            return d.price !== undefined && d.timestamp !== undefined;
          }
          return true;
        }
      });

      priceUpdates.add(1);
    });

    socket.on('error', (e) => {
      console.error('WebSocket error:', e);
      oracleErrors.add(1);
    });

    socket.on('close', () => {
      websocketConnections.add(-1);
    });

    // Keep connection alive for 30-60 seconds
    socket.setTimeout(() => {
      socket.close();
    }, randomIntBetween(30000, 60000));
  });

  check(res, { 'WebSocket connected': (r) => r && r.status === 101 });
}

// GraphQL test function
export function graphqlTest(data) {
  const token = randomItem(data.tokens);

  group('GraphQL Queries', () => {
    // Simple query
    group('Price Query', () => {
      const query = `
        query GetPrice($tokenId: String!) {
          currentPrice(tokenId: $tokenId) {
            price
            timestamp
            sources {
              name
              price
              weight
            }
          }
        }
      `;

      const start = Date.now();
      const response = http.post(
        GRAPHQL_URL,
        JSON.stringify({
          query,
          variables: { tokenId: token }
        }),
        {
          headers: { 'Content-Type': 'application/json' },
          tags: { name: 'GraphQL_Price' }
        }
      );

      graphqlLatency.add(Date.now() - start);
      throughput.add(1);

      check(response, {
        'GraphQL query succeeded': (r) => r.status === 200,
        'no GraphQL errors': (r) => {
          try {
            const body = JSON.parse(r.body);
            return !body.errors || body.errors.length === 0;
          } catch {
            return false;
          }
        },
        'has data': (r) => {
          try {
            const body = JSON.parse(r.body);
            return body.data && body.data.currentPrice !== null;
          } catch {
            return false;
          }
        }
      });
    });

    // Complex aggregation query
    group('Aggregation Query', () => {
      const query = `
        query GetAggregatedData($tokenId: String!, $startTime: DateTime!, $endTime: DateTime!) {
          priceHistory(tokenId: $tokenId, startTime: $startTime, endTime: $endTime, interval: "1h") {
            time
            open
            high
            low
            close
            volume
            avgDeviation
          }
          oracleStatistics(tokenId: $tokenId) {
            totalSubmissions
            avgLatency
            uptime
            lastUpdate
          }
          anomalyEvents(tokenId: $tokenId, limit: 10) {
            timestamp
            severity
            type
            score
          }
        }
      `;

      const now = new Date();
      const start = Date.now();
      const response = http.post(
        GRAPHQL_URL,
        JSON.stringify({
          query,
          variables: {
            tokenId: token,
            startTime: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
            endTime: now.toISOString()
          }
        }),
        {
          headers: { 'Content-Type': 'application/json' },
          tags: { name: 'GraphQL_Aggregation' }
        }
      );

      graphqlLatency.add(Date.now() - start);
      dbQueryTime.add(Date.now() - start);
      throughput.add(1);

      check(response, {
        'complex query succeeded': (r) => r.status === 200,
        'has history data': (r) => {
          try {
            const body = JSON.parse(r.body);
            return body.data && Array.isArray(body.data.priceHistory);
          } catch {
            return false;
          }
        },
        'has statistics': (r) => {
          try {
            const body = JSON.parse(r.body);
            return body.data && body.data.oracleStatistics !== null;
          } catch {
            return false;
          }
        }
      });
    });

    // Mutation test (10% of requests)
    if (randomIntBetween(1, 10) === 1) {
      group('GraphQL Mutation', () => {
        const mutation = `
          mutation SubscribeToAlerts($tokenId: String!, $threshold: Float!) {
            createAlertSubscription(
              tokenId: $tokenId,
              deviationThreshold: $threshold
            ) {
              id
              createdAt
            }
          }
        `;

        const response = http.post(
          GRAPHQL_URL,
          JSON.stringify({
            mutation,
            variables: {
              tokenId: token,
              threshold: randomIntBetween(3, 10)
            }
          }),
          {
            headers: { 'Content-Type': 'application/json' },
            tags: { name: 'GraphQL_Mutation' }
          }
        );

        throughput.add(1);

        check(response, {
          'mutation succeeded': (r) => r.status === 200
        });
      });
    }
  });

  sleep(0.5);
}

// Realistic workload simulation
export function realisticWorkload(data) {
  const userType = randomIntBetween(1, 100);

  if (userType <= 60) {
    // 60% - Regular price checking users
    regularUserFlow(data);
  } else if (userType <= 85) {
    // 25% - Dashboard users (more complex queries)
    dashboardUserFlow(data);
  } else if (userType <= 95) {
    // 10% - Oracle operators (submitting prices)
    oracleOperatorFlow(data);
  } else {
    // 5% - Admin users (heavy queries)
    adminUserFlow(data);
  }
}

function regularUserFlow(data) {
  const token = randomItem(data.tokens);

  // Get current price
  const priceResp = http.get(`${BASE_URL}/v1/oracle/price/${token}`, {
    tags: { name: 'RegularUser_Price' }
  });
  throughput.add(1);

  check(priceResp, { 'price fetched': (r) => r.status === 200 });

  sleep(randomIntBetween(5, 15) / 10);

  // Maybe check another token
  if (randomIntBetween(1, 2) === 1) {
    const anotherToken = randomItem(data.tokens);
    http.get(`${BASE_URL}/v1/oracle/price/${anotherToken}`, {
      tags: { name: 'RegularUser_Price2' }
    });
    throughput.add(1);
  }

  sleep(randomIntBetween(10, 30) / 10);
}

function dashboardUserFlow(data) {
  const tokens = [randomItem(data.tokens), randomItem(data.tokens)];

  // Batch price fetch
  const batchResp = http.post(
    `${BASE_URL}/v1/oracle/prices/batch`,
    JSON.stringify({ tokens }),
    {
      headers: { 'Content-Type': 'application/json' },
      tags: { name: 'Dashboard_BatchPrice' }
    }
  );
  throughput.add(1);

  check(batchResp, { 'batch prices fetched': (r) => r.status === 200 });

  sleep(0.5);

  // Get historical data for chart
  const historyResp = http.get(
    `${BASE_URL}/v1/oracle/price/${tokens[0]}/history?interval=15m&limit=96`,
    { tags: { name: 'Dashboard_History' } }
  );
  throughput.add(1);

  check(historyResp, { 'history fetched': (r) => r.status === 200 });

  sleep(0.3);

  // Get anomaly summary
  const anomalyResp = http.get(
    `${BASE_URL}/v1/anomaly/summary`,
    { tags: { name: 'Dashboard_Anomalies' } }
  );
  throughput.add(1);

  check(anomalyResp, { 'anomalies fetched': (r) => r.status === 200 });

  sleep(randomIntBetween(20, 60) / 10);
}

function oracleOperatorFlow(data) {
  const token = randomItem(data.tokens);

  // Check current aggregated price
  const currentResp = http.get(`${BASE_URL}/v1/oracle/price/${token}`, {
    tags: { name: 'Operator_CurrentPrice' }
  });
  throughput.add(1);

  const currentData = JSON.parse(currentResp.body);
  const basePrice = currentData.price || 1500;

  sleep(0.2);

  // Submit new price (small deviation)
  const newPrice = basePrice * (1 + (randomIntBetween(-10, 10) / 10000));
  const submitPayload = {
    tokenId: token,
    price: newPrice.toString(),
    timestamp: Date.now(),
    signature: 'operator-signature',
    sources: [
      { name: 'coingecko', price: newPrice * 0.9998 },
      { name: 'coinmarketcap', price: newPrice * 1.0002 },
      { name: 'binance', price: newPrice }
    ]
  };

  const submitResp = http.post(
    `${BASE_URL}/v1/oracle/submit`,
    JSON.stringify(submitPayload),
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Oracle-Key': 'operator-key'
      },
      tags: { name: 'Operator_Submit' }
    }
  );

  priceUpdates.add(1);
  throughput.add(1);

  check(submitResp, {
    'price submitted': (r) => r.status === 200 || r.status === 201
  });

  sleep(randomIntBetween(50, 100) / 10); // Wait 5-10s before next submission
}

function adminUserFlow(data) {
  // Heavy aggregation query
  const statsResp = http.get(`${BASE_URL}/v1/admin/statistics`, {
    headers: { 'Authorization': 'Bearer admin-token' },
    tags: { name: 'Admin_Stats' }
  });
  throughput.add(1);

  sleep(0.5);

  // Get all oracle health
  const healthResp = http.get(`${BASE_URL}/v1/admin/oracle/health`, {
    headers: { 'Authorization': 'Bearer admin-token' },
    tags: { name: 'Admin_Health' }
  });
  throughput.add(1);

  sleep(0.3);

  // Export recent data (expensive operation)
  const exportResp = http.get(
    `${BASE_URL}/v1/admin/export?format=json&hours=1`,
    {
      headers: { 'Authorization': 'Bearer admin-token' },
      tags: { name: 'Admin_Export' },
      timeout: '30s'
    }
  );
  throughput.add(1);

  dbQueryTime.add(exportResp.timings.duration);

  check(exportResp, { 'export succeeded': (r) => r.status === 200 });

  sleep(randomIntBetween(30, 120) / 10); // Admin users are slower
}

// Teardown function - runs once after test
export function teardown(data) {
  console.log('Load test completed');

  // Get final metrics
  const statsResponse = http.get(`${BASE_URL}/v1/stats`);
  const finalStats = JSON.parse(statsResponse.body);

  console.log(`Test started: ${data.startTime}`);
  console.log(`Test ended: ${new Date().toISOString()}`);
  console.log(`Initial predictions: ${data.initialPredictions}`);
  console.log(`Final predictions: ${finalStats.total_predictions}`);
  console.log(`Predictions during test: ${finalStats.total_predictions - data.initialPredictions}`);
}

// Custom summary output
export function handleSummary(data) {
  return {
    'stdout': textSummary(data, { indent: ' ', enableColors: true }),
    'summary.html': htmlReport(data),
    'summary.json': JSON.stringify(data, null, 2)
  };
}
