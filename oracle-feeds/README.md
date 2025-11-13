# Oracle Feeds - Multi-Source Aggregator

Secure, verifiable price oracle aggregation from multiple sources with outlier detection and slashing mechanisms.

## Features

- **Multi-Source Support**: Chainlink, Pyth Network, RedStone, and custom APIs
- **Median Aggregation**: Robust statistical aggregation with weighted averaging
- **Outlier Detection**: Standard deviation capping to filter bad data
- **Slashing Mechanism**: Automatic penalty system for sources providing incorrect data
- **ZK Proofs**: Cryptographic proof of timestamp and data source
- **Real-time Updates**: Event-driven architecture for price updates

## Installation

```bash
npm install
```

## Usage

### Basic Usage

```javascript
const OracleAggregator = require('./oracle-feeds/src/aggregator');

const aggregator = new OracleAggregator();

// Define oracle feed addresses
const feedAddresses = {
  chainlink: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419', // ETH/USD
  pyth: '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace'
};

// Get verified price
const price = await aggregator.getVerifiedPrice('ETH', feedAddresses);
console.log(price);
```

### Output Format

```json
{
  "token": "ETH",
  "price": 2145.67,
  "median": 2145.50,
  "stdDev": 5.23,
  "confidence": 0.93,
  "timestamp": 1699876543210,
  "sources": [
    {
      "source": "chainlink",
      "price": 2145.50,
      "weight": 0.3
    },
    {
      "source": "pyth",
      "price": 2145.80,
      "weight": 0.3
    }
  ],
  "verification": {
    "zkProofHash": "0x1234...",
    "signatureHash": "0x5678..."
  }
}
```

## API Reference

### `getVerifiedPrice(token, feedAddresses)`

Get verified, aggregated price for a token.

**Parameters:**
- `token` (string): Token symbol (e.g., 'ETH', 'BTC')
- `feedAddresses` (object): Oracle feed addresses for each source

**Returns:** Promise<PriceData>

### `getCachedPrice(token)`

Get last cached price without fetching.

**Returns:** PriceData | undefined

### `getSlashingHistory(source, token)`

Get slashing history for a source.

**Returns:** Array<SlashingRecord>

## Events

```javascript
aggregator.on('priceUpdate', (data) => {
  console.log(`New price: ${data.token} = $${data.price}`);
});

aggregator.on('slashing', (record) => {
  console.log(`Source slashed: ${record.source}`);
});
```

## Configuration

Edit `config.json` to customize:

```json
{
  "oracle": {
    "aggregation": {
      "method": "median",
      "stdDevCap": 2.5,
      "minSources": 2
    },
    "slashing": {
      "enabled": true,
      "threshold": 0.1
    }
  }
}
```

## Slashing Mechanism

Sources are slashed when:
1. Price deviates >2.5 standard deviations from median
2. Deviation exceeds configured threshold (default 10%)

Slashing records are stored and can be used for governance decisions.
