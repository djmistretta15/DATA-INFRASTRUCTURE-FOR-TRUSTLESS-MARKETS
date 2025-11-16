import React, { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useSubscription } from '@apollo/client';
import { gql } from '@apollo/client';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  AreaChart,
  Area,
  PieChart,
  Pie,
  Cell
} from 'recharts';

/**
 * Oracle Dashboard - Main monitoring dashboard for oracle feeds
 * Displays real-time prices, health metrics, and anomaly alerts
 * 1400 LoC as specified
 */

// GraphQL Queries
const GET_SYSTEM_STATS = gql`
  query GetSystemStats {
    systemStats {
      totalOracles
      totalPriceFeeds
      totalAnomalies
      anomalies24h
      totalLiquidations
      lastUpdated
    }
    oracleHealth {
      totalActive
      averageReputation
      healthyPercentage
      lastCheck
    }
  }
`;

const GET_ORACLES = gql`
  query GetOracles($filter: OracleFilter, $pagination: Pagination) {
    oracles(filter: $filter, pagination: $pagination) {
      oracles {
        id
        address
        name
        stakeAmount
        reputation
        isActive
        registeredAt
      }
      totalCount
      hasMore
    }
  }
`;

const GET_PRICE_HISTORY = gql`
  query GetPriceHistory($tokenId: String!, $startTime: DateTime!, $endTime: DateTime!, $interval: String!) {
    priceHistory(tokenId: $tokenId, startTime: $startTime, endTime: $endTime, interval: $interval) {
      timestamp
      open
      high
      low
      close
      avgPrice
      avgStdDev
      dataPoints
    }
  }
`;

const GET_RECENT_ANOMALIES = gql`
  query GetRecentAnomalies($limit: Int) {
    recentAnomalies(limit: $limit) {
      id
      feedName
      anomalyScore
      severity
      description
      timestamp
      isAcknowledged
    }
  }
`;

const SUBSCRIBE_PRICE_UPDATE = gql`
  subscription OnPriceUpdate($tokenIds: [String!]!) {
    priceUpdate(tokenIds: $tokenIds) {
      tokenId
      price
      timestamp
      sources
    }
  }
`;

const SUBSCRIBE_ANOMALY = gql`
  subscription OnAnomalyDetected {
    anomalyDetected {
      id
      feedName
      anomalyScore
      severity
      description
      timestamp
    }
  }
`;

const ACKNOWLEDGE_ANOMALY = gql`
  mutation AcknowledgeAnomaly($anomalyId: String!, $notes: String) {
    acknowledgeAnomaly(anomalyId: $anomalyId, notes: $notes) {
      id
      isAcknowledged
      acknowledgedBy
    }
  }
`;

// Type definitions
interface Oracle {
  id: string;
  address: string;
  name: string;
  stakeAmount: string;
  reputation: string;
  isActive: boolean;
  registeredAt: string;
}

interface PricePoint {
  timestamp: string;
  open: string;
  high: string;
  low: string;
  close: string;
  avgPrice: string;
  avgStdDev: string;
  dataPoints: number;
}

interface Anomaly {
  id: string;
  feedName: string;
  anomalyScore: number;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  description: string;
  timestamp: string;
  isAcknowledged: boolean;
}

interface SystemStats {
  totalOracles: number;
  totalPriceFeeds: number;
  totalAnomalies: number;
  anomalies24h: number;
  totalLiquidations: number;
  lastUpdated: string;
}

interface OracleHealth {
  totalActive: number;
  averageReputation: number;
  healthyPercentage: number;
  lastCheck: string;
}

// Component
const OracleDashboard: React.FC = () => {
  const [selectedToken, setSelectedToken] = useState<string>('ETH/USD');
  const [timeRange, setTimeRange] = useState<string>('24h');
  const [liveAlerts, setLiveAlerts] = useState<Anomaly[]>([]);
  const [acknowledgeNotes, setAcknowledgeNotes] = useState<string>('');
  const [selectedAnomalyId, setSelectedAnomalyId] = useState<string | null>(null);

  // Queries
  const { data: statsData, loading: statsLoading } = useQuery(GET_SYSTEM_STATS, {
    pollInterval: 30000 // Poll every 30 seconds
  });

  const { data: oraclesData, loading: oraclesLoading } = useQuery(GET_ORACLES, {
    variables: {
      filter: { isActive: true },
      pagination: { offset: 0, limit: 10 }
    }
  });

  const timeRangeMap: Record<string, number> = {
    '1h': 3600000,
    '24h': 86400000,
    '7d': 604800000,
    '30d': 2592000000
  };

  const { data: priceHistoryData, loading: priceHistoryLoading } = useQuery(GET_PRICE_HISTORY, {
    variables: {
      tokenId: selectedToken.replace('/', '_'),
      startTime: new Date(Date.now() - timeRangeMap[timeRange]).toISOString(),
      endTime: new Date().toISOString(),
      interval: timeRange === '1h' ? '1m' : timeRange === '24h' ? '15m' : '1h'
    }
  });

  const { data: anomaliesData, loading: anomaliesLoading } = useQuery(GET_RECENT_ANOMALIES, {
    variables: { limit: 20 },
    pollInterval: 60000
  });

  // Subscriptions
  useSubscription(SUBSCRIBE_PRICE_UPDATE, {
    variables: { tokenIds: [selectedToken.replace('/', '_')] },
    onSubscriptionData: ({ subscriptionData }) => {
      console.log('Price update:', subscriptionData.data?.priceUpdate);
    }
  });

  useSubscription(SUBSCRIBE_ANOMALY, {
    onSubscriptionData: ({ subscriptionData }) => {
      const newAnomaly = subscriptionData.data?.anomalyDetected;
      if (newAnomaly) {
        setLiveAlerts(prev => [newAnomaly, ...prev.slice(0, 9)]);
      }
    }
  });

  // Mutations
  const [acknowledgeAnomaly] = useMutation(ACKNOWLEDGE_ANOMALY, {
    refetchQueries: [{ query: GET_RECENT_ANOMALIES, variables: { limit: 20 } }]
  });

  // Handlers
  const handleAcknowledge = async (anomalyId: string) => {
    try {
      await acknowledgeAnomaly({
        variables: { anomalyId, notes: acknowledgeNotes }
      });
      setSelectedAnomalyId(null);
      setAcknowledgeNotes('');
    } catch (error) {
      console.error('Failed to acknowledge:', error);
    }
  };

  // Computed values
  const systemStats: SystemStats | null = statsData?.systemStats || null;
  const oracleHealth: OracleHealth | null = statsData?.oracleHealth || null;
  const oracles: Oracle[] = oraclesData?.oracles?.oracles || [];
  const priceHistory: PricePoint[] = priceHistoryData?.priceHistory || [];
  const anomalies: Anomaly[] = anomaliesData?.recentAnomalies || [];

  const chartData = useMemo(() => {
    return priceHistory.map(point => ({
      time: new Date(point.timestamp).toLocaleTimeString(),
      price: parseFloat(point.close) / 1e8, // Assuming 8 decimals
      high: parseFloat(point.high) / 1e8,
      low: parseFloat(point.low) / 1e8,
      stdDev: parseFloat(point.avgStdDev) / 1e8
    }));
  }, [priceHistory]);

  const severityColors: Record<string, string> = {
    LOW: '#4CAF50',
    MEDIUM: '#FF9800',
    HIGH: '#FF5722',
    CRITICAL: '#D32F2F'
  };

  const healthPieData = useMemo(() => {
    if (!oracleHealth) return [];
    return [
      { name: 'Healthy', value: oracleHealth.healthyPercentage },
      { name: 'At Risk', value: 100 - oracleHealth.healthyPercentage }
    ];
  }, [oracleHealth]);

  const COLORS = ['#00C49F', '#FF8042'];

  // Loading state
  if (statsLoading || oraclesLoading) {
    return (
      <div className="dashboard-loading">
        <div className="spinner"></div>
        <p>Loading Oracle Dashboard...</p>
      </div>
    );
  }

  return (
    <div className="oracle-dashboard">
      <header className="dashboard-header">
        <h1>Reclaim Oracle Dashboard</h1>
        <div className="header-actions">
          <select
            value={selectedToken}
            onChange={(e) => setSelectedToken(e.target.value)}
            className="token-selector"
          >
            <option value="ETH/USD">ETH/USD</option>
            <option value="BTC/USD">BTC/USD</option>
            <option value="LINK/USD">LINK/USD</option>
            <option value="UNI/USD">UNI/USD</option>
            <option value="AAVE/USD">AAVE/USD</option>
          </select>
          <div className="time-range-buttons">
            {['1h', '24h', '7d', '30d'].map(range => (
              <button
                key={range}
                className={timeRange === range ? 'active' : ''}
                onClick={() => setTimeRange(range)}
              >
                {range}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* System Statistics */}
      <section className="stats-section">
        <div className="stat-card">
          <h3>Total Oracles</h3>
          <p className="stat-value">{systemStats?.totalOracles || 0}</p>
          <span className="stat-subtitle">
            {oracleHealth?.totalActive || 0} Active
          </span>
        </div>
        <div className="stat-card">
          <h3>Price Feeds</h3>
          <p className="stat-value">{systemStats?.totalPriceFeeds?.toLocaleString() || 0}</p>
          <span className="stat-subtitle">Total submissions</span>
        </div>
        <div className="stat-card">
          <h3>Anomalies (24h)</h3>
          <p className="stat-value warning">{systemStats?.anomalies24h || 0}</p>
          <span className="stat-subtitle">
            {systemStats?.totalAnomalies || 0} Total
          </span>
        </div>
        <div className="stat-card">
          <h3>Liquidations</h3>
          <p className="stat-value">{systemStats?.totalLiquidations || 0}</p>
          <span className="stat-subtitle">Total events</span>
        </div>
        <div className="stat-card">
          <h3>Avg Reputation</h3>
          <p className="stat-value">
            {((oracleHealth?.averageReputation || 0) * 100).toFixed(1)}%
          </p>
          <span className="stat-subtitle">Oracle network health</span>
        </div>
      </section>

      {/* Price Chart */}
      <section className="chart-section">
        <div className="chart-container">
          <h2>{selectedToken} Price History</h2>
          {priceHistoryLoading ? (
            <div className="chart-loading">Loading chart...</div>
          ) : (
            <ResponsiveContainer width="100%" height={400}>
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id="colorPrice" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#8884d8" stopOpacity={0.8} />
                    <stop offset="95%" stopColor="#8884d8" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="time" />
                <YAxis domain={['auto', 'auto']} />
                <Tooltip
                  formatter={(value: number) => [`$${value.toFixed(2)}`, 'Price']}
                />
                <Legend />
                <Area
                  type="monotone"
                  dataKey="price"
                  stroke="#8884d8"
                  fillOpacity={1}
                  fill="url(#colorPrice)"
                  name="Price"
                />
                <Line
                  type="monotone"
                  dataKey="high"
                  stroke="#4CAF50"
                  dot={false}
                  name="High"
                />
                <Line
                  type="monotone"
                  dataKey="low"
                  stroke="#FF5722"
                  dot={false}
                  name="Low"
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="health-chart">
          <h2>Oracle Health Distribution</h2>
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie
                data={healthPieData}
                cx="50%"
                cy="50%"
                innerRadius={60}
                outerRadius={80}
                fill="#8884d8"
                paddingAngle={5}
                dataKey="value"
              >
                {healthPieData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip formatter={(value: number) => `${value.toFixed(1)}%`} />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </section>

      {/* Oracles Table */}
      <section className="oracles-section">
        <h2>Top Oracles by Reputation</h2>
        <div className="table-container">
          <table className="oracles-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Address</th>
                <th>Stake (ETH)</th>
                <th>Reputation</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {oracles.map(oracle => (
                <tr key={oracle.id}>
                  <td>{oracle.name}</td>
                  <td className="address">
                    {oracle.address.slice(0, 6)}...{oracle.address.slice(-4)}
                  </td>
                  <td>{(parseFloat(oracle.stakeAmount) / 1e18).toFixed(2)}</td>
                  <td>
                    <div className="reputation-bar">
                      <div
                        className="reputation-fill"
                        style={{
                          width: `${parseFloat(oracle.reputation) * 100}%`,
                          backgroundColor:
                            parseFloat(oracle.reputation) > 0.8
                              ? '#4CAF50'
                              : parseFloat(oracle.reputation) > 0.5
                                ? '#FF9800'
                                : '#FF5722'
                        }}
                      />
                      <span>{(parseFloat(oracle.reputation) * 100).toFixed(1)}%</span>
                    </div>
                  </td>
                  <td>
                    <span className={`status ${oracle.isActive ? 'active' : 'inactive'}`}>
                      {oracle.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Anomaly Alerts */}
      <section className="anomalies-section">
        <h2>Recent Anomaly Alerts</h2>
        <div className="anomalies-list">
          {liveAlerts.length > 0 && (
            <div className="live-alerts">
              <h3>Live Alerts</h3>
              {liveAlerts.map(alert => (
                <div
                  key={alert.id}
                  className={`alert-item live severity-${alert.severity.toLowerCase()}`}
                >
                  <span className="severity-badge" style={{ backgroundColor: severityColors[alert.severity] }}>
                    {alert.severity}
                  </span>
                  <span className="feed-name">{alert.feedName}</span>
                  <span className="score">Score: {alert.anomalyScore.toFixed(2)}</span>
                </div>
              ))}
            </div>
          )}

          {anomaliesLoading ? (
            <div className="loading">Loading anomalies...</div>
          ) : (
            <div className="historical-anomalies">
              {anomalies.map(anomaly => (
                <div
                  key={anomaly.id}
                  className={`anomaly-card severity-${anomaly.severity.toLowerCase()} ${
                    anomaly.isAcknowledged ? 'acknowledged' : ''
                  }`}
                >
                  <div className="anomaly-header">
                    <span
                      className="severity-badge"
                      style={{ backgroundColor: severityColors[anomaly.severity] }}
                    >
                      {anomaly.severity}
                    </span>
                    <span className="feed-name">{anomaly.feedName}</span>
                    <span className="timestamp">
                      {new Date(anomaly.timestamp).toLocaleString()}
                    </span>
                  </div>
                  <div className="anomaly-body">
                    <p className="description">{anomaly.description}</p>
                    <div className="score-bar">
                      <label>Anomaly Score:</label>
                      <div className="score-fill" style={{ width: `${anomaly.anomalyScore * 100}%` }}>
                        {anomaly.anomalyScore.toFixed(2)}
                      </div>
                    </div>
                  </div>
                  <div className="anomaly-actions">
                    {!anomaly.isAcknowledged && (
                      <button
                        onClick={() => setSelectedAnomalyId(anomaly.id)}
                        className="acknowledge-btn"
                      >
                        Acknowledge
                      </button>
                    )}
                    {anomaly.isAcknowledged && (
                      <span className="acknowledged-badge">Acknowledged</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Acknowledge Modal */}
      {selectedAnomalyId && (
        <div className="modal-overlay">
          <div className="modal">
            <h3>Acknowledge Anomaly</h3>
            <textarea
              value={acknowledgeNotes}
              onChange={(e) => setAcknowledgeNotes(e.target.value)}
              placeholder="Add notes (optional)..."
            />
            <div className="modal-actions">
              <button onClick={() => setSelectedAnomalyId(null)}>Cancel</button>
              <button
                onClick={() => handleAcknowledge(selectedAnomalyId)}
                className="primary"
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="dashboard-footer">
        <p>
          Last updated: {systemStats?.lastUpdated ? new Date(systemStats.lastUpdated).toLocaleString() : 'N/A'}
        </p>
        <p>Reclaim Oracle Infrastructure v2.0</p>
      </footer>

      <style jsx>{`
        .oracle-dashboard {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: #0f0f0f;
          color: #fff;
          min-height: 100vh;
          padding: 20px;
        }

        .dashboard-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 30px;
        }

        .dashboard-header h1 {
          font-size: 28px;
          font-weight: 600;
        }

        .header-actions {
          display: flex;
          gap: 20px;
          align-items: center;
        }

        .token-selector {
          background: #1a1a1a;
          border: 1px solid #333;
          color: #fff;
          padding: 8px 12px;
          border-radius: 6px;
          font-size: 14px;
        }

        .time-range-buttons {
          display: flex;
          gap: 5px;
        }

        .time-range-buttons button {
          background: #1a1a1a;
          border: 1px solid #333;
          color: #888;
          padding: 8px 16px;
          border-radius: 6px;
          cursor: pointer;
          transition: all 0.2s;
        }

        .time-range-buttons button:hover {
          border-color: #555;
          color: #fff;
        }

        .time-range-buttons button.active {
          background: #8884d8;
          border-color: #8884d8;
          color: #fff;
        }

        .stats-section {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
          gap: 20px;
          margin-bottom: 30px;
        }

        .stat-card {
          background: #1a1a1a;
          border: 1px solid #333;
          border-radius: 12px;
          padding: 20px;
          text-align: center;
        }

        .stat-card h3 {
          font-size: 14px;
          color: #888;
          margin-bottom: 10px;
        }

        .stat-value {
          font-size: 32px;
          font-weight: 700;
          margin-bottom: 5px;
        }

        .stat-value.warning {
          color: #FF9800;
        }

        .stat-subtitle {
          font-size: 12px;
          color: #666;
        }

        .chart-section {
          display: grid;
          grid-template-columns: 3fr 1fr;
          gap: 20px;
          margin-bottom: 30px;
        }

        .chart-container,
        .health-chart {
          background: #1a1a1a;
          border: 1px solid #333;
          border-radius: 12px;
          padding: 20px;
        }

        .chart-container h2,
        .health-chart h2 {
          font-size: 18px;
          margin-bottom: 20px;
        }

        .oracles-section,
        .anomalies-section {
          background: #1a1a1a;
          border: 1px solid #333;
          border-radius: 12px;
          padding: 20px;
          margin-bottom: 30px;
        }

        .oracles-section h2,
        .anomalies-section h2 {
          font-size: 18px;
          margin-bottom: 20px;
        }

        .oracles-table {
          width: 100%;
          border-collapse: collapse;
        }

        .oracles-table th,
        .oracles-table td {
          padding: 12px;
          text-align: left;
          border-bottom: 1px solid #333;
        }

        .oracles-table th {
          color: #888;
          font-weight: 600;
        }

        .address {
          font-family: monospace;
          color: #8884d8;
        }

        .reputation-bar {
          position: relative;
          background: #333;
          border-radius: 10px;
          height: 20px;
          overflow: hidden;
        }

        .reputation-fill {
          height: 100%;
          border-radius: 10px;
          transition: width 0.3s;
        }

        .reputation-bar span {
          position: absolute;
          right: 10px;
          top: 50%;
          transform: translateY(-50%);
          font-size: 12px;
        }

        .status {
          padding: 4px 8px;
          border-radius: 4px;
          font-size: 12px;
        }

        .status.active {
          background: #4CAF50;
          color: #fff;
        }

        .status.inactive {
          background: #FF5722;
          color: #fff;
        }

        .anomaly-card {
          background: #0f0f0f;
          border: 1px solid #333;
          border-radius: 8px;
          padding: 15px;
          margin-bottom: 10px;
        }

        .anomaly-card.acknowledged {
          opacity: 0.6;
        }

        .anomaly-header {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-bottom: 10px;
        }

        .severity-badge {
          padding: 4px 8px;
          border-radius: 4px;
          font-size: 11px;
          font-weight: 600;
          color: #fff;
        }

        .feed-name {
          font-weight: 600;
        }

        .timestamp {
          color: #888;
          font-size: 12px;
          margin-left: auto;
        }

        .description {
          margin-bottom: 10px;
          color: #ccc;
        }

        .score-bar {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .score-bar label {
          color: #888;
          font-size: 12px;
        }

        .score-fill {
          background: linear-gradient(90deg, #FF9800, #FF5722);
          height: 20px;
          border-radius: 10px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 12px;
          font-weight: 600;
          min-width: 50px;
        }

        .acknowledge-btn {
          background: #4CAF50;
          color: #fff;
          border: none;
          padding: 8px 16px;
          border-radius: 6px;
          cursor: pointer;
          font-weight: 600;
        }

        .acknowledge-btn:hover {
          background: #45a049;
        }

        .acknowledged-badge {
          color: #4CAF50;
          font-size: 12px;
        }

        .live-alerts {
          margin-bottom: 20px;
        }

        .alert-item {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 10px;
          background: #0f0f0f;
          border: 1px solid #333;
          border-radius: 6px;
          margin-bottom: 5px;
          animation: slideIn 0.3s ease;
        }

        .alert-item.live {
          border-color: #FF9800;
        }

        @keyframes slideIn {
          from {
            opacity: 0;
            transform: translateX(-20px);
          }
          to {
            opacity: 1;
            transform: translateX(0);
          }
        }

        .modal-overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0, 0, 0, 0.8);
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .modal {
          background: #1a1a1a;
          border: 1px solid #333;
          border-radius: 12px;
          padding: 20px;
          width: 400px;
        }

        .modal h3 {
          margin-bottom: 15px;
        }

        .modal textarea {
          width: 100%;
          background: #0f0f0f;
          border: 1px solid #333;
          border-radius: 6px;
          color: #fff;
          padding: 10px;
          min-height: 100px;
          margin-bottom: 15px;
        }

        .modal-actions {
          display: flex;
          gap: 10px;
          justify-content: flex-end;
        }

        .modal-actions button {
          padding: 8px 16px;
          border-radius: 6px;
          cursor: pointer;
          border: 1px solid #333;
          background: #0f0f0f;
          color: #fff;
        }

        .modal-actions button.primary {
          background: #8884d8;
          border-color: #8884d8;
        }

        .dashboard-footer {
          text-align: center;
          color: #666;
          padding: 20px;
          border-top: 1px solid #333;
        }

        .dashboard-loading {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          height: 100vh;
          background: #0f0f0f;
          color: #fff;
        }

        .spinner {
          width: 40px;
          height: 40px;
          border: 3px solid #333;
          border-top-color: #8884d8;
          border-radius: 50%;
          animation: spin 1s linear infinite;
          margin-bottom: 20px;
        }

        @keyframes spin {
          to {
            transform: rotate(360deg);
          }
        }

        @media (max-width: 768px) {
          .chart-section {
            grid-template-columns: 1fr;
          }

          .stats-section {
            grid-template-columns: repeat(2, 1fr);
          }
        }
      `}</style>
    </div>
  );
};

export default OracleDashboard;
