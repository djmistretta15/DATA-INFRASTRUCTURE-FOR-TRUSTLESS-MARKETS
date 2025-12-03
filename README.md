# Reclaim Oracle Indexer 🔗

**Secure, fast, ZK-backed data infrastructure layer for all DeFi and tokenized asset markets**

## 🎯 Objective

Build a trustless data aggregation and verification platform that provides fast, fraud-proof, and verifiable data access for decentralized markets.

## 🏗️ System Architecture

### Smart Contracts (`/oracle`)
- **FeedAggregator.sol** - Multi-source price aggregation with median-of-5 logic and slashing
- **SlashableOracleManager.sol** - Oracle staking, reputation, and slashing mechanism
- **zkTimestampVerifier.sol** - ZK-STARK timestamp and data integrity verification

### Indexers (`/data-indexer`, `/oracle-feeds`)
- Real-time DeFi protocol indexing (Uniswap, Aave, Compound, Curve)
- Historical volume and lending rate tracking
- Multi-chain support (Ethereum, Polygon, Arbitrum, Optimism, Base)

### ML Analytics (`/ml-anomaly-detector`)
- Anomaly detection using Isolation Forest
- Feed validation and fraud detection
- Governance intervention recommendations

### API Layer (`/analytics-api`)
- RESTful endpoints for oracle data and DeFi analytics
- Real-time WebSocket feeds
- Rate limiting and caching

### Frontend (`/dashboard-visuals`)
- Real-time oracle price monitoring
- DeFi protocol analytics dashboard
- Anomaly alert panel

### ZK Attestation (`/zk-timestamp-module`)
- ECDSA signature verification
- Poseidon-like commitments
- On-chain verification hashes

## 🔐 Security Features

- **Median-of-5 Logic**: Aggregate from ≥5 sources, use median price
- **Std Dev Capping**: Filter outliers beyond 2.5σ
- **Auto-Slashing**: Penalize oracles with >10% deviation
- **ZK Proofs**: Timestamp verification with 128-bit security
- **Stake Requirements**: 10-1000 ETH collateral per oracle

## 🚀 Quick Start

```bash
# Install dependencies
npm install
pip install -r requirements.txt

# Start API server
npm run api

# Start indexer
npm run indexer

# Launch dashboard
open dashboard-visuals/index.html
```

## 📡 Key Functions

### Oracle Aggregator
```javascript
// Get verified price with multi-source aggregation
const price = await getVerifiedPrice('ETH', feedAddresses);
// Returns: { price, median, stdDev, confidence, sources, verification }
```

### Historical Indexer
```javascript
// Get volume data over block range
const volume = await getHistoricalVolume('ethereum', 'ETH/USDC', startBlock, endBlock);
// Returns: { chain, pair, totalVolume, dataPoints, data }
```

### ZK Attestation
```python
# Create cryptographically signed attestation
attestation = engine.attest_feed('ETH/USD', 2145.67, 'chainlink')
# Returns: AttestationData with signature and commitment
```

## 🧪 Testing

```bash
# Oracle deviation test (auto-flag outliers)
npm test oracle-feed.test.ts

# ZK tamper replay test (reject invalid proofs)
npm test timestamp-zk.test.ts

# Anomaly detection test
python -m pytest ml/tests/anomaly.test.py
```

## 📊 Performance

- Oracle aggregation: <100ms
- ZK proof verification: <500ms
- Indexer throughput: 1000 blocks/min
- API response: <50ms (cached)

## 📚 Documentation

- [Oracle System](/oracle/README.md)
- [Indexer Architecture](/data-indexer/README.md)
- [ML Anomaly Detection](/ml-anomaly-detector/README.md)
- [API Reference](/analytics-api/README.md)
- [Dashboard Guide](/dashboard-visuals/README.md)

## 🤝 Contributing

Contributions welcome! Please read our [Contributing Guide](CONTRIBUTING.md) first.

## 📝 License

MIT License - See [LICENSE](LICENSE) for details

---

**Built for trustless, verifiable data in decentralized markets**