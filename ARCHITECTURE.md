# Reclaim Oracle Infrastructure - Architecture Documentation

## System Overview

Production-grade, ZK-backed data infrastructure for DeFi and tokenized asset markets. This system provides secure, real-time oracle feeds with ML-powered anomaly detection, comprehensive monitoring, and decentralized governance.

## Architecture Layers

### 1. Data Ingestion Layer
- **Oracle Feeds**: Multi-source price aggregation with median-of-5 logic
- **ZK Timestamp Verification**: STARK proofs for data integrity
- **Chain Indexers**: Real-time blockchain event tracking
- **Rate Limiting**: Per-oracle request throttling

### 2. Processing Layer
- **Price Aggregation Engine**: Outlier filtering, standard deviation capping
- **Anomaly Detection Pipeline**: Isolation Forest ensemble models
- **Circuit Breaker System**: Automatic feed protection with TWAP validation
- **MEV Protection**: Sandwich attack and frontrunning detection

### 3. Storage Layer
- **TimescaleDB**: Time-series optimized PostgreSQL for historical data
- **Redis**: Real-time caching and pub/sub messaging
- **Persistent Volumes**: Durable storage for ML models and state

### 4. API Layer
- **REST API**: Oracle queries, price history, statistics
- **GraphQL**: Flexible querying with subscriptions
- **WebSocket**: Real-time price updates and alerts
- **gRPC**: High-performance ML model serving

### 5. Frontend Layer
- **Oracle Dashboard**: Real-time monitoring and visualization
- **Anomaly Panel**: Alert management and circuit breaker controls
- **Governance Portal**: Proposal voting and delegation

### 6. Governance Layer
- **On-chain Voting**: Token-weighted proposal system
- **Timelock Execution**: Delayed execution for security
- **Delegation**: Vote power transfer mechanism
- **Guardian Controls**: Emergency intervention capabilities

## Deployment Architecture

```
                                    ┌─────────────────┐
                                    │   Cloudflare    │
                                    │   CDN/WAF       │
                                    └────────┬────────┘
                                             │
                                    ┌────────▼────────┐
                                    │  Nginx Ingress  │
                                    │  Load Balancer  │
                                    └────────┬────────┘
                                             │
                    ┌────────────────────────┼────────────────────────┐
                    │                        │                        │
           ┌────────▼────────┐     ┌────────▼────────┐     ┌────────▼────────┐
           │   REST API      │     │  GraphQL Server │     │  WebSocket      │
           │   (3 replicas)  │     │   (2 replicas)  │     │   (2 replicas)  │
           └────────┬────────┘     └────────┬────────┘     └────────┬────────┘
                    │                        │                        │
                    └────────────────────────┼────────────────────────┘
                                             │
                    ┌────────────────────────┼────────────────────────┐
                    │                        │                        │
           ┌────────▼────────┐     ┌────────▼────────┐     ┌────────▼────────┐
           │   TimescaleDB   │     │     Redis       │     │   ML Models     │
           │   (Primary)     │     │   (Sentinel)    │     │   (PVC Store)   │
           └─────────────────┘     └─────────────────┘     └─────────────────┘
                    │
           ┌────────▼────────┐
           │   Indexers      │
           │ Token/Lending   │
           └─────────────────┘
```

## Security Architecture

### Zero-Trust Model
1. **Network Policies**: Default deny with explicit allow rules
2. **mTLS**: Service-to-service encryption
3. **RBAC**: Role-based access control for all operations
4. **Secret Management**: Kubernetes secrets with encryption at rest

### Oracle Security
1. **ZK Proofs**: Timestamp and data verification
2. **Reputation System**: Oracle scoring and slashing
3. **Circuit Breakers**: Automatic feed protection
4. **MEV Protection**: Frontrunning and sandwich attack detection

### Smart Contract Security
1. **Access Control**: Role-based permissions (OpenZeppelin)
2. **Reentrancy Guards**: Protection against reentrancy attacks
3. **Pausable**: Emergency stop functionality
4. **Timelock**: Delayed execution for governance actions

## Data Flow

### Price Update Flow
```
1. Oracle submits price → Signature verification
2. ZK proof validation → Timestamp integrity check
3. Deviation analysis → Compare against historical data
4. MEV protection check → Detect manipulation patterns
5. Circuit breaker evaluation → Check feed health
6. Aggregation → Median calculation with outlier removal
7. Storage → TimescaleDB and Redis cache
8. Broadcast → WebSocket and pub/sub channels
9. ML analysis → Real-time anomaly scoring
10. Alert generation → Multi-channel notifications
```

### Anomaly Detection Flow
```
1. Feature extraction → 100+ technical indicators
2. Preprocessing → Standardization, PCA reduction
3. Ensemble inference → Isolation Forest + LOF + OCSVM
4. Score aggregation → Weighted voting
5. Alert generation → Severity classification
6. Notification dispatch → Telegram, Slack, webhooks
7. Circuit breaker decision → Automatic protection
8. Storage → Audit trail in database
```

## Scaling Strategy

### Horizontal Scaling
- **API Services**: Auto-scale 3-20 replicas based on CPU/memory
- **WebSocket**: Scale based on connection count
- **ML Inference**: Scale based on queue depth
- **Indexers**: Single replica per chain (stateful)

### Vertical Scaling
- **TimescaleDB**: Start with 2GB RAM, scale to 8GB+
- **Redis**: 512MB to 3GB based on cache usage
- **ML Models**: 2-8GB RAM for large model ensembles

### Data Retention
- **Hot Data**: Last 7 days in Redis cache
- **Warm Data**: Last 30 days in TimescaleDB with compression
- **Cold Data**: Archive to object storage after 30 days

## Monitoring & Observability

### Metrics
- **Application**: Request rate, latency, error rate
- **Oracle**: Price deviation, source count, update frequency
- **ML**: Inference latency, anomaly rate, model drift
- **Infrastructure**: CPU, memory, disk, network

### Alerting
- **Critical**: API down, circuit breaker trip, high anomaly rate
- **Warning**: High latency, low source count, replication lag
- **Info**: Model retraining, configuration changes

### SLOs
- **API Availability**: 99.9%
- **Feed Freshness**: 95% of feeds < 60s old
- **Inference Latency**: p95 < 1s
- **Error Budget**: 0.1% monthly

## Disaster Recovery

### Backup Strategy
1. **Database**: Hourly incremental, daily full backups
2. **Redis**: AOF persistence with hourly snapshots
3. **ML Models**: Version controlled in PVC
4. **Configurations**: GitOps with sealed secrets

### Recovery Procedures
1. **Pod Failure**: Automatic restart with liveness probes
2. **Node Failure**: Pod rescheduling via Kubernetes
3. **Zone Failure**: Multi-AZ deployment with PDBs
4. **Region Failure**: Active-passive failover (not yet implemented)

## Performance Characteristics

### Latency Targets
- **Price Query**: < 50ms (p95)
- **GraphQL Query**: < 200ms (p95)
- **WebSocket Broadcast**: < 100ms
- **ML Inference**: < 1000ms (batch of 100)

### Throughput
- **API**: 10,000 requests/second
- **WebSocket**: 10,000 concurrent connections
- **Indexer**: 1,000 events/second per chain
- **ML Pipeline**: 100 inferences/second

## Future Enhancements

### Phase 2 (Q2 2025)
- [ ] Multi-region deployment with global load balancing
- [ ] Advanced ML models (transformers, graph neural networks)
- [ ] Cross-chain oracle aggregation
- [ ] DAO treasury management

### Phase 3 (Q3 2025)
- [ ] Decentralized storage (IPFS/Arweave integration)
- [ ] ZK-rollup for gas optimization
- [ ] Privacy-preserving analytics
- [ ] Automated market making integration

## Quick Start

```bash
# 1. Apply Kubernetes manifests
kubectl apply -k k8s/overlays/production

# 2. Initialize database
kubectl exec -it timescaledb-0 -- psql -U reclaim -d reclaim_oracle -f /init.sql

# 3. Deploy ML models
kubectl cp ./models ml-model-server-0:/models/

# 4. Verify deployment
kubectl get pods -n reclaim-oracle
kubectl get svc -n reclaim-oracle

# 5. Check health
curl https://api.oracle.reclaim.network/health
```

## Contact

- **Architecture Questions**: architecture@reclaim.network
- **Security Issues**: security@reclaim.network
- **On-Call Support**: oncall@reclaim.network
