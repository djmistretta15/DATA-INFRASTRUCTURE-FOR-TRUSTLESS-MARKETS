# Analytics API

RESTful API server exposing oracle data, DeFi analytics, historical indexing, and attestation services.

## Features

- **Oracle Endpoints**: Verified price feeds, cached data, slashing history
- **Indexer Endpoints**: Block data, historical volumes, lending rates
- **Analytics Endpoints**: Cross-chain comparisons, protocol summaries
- **Attestation Endpoints**: Data verification and commitments
- **Batch Operations**: Multi-token price queries
- **Rate Limiting**: Configurable request throttling
- **Caching**: Built-in response caching
- **Security**: Helmet.js, CORS, compression

## Installation

```bash
npm install
```

## Usage

### Start Server

```bash
node analytics-api/src/server.js
# or
npm run api
```

Server will start on `http://localhost:3000`

## API Endpoints

### Health Check

```bash
GET /health
```

**Response:**
```json
{
  "status": "healthy",
  "timestamp": 1699876543210,
  "uptime": 1234.56,
  "version": "1.0.0"
}
```

### Oracle Endpoints

#### Get Verified Price

```bash
GET /api/oracle/price/:token?chainlink=ADDRESS&pyth=PRICEID
```

**Example:**
```bash
curl "http://localhost:3000/api/oracle/price/ETH?chainlink=0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419"
```

**Response:**
```json
{
  "success": true,
  "data": {
    "token": "ETH",
    "price": 2145.67,
    "median": 2145.50,
    "stdDev": 5.23,
    "confidence": 0.93,
    "timestamp": 1699876543210,
    "sources": [...],
    "verification": {
      "zkProofHash": "0x1234...",
      "signatureHash": "0x5678..."
    }
  }
}
```

#### Get Cached Price

```bash
GET /api/oracle/cached/:token
```

#### Get Slashing History

```bash
GET /api/oracle/slashing/:source?token=SYMBOL
```

### Indexer Endpoints

#### Get Block Data

```bash
GET /api/indexer/block/:chain/:blockNumber
```

**Example:**
```bash
curl "http://localhost:3000/api/indexer/block/ethereum/18500000"
```

#### Get Historical Volume

```bash
GET /api/indexer/volume/:chain/:pair?startBlock=START&endBlock=END
```

**Example:**
```bash
curl "http://localhost:3000/api/indexer/volume/ethereum/ETH-USDC?startBlock=18400000&endBlock=18500000"
```

**Response:**
```json
{
  "success": true,
  "data": {
    "chain": "ethereum",
    "pair": "ETH-USDC",
    "startBlock": 18400000,
    "endBlock": 18500000,
    "dataPoints": 7200,
    "totalVolume": 1500000000,
    "data": [...]
  }
}
```

#### Get Lending Rates

```bash
GET /api/indexer/rates/:chain/:protocol/:asset?startBlock=START&endBlock=END
```

**Example:**
```bash
curl "http://localhost:3000/api/indexer/rates/ethereum/aave/USDC?startBlock=18400000&endBlock=18500000"
```

#### Get Current State

```bash
GET /api/indexer/state/:chain
```

#### Export Time Series

```bash
POST /api/indexer/export
Content-Type: application/json

{
  "chain": "ethereum",
  "startBlock": 18400000,
  "endBlock": 18500000,
  "outputPath": "./data/export.json"
}
```

### Analytics Endpoints

#### Get Chain Summary

```bash
GET /api/analytics/summary/:chain
```

**Response:**
```json
{
  "success": true,
  "data": {
    "chain": "ethereum",
    "block": 18500000,
    "timestamp": 1699876543,
    "transactions": 245,
    "protocols": {
      "uniswap": {
        "volume": 125000000,
        "tvl": 5000000000,
        "transactions": 1523
      },
      "aave": {
        "volume": 0,
        "tvl": 8500000000,
        "transactions": 0
      }
    }
  }
}
```

#### Compare Chains

```bash
GET /api/analytics/compare
```

**Response:**
```json
{
  "success": true,
  "data": {
    "ethereum": {
      "block": 18500000,
      "transactions": 245,
      "gasUsed": "15234567"
    },
    "polygon": {
      "block": 49000000,
      "transactions": 312,
      "gasUsed": "12456789"
    }
  }
}
```

### Attestation Endpoints

#### Create Attestation

```bash
POST /api/attest/feed
Content-Type: application/json

{
  "feedName": "ETH/USD",
  "value": 2145.67,
  "source": "chainlink"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "feed_name": "ETH/USD",
    "value": 2145.67,
    "source": "chainlink",
    "timestamp": 1699876543210,
    "signature": "0x...",
    "commitment_hash": "0x..."
  }
}
```

### Batch Endpoints

#### Batch Price Query

```bash
POST /api/batch/prices
Content-Type: application/json

{
  "tokens": [
    {
      "symbol": "ETH",
      "feedAddresses": {
        "chainlink": "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419"
      }
    },
    {
      "symbol": "BTC",
      "feedAddresses": {
        "chainlink": "0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c"
      }
    }
  ]
}
```

## Rate Limiting

- **Window**: 60 seconds
- **Max Requests**: 100 per window per IP
- **Response**: 429 Too Many Requests

Configure in `config.json`:
```json
{
  "api": {
    "rateLimit": {
      "windowMs": 60000,
      "max": 100
    }
  }
}
```

## Caching

Responses are cached based on configuration:

```json
{
  "api": {
    "cache": {
      "enabled": true,
      "ttl": 60
    }
  }
}
```

## Error Responses

All errors follow this format:

```json
{
  "success": false,
  "error": "Error message",
  "message": "Detailed explanation"
}
```

**Status Codes:**
- `200` - Success
- `400` - Bad Request
- `404` - Not Found
- `429` - Too Many Requests
- `500` - Internal Server Error

## Integration Examples

### JavaScript/Node.js

```javascript
const axios = require('axios');

// Get ETH price
const response = await axios.get(
  'http://localhost:3000/api/oracle/price/ETH',
  {
    params: {
      chainlink: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419'
    }
  }
);

console.log(response.data.data.price);
```

### Python

```python
import requests

# Get historical volume
response = requests.get(
    'http://localhost:3000/api/indexer/volume/ethereum/ETH-USDC',
    params={
        'startBlock': 18400000,
        'endBlock': 18500000
    }
)

data = response.json()
print(data['data']['totalVolume'])
```

### cURL

```bash
# Get analytics summary
curl http://localhost:3000/api/analytics/summary/ethereum | jq
```

## Security

- **Helmet.js**: Security headers
- **CORS**: Cross-origin resource sharing
- **Rate Limiting**: DoS protection
- **Input Validation**: Request sanitization

## Monitoring

Health check endpoint for monitoring:

```bash
# Check if service is healthy
curl http://localhost:3000/health

# Monitor uptime
watch -n 5 'curl -s http://localhost:3000/health | jq .uptime'
```

## Performance

- **Compression**: gzip compression enabled
- **Response Time**: <100ms for cached data
- **Throughput**: ~1000 req/sec

## Development

```bash
# Run with auto-reload
npm run dev

# Run tests
npm test
```

## Environment Variables

```bash
PORT=3000
NODE_ENV=production
```

## License

MIT
