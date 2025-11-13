# Reclaim Oracle Indexer - Deployment Guide

This guide covers deploying the complete Reclaim Oracle Indexer infrastructure.

## Prerequisites

- **Node.js** >= 18.0.0
- **Python** >= 3.9
- **Docker** & Docker Compose
- **PostgreSQL** with TimescaleDB extension
- **Redis** >= 7.0
- **RPC endpoints** for target chains

## Quick Start (Docker)

### 1. Clone and Configure

```bash
git clone https://github.com/YOUR_ORG/DATA-INFRASTRUCTURE-FOR-TRUSTLESS-MARKETS.git
cd DATA-INFRASTRUCTURE-FOR-TRUSTLESS-MARKETS

# Copy and configure environment
cp .env.example .env
# Edit .env with your RPC endpoints and API keys
```

### 2. Start Infrastructure

```bash
# Start all services
npm run docker:up

# Check logs
npm run docker:logs

# Check service health
docker ps
```

### 3. Initialize Database

```bash
# Run migrations
npm run db:migrate

# Generate Prisma client
npm run db:generate

# Seed initial data (optional)
npm run db:seed
```

### 4. Access Services

- **REST API**: http://localhost:3000
- **GraphQL Playground**: http://localhost:4000/graphql
- **WebSocket**: ws://localhost:8080
- **Dashboard**: http://localhost:80
- **Grafana**: http://localhost:3001 (admin/admin)
- **Prometheus**: http://localhost:9090
- **Prisma Studio**: http://localhost:5555 (run `npm run db:studio`)

## Manual Deployment

### 1. Install Dependencies

```bash
# Node.js dependencies
npm install

# Python dependencies
pip install -r requirements.txt

# Generate Prisma client
npm run db:generate
```

### 2. Start Services Individually

```bash
# Terminal 1: API Server
npm run api

# Terminal 2: GraphQL Server
npm run graphql

# Terminal 3: WebSocket Server
npm run websocket

# Terminal 4: Token Indexer
npm run indexer

# Terminal 5: Liquidity Indexer
npm run indexer:liquidity

# Terminal 6: ML Anomaly Detector
npm run ml
```

## Smart Contract Deployment

### Local Development

```bash
# Start local Hardhat node
cd oracle
npx hardhat node

# In another terminal, deploy contracts
npm run deploy:local
```

### Testnet Deployment (Sepolia)

```bash
# Configure .env with testnet RPC
ETHEREUM_RPC=https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY

# Deploy
npm run deploy:testnet
```

### Mainnet Deployment

```bash
# ⚠️ CRITICAL: Audit contracts before mainnet deployment

# 1. Run security checks
cd oracle
npx hardhat test
npx hardhat coverage
npm run slither  # Static analysis

# 2. Deploy with verification
npx hardhat run scripts/deploy.ts --network mainnet

# 3. Verify contracts on Etherscan
npx hardhat verify --network mainnet DEPLOYED_ADDRESS
```

## Production Configuration

### Environment Variables

```bash
# Production .env
NODE_ENV=production
DATABASE_URL=postgresql://user:pass@prod-db:5432/reclaim
REDIS_URL=redis://:pass@prod-redis:6379

# Use secure passwords
POSTGRES_PASSWORD=$(openssl rand -base64 32)
REDIS_PASSWORD=$(openssl rand -base64 32)
JWT_SECRET=$(openssl rand -base64 64)
```

### SSL/TLS Configuration

```bash
# Generate SSL certificates
mkdir -p nginx/ssl
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout nginx/ssl/private.key \
  -out nginx/ssl/certificate.crt
```

### Nginx Configuration

See `nginx/nginx.conf` for load balancing and SSL termination.

## Monitoring Setup

### Grafana Dashboards

1. Access Grafana: http://localhost:3001
2. Login: admin/admin (change password)
3. Import dashboards from `monitoring/grafana/dashboards/`

### Prometheus Metrics

Metrics exposed on `/metrics` endpoint for each service:
- API: http://localhost:3000/metrics
- GraphQL: http://localhost:4000/metrics
- WebSocket: http://localhost:8081/health

### Alerting Rules

Edit `monitoring/prometheus/alerts.yml` to configure alerts:
- Price deviation > 5%
- API latency > 500ms
- Oracle down > 5 minutes
- ZK verification failures

## Scaling

### Horizontal Scaling

```yaml
# docker-compose.yml
indexer-token:
  deploy:
    replicas: 3  # Run 3 instances
```

### Database Optimization

```sql
-- Create indexes for frequent queries
CREATE INDEX CONCURRENTLY idx_price_feeds_timestamp
  ON price_feeds (timestamp DESC);

-- Enable TimescaleDB hypertables
SELECT create_hypertable('price_feeds', 'timestamp');

-- Set up continuous aggregates
CREATE MATERIALIZED VIEW price_feeds_hourly
WITH (timescaledb.continuous) AS
SELECT time_bucket('1 hour', timestamp) AS hour,
       token_id,
       AVG(price) as avg_price,
       MAX(price) as max_price,
       MIN(price) as min_price
FROM price_feeds
GROUP BY hour, token_id;
```

### Redis Clustering

For high availability, set up Redis Cluster or Sentinel mode.

## Backup & Recovery

### Database Backups

```bash
# Automated daily backups
0 2 * * * pg_dump reclaim_oracle | gzip > /backups/db-$(date +\%Y\%m\%d).sql.gz

# Restore from backup
gunzip < backup.sql.gz | psql reclaim_oracle
```

### Smart Contract Migration

Use OpenZeppelin's upgradeable contracts pattern for safe upgrades.

## Health Checks

### API Health

```bash
curl http://localhost:3000/health
```

Expected response:
```json
{
  "status": "healthy",
  "timestamp": 1699876543210,
  "uptime": 86400,
  "version": "2.0.0"
}
```

### Database Health

```bash
docker exec reclaim-timescaledb pg_isready
```

### Service Dependencies

```bash
# Check all services
docker-compose ps

# Check logs for errors
docker-compose logs --tail=100 api
```

## Troubleshooting

### Port Conflicts

```bash
# Check if ports are in use
lsof -i :3000  # API
lsof -i :4000  # GraphQL
lsof -i :8080  # WebSocket

# Kill process on port
kill -9 $(lsof -ti:3000)
```

### Database Connection Issues

```bash
# Test connection
docker exec reclaim-timescaledb psql -U reclaim -d reclaim_oracle -c '\dt'

# Reset database
npm run docker:down
docker volume rm reclaim-oracle-indexer_timescale-data
npm run docker:up
npm run db:migrate
```

### Memory Issues

```bash
# Increase Docker memory limit
# Docker Desktop > Settings > Resources > Memory: 8GB+

# Increase Node.js memory
NODE_OPTIONS=--max-old-space-size=4096 npm run api
```

## Security Checklist

- [ ] Change all default passwords
- [ ] Enable SSL/TLS for all services
- [ ] Configure firewall rules
- [ ] Set up rate limiting
- [ ] Enable audit logging
- [ ] Regular security updates
- [ ] Smart contract audit completed
- [ ] Penetration testing completed
- [ ] Implement key rotation
- [ ] Set up intrusion detection

## Performance Optimization

### API Caching

```typescript
// Redis caching strategy
const cacheMiddleware = async (req, res, next) => {
  const key = `cache:${req.path}`;
  const cached = await redis.get(key);

  if (cached) {
    return res.json(JSON.parse(cached));
  }

  // ... fetch data
  await redis.setEx(key, 60, JSON.stringify(data));
};
```

### Database Query Optimization

```sql
-- Analyze query performance
EXPLAIN ANALYZE
SELECT * FROM price_feeds
WHERE token_id = 'ETH'
  AND timestamp > NOW() - INTERVAL '24 hours';

-- Create partial indexes
CREATE INDEX idx_recent_prices
  ON price_feeds (token_id, timestamp DESC)
  WHERE timestamp > NOW() - INTERVAL '7 days';
```

## Maintenance

### Regular Tasks

- Daily: Check logs, monitor alerts
- Weekly: Review performance metrics, update dependencies
- Monthly: Database vacuum, backup verification
- Quarterly: Security audit, disaster recovery test

### Updates

```bash
# Update dependencies
npm update
npm audit fix

# Update Docker images
docker-compose pull
docker-compose up -d
```

## Support

For issues and questions:
- GitHub Issues: https://github.com/YOUR_ORG/DATA-INFRASTRUCTURE-FOR-TRUSTLESS-MARKETS/issues
- Discord: https://discord.gg/reclaim
- Documentation: https://docs.reclaim-oracle.io
