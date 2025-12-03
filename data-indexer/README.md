# DeFi Analytics + Historical Indexer

Real-time blockchain data indexer for tracking DeFi protocols, token volumes, lending rates, and liquidity metrics.

## Features

- **Multi-Chain Support**: Index Ethereum, Polygon, Arbitrum, Optimism, Base
- **Protocol Coverage**: Uniswap, Aave, Compound, Curve
- **Time Series Tracking**: Historical data for volumes, rates, and TVL
- **Snapshot System**: Periodic state snapshots for fast queries
- **Export Capability**: JSON exports for external analysis
- **Real-time Indexing**: Continuous block-by-block indexing

## Installation

```bash
npm install
```

## Usage

### Basic Indexing

```javascript
const DeFiIndexer = require('./data-indexer/src/indexer');

const indexer = new DeFiIndexer();

// Index a specific block
const blockData = await indexer.indexBlock('ethereum', 18500000);
console.log(blockData);

// Start continuous indexing
await indexer.startIndexing('ethereum', 12000); // 12 second interval
```

### Query Historical Data

```javascript
// Get historical volume
const volume = await indexer.getHistoricalVolume(
  'ethereum',
  'ETH/USDC',
  18400000,  // start block
  18500000   // end block
);

// Get lending rates
const rates = await indexer.getLendingRates(
  'ethereum',
  'aave',
  'USDC',
  18400000,
  18500000
);

console.log(volume);
console.log(rates);
```

### Export Data

```javascript
// Export time series to JSON
await indexer.exportTimeSeries(
  'ethereum',
  18400000,
  18500000,
  './data/export.json'
);
```

## Data Structures

### Block Data

```json
{
  "chain": "ethereum",
  "blockNumber": 18500000,
  "timestamp": 1699876543,
  "gasUsed": "15234567",
  "transactions": 245,
  "baseFeePerGas": "25000000000",
  "protocols": {
    "uniswap": {
      "volume": 125000000,
      "transactions": 1523,
      "swaps": [...]
    },
    "aave": {
      "totalDeposits": 5000000000,
      "totalBorrows": 3500000000,
      "assets": [...]
    }
  }
}
```

### Volume Data

```json
{
  "chain": "ethereum",
  "pair": "ETH/USDC",
  "startBlock": 18400000,
  "endBlock": 18500000,
  "dataPoints": 7200,
  "totalVolume": 1500000000,
  "data": [
    {
      "block": 18400001,
      "timestamp": 1699800000,
      "volume": 2500000,
      "transactions": 23
    }
  ]
}
```

### Lending Rates

```json
{
  "chain": "ethereum",
  "protocol": "aave",
  "asset": "USDC",
  "startBlock": 18400000,
  "endBlock": 18500000,
  "dataPoints": 7200,
  "data": [
    {
      "block": 18400001,
      "timestamp": 1699800000,
      "supplyAPY": 2.5,
      "borrowAPY": 4.2,
      "utilization": 0.75
    }
  ]
}
```

## API Reference

### `indexBlock(chain, blockNumber)`

Index a specific block and extract DeFi data.

**Returns:** Promise<BlockData>

### `getHistoricalVolume(chain, pair, startBlock, endBlock)`

Get trading volume time series for a pair.

**Returns:** Promise<VolumeData>

### `getLendingRates(chain, protocol, asset, startBlock, endBlock)`

Get lending rate time series for an asset.

**Returns:** Promise<RatesData>

### `exportTimeSeries(chain, startBlock, endBlock, outputPath)`

Export time series data to JSON file.

**Returns:** Promise<ExportData>

### `startIndexing(chain, intervalMs)`

Start continuous indexing for a chain.

**Returns:** void

### `getCurrentState(chain)`

Get current state snapshot.

**Returns:** StateData | null

## Events

```javascript
indexer.on('blockIndexed', (data) => {
  console.log(`Block ${data.blockNumber} indexed`);
});
```

## Configuration

Edit `config.json`:

```json
{
  "indexer": {
    "chains": ["ethereum", "polygon"],
    "batchSize": 100,
    "snapshotInterval": 1000,
    "protocols": ["uniswap", "aave", "compound"]
  }
}
```

## Supported Protocols

- **Uniswap V3**: Swap volume, liquidity, fees
- **Aave V3**: Deposits, borrows, utilization rates
- **Compound V2**: Supply rates, borrow rates, markets
- **Curve**: Pool TVL, volume, fees

## Data Storage

```
data/
├── snapshots/           # Periodic state snapshots
│   ├── ethereum-18500000.json
│   └── polygon-45000000.json
└── timeseries/          # Exported time series
    └── export.json
```

## Performance

- **Indexing Speed**: ~10-50 blocks/second (depending on protocol complexity)
- **Memory Usage**: ~100MB per 10,000 blocks
- **Storage**: ~50KB per block snapshot

## Extending

Add custom protocol indexing:

```javascript
async indexCustomProtocol(chain, block) {
  const data = {
    // Your custom data structure
  };

  // Fetch protocol data
  // ...

  return data;
}
```

## Testing

```bash
node data-indexer/src/indexer.js
```
