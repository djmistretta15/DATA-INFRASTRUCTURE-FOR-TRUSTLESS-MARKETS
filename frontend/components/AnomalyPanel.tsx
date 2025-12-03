import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useQuery, useMutation, useSubscription } from '@apollo/client';
import { gql } from '@apollo/client';
import { ScatterChart, Scatter, XAxis, YAxis, ZAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';

/**
 * Anomaly Panel - Real-time anomaly detection monitoring
 * Displays ML-detected anomalies with filtering and actions
 * 800 LoC as specified
 */

// GraphQL Operations
const GET_ANOMALIES = gql`
  query GetAnomalies($feedName: String, $minScore: Float, $from: DateTime, $to: DateTime) {
    anomalies(feedName: $feedName, minScore: $minScore, startTime: $from, endTime: $to) {
      id
      feedName
      anomalyScore
      severity
      description
      timestamp
      isAcknowledged
      acknowledgedBy
    }
  }
`;

const SUBSCRIBE_ANOMALY = gql`
  subscription OnAnomalyDetected($feedName: String) {
    anomalyDetected(feedName: $feedName) {
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
      acknowledgedAt
    }
  }
`;

const ACTIVATE_CIRCUIT_BREAKER = gql`
  mutation ActivateCircuitBreaker($feedName: String!, $reason: String!) {
    activateCircuitBreaker(feedName: $feedName, reason: $reason) {
      success
      feedName
      timestamp
    }
  }
`;

// Types
interface Anomaly {
  id: string;
  feedName: string;
  anomalyScore: number;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  description: string;
  timestamp: string;
  isAcknowledged: boolean;
  acknowledgedBy?: string;
}

interface Filter {
  feedName: string;
  minScore: number;
  severity: string[];
  timeRange: string;
  showAcknowledged: boolean;
}

const AnomalyPanel: React.FC = () => {
  const [filter, setFilter] = useState<Filter>({
    feedName: '',
    minScore: 0.5,
    severity: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
    timeRange: '24h',
    showAcknowledged: true
  });

  const [selectedAnomaly, setSelectedAnomaly] = useState<Anomaly | null>(null);
  const [actionModal, setActionModal] = useState<'acknowledge' | 'circuit' | null>(null);
  const [actionNotes, setActionNotes] = useState('');
  const [liveAnomalies, setLiveAnomalies] = useState<Anomaly[]>([]);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Calculate time range
  const getTimeRange = () => {
    const now = new Date();
    const ranges: Record<string, number> = {
      '1h': 3600000,
      '6h': 21600000,
      '24h': 86400000,
      '7d': 604800000
    };
    const from = new Date(now.getTime() - (ranges[filter.timeRange] || 86400000));
    return { from, to: now };
  };

  const { from, to } = getTimeRange();

  // Queries
  const { data, loading, refetch } = useQuery(GET_ANOMALIES, {
    variables: {
      feedName: filter.feedName || undefined,
      minScore: filter.minScore,
      from: from.toISOString(),
      to: to.toISOString()
    },
    pollInterval: 60000
  });

  // Subscription
  useSubscription(SUBSCRIBE_ANOMALY, {
    variables: { feedName: filter.feedName || undefined },
    onSubscriptionData: ({ subscriptionData }) => {
      const newAnomaly = subscriptionData.data?.anomalyDetected;
      if (newAnomaly && newAnomaly.anomalyScore >= filter.minScore) {
        setLiveAnomalies(prev => [newAnomaly, ...prev.slice(0, 19)]);

        // Play alert sound
        if (soundEnabled && newAnomaly.severity === 'CRITICAL') {
          playAlertSound();
        }
      }
    }
  });

  // Mutations
  const [acknowledgeAnomaly] = useMutation(ACKNOWLEDGE_ANOMALY);
  const [activateCircuitBreaker] = useMutation(ACTIVATE_CIRCUIT_BREAKER);

  // Alert sound
  const playAlertSound = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.play().catch(console.error);
    }
  }, []);

  // Handlers
  const handleFilterChange = (key: keyof Filter, value: any) => {
    setFilter(prev => ({ ...prev, [key]: value }));
  };

  const handleSeverityToggle = (severity: string) => {
    setFilter(prev => ({
      ...prev,
      severity: prev.severity.includes(severity)
        ? prev.severity.filter(s => s !== severity)
        : [...prev.severity, severity]
    }));
  };

  const handleAcknowledge = async () => {
    if (!selectedAnomaly) return;

    try {
      await acknowledgeAnomaly({
        variables: {
          anomalyId: selectedAnomaly.id,
          notes: actionNotes
        }
      });
      setActionModal(null);
      setActionNotes('');
      setSelectedAnomaly(null);
      refetch();
    } catch (error) {
      console.error('Acknowledge failed:', error);
    }
  };

  const handleCircuitBreaker = async () => {
    if (!selectedAnomaly) return;

    try {
      await activateCircuitBreaker({
        variables: {
          feedName: selectedAnomaly.feedName,
          reason: actionNotes || selectedAnomaly.description
        }
      });
      setActionModal(null);
      setActionNotes('');
    } catch (error) {
      console.error('Circuit breaker activation failed:', error);
    }
  };

  // Data processing
  const anomalies: Anomaly[] = data?.anomalies || [];

  const filteredAnomalies = anomalies.filter(a => {
    if (!filter.severity.includes(a.severity)) return false;
    if (!filter.showAcknowledged && a.isAcknowledged) return false;
    return true;
  });

  const severityCounts = {
    CRITICAL: filteredAnomalies.filter(a => a.severity === 'CRITICAL').length,
    HIGH: filteredAnomalies.filter(a => a.severity === 'HIGH').length,
    MEDIUM: filteredAnomalies.filter(a => a.severity === 'MEDIUM').length,
    LOW: filteredAnomalies.filter(a => a.severity === 'LOW').length
  };

  const scatterData = filteredAnomalies.map(a => ({
    x: new Date(a.timestamp).getTime(),
    y: a.anomalyScore,
    z: a.severity === 'CRITICAL' ? 100 : a.severity === 'HIGH' ? 75 : a.severity === 'MEDIUM' ? 50 : 25,
    severity: a.severity,
    id: a.id
  }));

  const severityColors: Record<string, string> = {
    CRITICAL: '#FF0000',
    HIGH: '#FF6600',
    MEDIUM: '#FF9900',
    LOW: '#FFCC00'
  };

  return (
    <div className="anomaly-panel">
      <audio ref={audioRef} src="/alert.mp3" preload="auto" />

      <header className="panel-header">
        <h2>Anomaly Detection Monitor</h2>
        <div className="header-actions">
          <button
            className={`sound-toggle ${soundEnabled ? 'enabled' : ''}`}
            onClick={() => setSoundEnabled(!soundEnabled)}
          >
            {soundEnabled ? '🔊' : '🔇'} Alerts
          </button>
          <button onClick={() => refetch()} className="refresh-btn">
            ↻ Refresh
          </button>
        </div>
      </header>

      {/* Filters */}
      <section className="filters-section">
        <div className="filter-group">
          <label>Feed Name</label>
          <input
            type="text"
            placeholder="All feeds"
            value={filter.feedName}
            onChange={e => handleFilterChange('feedName', e.target.value)}
          />
        </div>

        <div className="filter-group">
          <label>Min Score</label>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={filter.minScore}
            onChange={e => handleFilterChange('minScore', parseFloat(e.target.value))}
          />
          <span>{filter.minScore.toFixed(2)}</span>
        </div>

        <div className="filter-group">
          <label>Time Range</label>
          <select
            value={filter.timeRange}
            onChange={e => handleFilterChange('timeRange', e.target.value)}
          >
            <option value="1h">Last Hour</option>
            <option value="6h">Last 6 Hours</option>
            <option value="24h">Last 24 Hours</option>
            <option value="7d">Last 7 Days</option>
          </select>
        </div>

        <div className="filter-group severity-filters">
          <label>Severity</label>
          <div className="severity-toggles">
            {['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map(severity => (
              <button
                key={severity}
                className={`severity-btn ${filter.severity.includes(severity) ? 'active' : ''}`}
                style={{
                  borderColor: severityColors[severity],
                  backgroundColor: filter.severity.includes(severity) ? severityColors[severity] : 'transparent'
                }}
                onClick={() => handleSeverityToggle(severity)}
              >
                {severity} ({severityCounts[severity as keyof typeof severityCounts]})
              </button>
            ))}
          </div>
        </div>

        <div className="filter-group">
          <label>
            <input
              type="checkbox"
              checked={filter.showAcknowledged}
              onChange={e => handleFilterChange('showAcknowledged', e.target.checked)}
            />
            Show Acknowledged
          </label>
        </div>
      </section>

      {/* Statistics */}
      <section className="stats-bar">
        <div className="stat">
          <span className="stat-label">Total</span>
          <span className="stat-value">{filteredAnomalies.length}</span>
        </div>
        <div className="stat critical">
          <span className="stat-label">Critical</span>
          <span className="stat-value">{severityCounts.CRITICAL}</span>
        </div>
        <div className="stat high">
          <span className="stat-label">High</span>
          <span className="stat-value">{severityCounts.HIGH}</span>
        </div>
        <div className="stat medium">
          <span className="stat-label">Medium</span>
          <span className="stat-value">{severityCounts.MEDIUM}</span>
        </div>
        <div className="stat low">
          <span className="stat-label">Low</span>
          <span className="stat-value">{severityCounts.LOW}</span>
        </div>
      </section>

      {/* Scatter Plot */}
      <section className="chart-section">
        <h3>Anomaly Distribution</h3>
        <ResponsiveContainer width="100%" height={300}>
          <ScatterChart margin={{ top: 20, right: 20, bottom: 20, left: 20 }}>
            <XAxis
              type="number"
              dataKey="x"
              name="Time"
              domain={['dataMin', 'dataMax']}
              tickFormatter={(t) => new Date(t).toLocaleTimeString()}
            />
            <YAxis type="number" dataKey="y" name="Score" domain={[0, 1]} />
            <ZAxis type="number" dataKey="z" range={[50, 400]} />
            <Tooltip
              cursor={{ strokeDasharray: '3 3' }}
              formatter={(value: number, name: string) => {
                if (name === 'Time') return new Date(value).toLocaleString();
                if (name === 'Score') return value.toFixed(4);
                return value;
              }}
            />
            <Scatter name="Anomalies" data={scatterData}>
              {scatterData.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={severityColors[entry.severity]} />
              ))}
            </Scatter>
          </ScatterChart>
        </ResponsiveContainer>
      </section>

      {/* Live Alerts */}
      {liveAnomalies.length > 0 && (
        <section className="live-alerts">
          <h3>🔴 Live Alerts</h3>
          <div className="live-list">
            {liveAnomalies.map(anomaly => (
              <div
                key={anomaly.id}
                className={`live-alert severity-${anomaly.severity.toLowerCase()}`}
                onClick={() => setSelectedAnomaly(anomaly)}
              >
                <span className="badge" style={{ backgroundColor: severityColors[anomaly.severity] }}>
                  {anomaly.severity}
                </span>
                <span className="feed">{anomaly.feedName}</span>
                <span className="score">{anomaly.anomalyScore.toFixed(3)}</span>
                <span className="time">
                  {new Date(anomaly.timestamp).toLocaleTimeString()}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Anomaly List */}
      <section className="anomaly-list">
        <h3>Historical Anomalies</h3>
        {loading ? (
          <div className="loading">Loading...</div>
        ) : (
          <div className="list-container">
            {filteredAnomalies.map(anomaly => (
              <div
                key={anomaly.id}
                className={`anomaly-item ${anomaly.isAcknowledged ? 'acknowledged' : ''}`}
                onClick={() => setSelectedAnomaly(anomaly)}
              >
                <div className="item-header">
                  <span
                    className="severity-indicator"
                    style={{ backgroundColor: severityColors[anomaly.severity] }}
                  />
                  <span className="feed-name">{anomaly.feedName}</span>
                  <span className="score">
                    Score: <strong>{anomaly.anomalyScore.toFixed(4)}</strong>
                  </span>
                  <span className="timestamp">
                    {new Date(anomaly.timestamp).toLocaleString()}
                  </span>
                </div>
                <div className="item-body">
                  <p className="description">{anomaly.description}</p>
                </div>
                {anomaly.isAcknowledged && (
                  <div className="acknowledged-info">
                    ✓ Acknowledged by {anomaly.acknowledgedBy}
                  </div>
                )}
              </div>
            ))}

            {filteredAnomalies.length === 0 && (
              <div className="no-results">No anomalies found matching filters</div>
            )}
          </div>
        )}
      </section>

      {/* Detail Modal */}
      {selectedAnomaly && !actionModal && (
        <div className="modal-overlay" onClick={() => setSelectedAnomaly(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Anomaly Details</h3>
              <button onClick={() => setSelectedAnomaly(null)}>×</button>
            </div>

            <div className="modal-body">
              <div className="detail-row">
                <label>Feed:</label>
                <span>{selectedAnomaly.feedName}</span>
              </div>
              <div className="detail-row">
                <label>Severity:</label>
                <span
                  className="severity-badge"
                  style={{ backgroundColor: severityColors[selectedAnomaly.severity] }}
                >
                  {selectedAnomaly.severity}
                </span>
              </div>
              <div className="detail-row">
                <label>Score:</label>
                <span>{selectedAnomaly.anomalyScore.toFixed(6)}</span>
              </div>
              <div className="detail-row">
                <label>Time:</label>
                <span>{new Date(selectedAnomaly.timestamp).toLocaleString()}</span>
              </div>
              <div className="detail-row">
                <label>Description:</label>
                <p>{selectedAnomaly.description}</p>
              </div>
              <div className="detail-row">
                <label>Status:</label>
                <span>
                  {selectedAnomaly.isAcknowledged ? 'Acknowledged' : 'Pending'}
                </span>
              </div>
            </div>

            <div className="modal-actions">
              {!selectedAnomaly.isAcknowledged && (
                <button
                  onClick={() => setActionModal('acknowledge')}
                  className="action-btn acknowledge"
                >
                  Acknowledge
                </button>
              )}
              {selectedAnomaly.severity === 'CRITICAL' && (
                <button
                  onClick={() => setActionModal('circuit')}
                  className="action-btn circuit"
                >
                  Activate Circuit Breaker
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Action Modals */}
      {actionModal && (
        <div className="modal-overlay">
          <div className="modal">
            <div className="modal-header">
              <h3>
                {actionModal === 'acknowledge'
                  ? 'Acknowledge Anomaly'
                  : 'Activate Circuit Breaker'}
              </h3>
              <button onClick={() => setActionModal(null)}>×</button>
            </div>

            <div className="modal-body">
              <textarea
                placeholder={
                  actionModal === 'acknowledge'
                    ? 'Add notes about this acknowledgment...'
                    : 'Reason for activating circuit breaker...'
                }
                value={actionNotes}
                onChange={e => setActionNotes(e.target.value)}
              />
            </div>

            <div className="modal-actions">
              <button onClick={() => setActionModal(null)} className="cancel-btn">
                Cancel
              </button>
              <button
                onClick={actionModal === 'acknowledge' ? handleAcknowledge : handleCircuitBreaker}
                className={`confirm-btn ${actionModal === 'circuit' ? 'danger' : ''}`}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      <style jsx>{`
        .anomaly-panel {
          background: #0f0f0f;
          color: #fff;
          padding: 20px;
          border-radius: 12px;
          border: 1px solid #333;
        }

        .panel-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 20px;
        }

        .panel-header h2 {
          font-size: 20px;
          font-weight: 600;
        }

        .header-actions {
          display: flex;
          gap: 10px;
        }

        .sound-toggle,
        .refresh-btn {
          background: #1a1a1a;
          border: 1px solid #333;
          color: #fff;
          padding: 8px 12px;
          border-radius: 6px;
          cursor: pointer;
        }

        .sound-toggle.enabled {
          border-color: #4CAF50;
          color: #4CAF50;
        }

        .filters-section {
          display: flex;
          flex-wrap: wrap;
          gap: 15px;
          margin-bottom: 20px;
          padding: 15px;
          background: #1a1a1a;
          border-radius: 8px;
        }

        .filter-group {
          display: flex;
          flex-direction: column;
          gap: 5px;
        }

        .filter-group label {
          font-size: 12px;
          color: #888;
        }

        .filter-group input[type="text"],
        .filter-group select {
          background: #0f0f0f;
          border: 1px solid #333;
          color: #fff;
          padding: 8px;
          border-radius: 4px;
        }

        .filter-group input[type="range"] {
          width: 150px;
        }

        .severity-toggles {
          display: flex;
          gap: 5px;
        }

        .severity-btn {
          padding: 4px 8px;
          border: 1px solid;
          border-radius: 4px;
          background: transparent;
          color: #fff;
          cursor: pointer;
          font-size: 11px;
        }

        .severity-btn.active {
          color: #000;
        }

        .stats-bar {
          display: flex;
          gap: 20px;
          margin-bottom: 20px;
        }

        .stat {
          background: #1a1a1a;
          padding: 10px 20px;
          border-radius: 6px;
          text-align: center;
        }

        .stat.critical {
          border-left: 3px solid #FF0000;
        }
        .stat.high {
          border-left: 3px solid #FF6600;
        }
        .stat.medium {
          border-left: 3px solid #FF9900;
        }
        .stat.low {
          border-left: 3px solid #FFCC00;
        }

        .stat-label {
          font-size: 12px;
          color: #888;
          display: block;
        }

        .stat-value {
          font-size: 24px;
          font-weight: 700;
        }

        .chart-section {
          background: #1a1a1a;
          padding: 15px;
          border-radius: 8px;
          margin-bottom: 20px;
        }

        .chart-section h3 {
          margin-bottom: 15px;
          font-size: 16px;
        }

        .live-alerts {
          margin-bottom: 20px;
        }

        .live-alerts h3 {
          color: #FF0000;
          margin-bottom: 10px;
        }

        .live-alert {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 10px;
          background: #1a1a1a;
          border-radius: 6px;
          margin-bottom: 5px;
          cursor: pointer;
          animation: pulse 2s infinite;
        }

        @keyframes pulse {
          0% {
            box-shadow: 0 0 0 0 rgba(255, 0, 0, 0.4);
          }
          70% {
            box-shadow: 0 0 0 10px rgba(255, 0, 0, 0);
          }
          100% {
            box-shadow: 0 0 0 0 rgba(255, 0, 0, 0);
          }
        }

        .badge {
          padding: 2px 6px;
          border-radius: 3px;
          font-size: 10px;
          font-weight: 600;
        }

        .anomaly-list h3 {
          margin-bottom: 15px;
        }

        .anomaly-item {
          background: #1a1a1a;
          border-radius: 8px;
          padding: 15px;
          margin-bottom: 10px;
          cursor: pointer;
          transition: transform 0.2s;
        }

        .anomaly-item:hover {
          transform: translateX(5px);
        }

        .anomaly-item.acknowledged {
          opacity: 0.6;
        }

        .item-header {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-bottom: 10px;
        }

        .severity-indicator {
          width: 12px;
          height: 12px;
          border-radius: 50%;
        }

        .feed-name {
          font-weight: 600;
        }

        .score {
          margin-left: auto;
        }

        .timestamp {
          color: #888;
          font-size: 12px;
        }

        .description {
          color: #ccc;
          font-size: 14px;
        }

        .acknowledged-info {
          color: #4CAF50;
          font-size: 12px;
          margin-top: 10px;
        }

        .no-results {
          text-align: center;
          color: #888;
          padding: 40px;
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
          z-index: 1000;
        }

        .modal {
          background: #1a1a1a;
          border: 1px solid #333;
          border-radius: 12px;
          width: 500px;
          max-width: 90%;
        }

        .modal-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 15px 20px;
          border-bottom: 1px solid #333;
        }

        .modal-header button {
          background: none;
          border: none;
          color: #888;
          font-size: 24px;
          cursor: pointer;
        }

        .modal-body {
          padding: 20px;
        }

        .detail-row {
          margin-bottom: 15px;
        }

        .detail-row label {
          color: #888;
          display: block;
          margin-bottom: 5px;
          font-size: 12px;
        }

        .severity-badge {
          padding: 4px 8px;
          border-radius: 4px;
          font-size: 12px;
          font-weight: 600;
        }

        .modal-body textarea {
          width: 100%;
          background: #0f0f0f;
          border: 1px solid #333;
          color: #fff;
          padding: 10px;
          border-radius: 6px;
          min-height: 100px;
          resize: vertical;
        }

        .modal-actions {
          padding: 15px 20px;
          display: flex;
          gap: 10px;
          justify-content: flex-end;
          border-top: 1px solid #333;
        }

        .action-btn {
          padding: 8px 16px;
          border: none;
          border-radius: 6px;
          cursor: pointer;
          font-weight: 600;
        }

        .action-btn.acknowledge {
          background: #4CAF50;
          color: #fff;
        }

        .action-btn.circuit {
          background: #FF5722;
          color: #fff;
        }

        .cancel-btn {
          background: #333;
          color: #fff;
          padding: 8px 16px;
          border: none;
          border-radius: 6px;
          cursor: pointer;
        }

        .confirm-btn {
          background: #4CAF50;
          color: #fff;
          padding: 8px 16px;
          border: none;
          border-radius: 6px;
          cursor: pointer;
        }

        .confirm-btn.danger {
          background: #FF5722;
        }

        .loading {
          text-align: center;
          padding: 40px;
          color: #888;
        }
      `}</style>
    </div>
  );
};

export default AnomalyPanel;
