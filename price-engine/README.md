# Price Engine API

FastAPI-based GPU pricing aggregation service that queries multiple providers and returns the best quote with margin applied.

## Features

- **Multi-provider support**: Queries 5+ GPU providers concurrently
- **Dynamic pricing**: Surge pricing based on demand, time-of-day, and priority
- **Auto-upgrades**: Automatically upgrades to better GPUs when prices align
- **Redis caching**: Caches quotes and rate-limits provider API calls
- **Health monitoring**: `/health` endpoint for uptime checks

## Endpoints

### `GET /health`
Returns service health status.

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2025-01-15T10:00:00Z",
  "redis_connected": true,
  "version": "0.1.0"
}
```

### `POST /quote`
Get best GPU pricing quote across all providers.

**Request:**
```json
{
  "gpu_type": "H100",
  "vram_gb": 80,
  "hours": 4.0,
  "region": "any",
  "max_price_per_hour": 5.0,
  "priority": "normal"
}
```

**Response:**
```json
{
  "success": true,
  "quote": {
    "request_id": "req_abc123",
    "provider": "salad",
    "gpu_type": "H100",
    "vram_gb": 80,
    "region": "us-west",
    "base_hourly_cost": 2.49,
    "margin_pct": 15.0,
    "margin_amount": 0.37,
    "final_hourly_cost": 2.86,
    "hours": 4.0,
    "estimated_total": 11.44,
    "connect_instructions_type": "ssh",
    "estimated_provision_minutes": 3,
    "is_upgraded": false
  },
  "all_provider_quotes": [...]
}
```

### `GET /surge-status`
Get current surge pricing multipliers.

## Development

### Prerequisites
- Python 3.12+
- Redis running on localhost:6379

### Setup

```bash
# Install dependencies
pip install -e .

# Or for development with testing tools
pip install -e ".[dev]"
```

### Run locally

```bash
# Set Redis connection
export REDIS_HOST=localhost
export REDIS_PORT=6379

# Run the server
uvicorn app.main:app --reload --port 8000
```

Visit http://localhost:8000/docs for interactive API documentation.

### Testing

```bash
# Run tests
pytest

# With coverage
pytest --cov=app --cov-report=html
```

### Example request

```bash
curl -X POST http://localhost:8000/quote \
  -H "Content-Type: application/json" \
  -d '{
    "gpu_type": "H100",
    "vram_gb": 80,
    "hours": 4,
    "region": "any",
    "priority": "normal"
  }'
```

## Configuration

Environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `REDIS_HOST` | Redis hostname | `localhost` |
| `REDIS_PORT` | Redis port | `6379` |
| `REDIS_DB` | Redis database number | `0` |
| `BASE_MARGIN_PCT` | Base margin percentage | `15.0` |
| `SURGE_ENABLED` | Enable dynamic surge pricing | `false` |
| `CACHE_TTL_SECONDS` | Quote cache duration | `900` |
| `LOG_LEVEL` | Logging level | `INFO` |

Provider API keys:
- `SALAD_API_KEY`
- `VAST_API_KEY`
- `HYPERSTACK_API_KEY`
- `RUNPOD_API_KEY`
- `LAMBDA_API_KEY`

## Architecture

```
┌─────────────────┐
│   FastAPI App   │
│   (main.py)     │
└────────┬────────┘
         │
    ┌────┴────┐
    │         │
    v         v
┌───────┐  ┌───────────┐
│ Core  │  │ Providers │
│ Logic │  │  (async)  │
└───┬───┘  └─────┬─────┘
    │            │
    │    ┌───────┴────────┐
    │    │                │
    v    v                v
┌──────────┐  ┌──────────────────┐
│  Redis   │  │  Provider APIs   │
│  Cache   │  │  (Salad, Vast,   │
└──────────┘  │  Hyperstack...)  │
              └──────────────────┘
```

## Adding a New Provider

1. Create `app/providers/newprovider.py`:

```python
from app.core.models import GPUType, Region, ProviderQuote, ProviderName

class NewProviderProvider:
    def __init__(self, api_key: str = None):
        self.api_key = api_key
        self.base_url = "https://api.newprovider.com"

    async def get_quote(
        self,
        gpu_type: GPUType,
        vram_gb: int,
        hours: float,
        region: Region
    ) -> ProviderQuote:
        # Implementation here
        pass
```

2. Add to `app/main.py`:

```python
from app.providers.newprovider import NewProviderProvider

def get_providers():
    return [
        # existing providers...
        NewProviderProvider(api_key=os.getenv("NEWPROVIDER_API_KEY")),
    ]
```

3. Add API key to `.env`:
```
NEWPROVIDER_API_KEY=your_key_here
```

## Surge Pricing Algorithm

The surge engine adjusts margin based on:

1. **Time of day**: Peak hours (2pm-10pm UTC) increase margin by 3%
2. **Demand**: High demand (>50 recent quotes) adds 5%
3. **Priority**: Urgent priority adds 8%
4. **GPU type**: H100/H200/B200 add 2% premium

**Constraints:**
- Minimum margin: 5%
- Maximum margin: 40%

## Current Provider Status

| Provider | Status | Notes |
|----------|--------|-------|
| Salad.com | Mock | Ready for API integration |
| Vast.ai | Mock | Ready for API integration |
| Hyperstack | Mock | Ready for API integration |
| RunPod | Mock | Ready for API integration |
| Lambda Labs | Mock | Ready for API integration |

**TODO:** Replace mock data with real API calls once credentials are available.

## Monitoring

Check Redis for cached quotes:
```bash
redis-cli
> KEYS quote:*
> GET quote:req_abc123
> ZRANGE recent_quotes 0 -1 WITHSCORES
```

## License

MIT License
