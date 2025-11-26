# PyFlow Service

Prefect-based workflow automation service for GPU rental arbitrage and optimization.

## Features

- **Arbitrage Bot**: Monitors GPU prices across providers and identifies buy-low-sell-high opportunities
- **Pricing Optimizer**: Analyzes demand and adjusts surge pricing margins in real-time
- **n8n Integration**: Exposes workflows as HTTP endpoints for easy orchestration
- **Async Execution**: Background task processing with FastAPI

## Workflows

### 1. Arbitrage Bot (`flows/arbitrage_bot.py`)

Monitors GPU prices and executes arbitrage strategies.

**Strategy:**
- Fetch prices from all providers
- Find cheapest provider
- Calculate potential resale margin
- Execute trade if margin > threshold (default 20%)

**API Endpoint:**
```bash
POST http://localhost:8001/flows/arbitrage
{
  "gpu_types": ["H100", "A100"],
  "min_margin_pct": 20.0,
  "execute_trades": false,
  "notification_webhook": "https://n8n.yourdomain.com/webhook/arbitrage-alert"
}
```

### 2. Pricing Optimizer (`flows/pricing_optimizer.py`)

Optimizes profit margins based on demand.

**Strategy:**
- Fetch recent quote volume from Redis
- Calculate demand level (high/medium/low)
- Adjust margin percentages
- Update price engine configuration

**API Endpoint:**
```bash
POST http://localhost:8001/flows/pricing-optimizer
{
  "redis_url": "redis://redis:6379"
}
```

## Quick Start

### Local Development

```bash
cd pyflow-service

# Install dependencies
pip install -e .

# Run server
uvicorn main:app --reload --port 8001
```

### With Docker

```bash
cd infra
docker compose up -d pyflow

# View logs
docker compose logs -f pyflow
```

## API Documentation

Visit http://localhost:8001/docs for interactive Swagger docs.

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/flows/arbitrage` | POST | Trigger arbitrage bot (async) |
| `/flows/arbitrage/sync` | POST | Trigger arbitrage bot (wait for result) |
| `/flows/pricing-optimizer` | POST | Trigger pricing optimizer (async) |
| `/flows/pricing-optimizer/sync` | POST | Trigger pricing optimizer (wait for result) |

## Integration with n8n

### Schedule Arbitrage Bot

In n8n, create a workflow:

1. **Cron Trigger** - Every 15 minutes
2. **HTTP Request** → `http://pyflow:8001/flows/arbitrage`
3. **IF** - Check for opportunities
4. **Discord/Slack** - Send notification

### Schedule Pricing Optimizer

1. **Cron Trigger** - Every 30 minutes
2. **HTTP Request** → `http://pyflow:8001/flows/pricing-optimizer`

## Environment Variables

```bash
REDIS_HOST=redis
REDIS_PORT=6379
PRICE_ENGINE_URL=http://price-engine:8000
N8N_WEBHOOK_URL=http://n8n:5678/webhook/arbitrage-alert
```

## Development

### Adding New Workflows

1. Create new flow in `flows/my_flow.py`:

```python
from prefect import flow, task

@task
def my_task():
    # Task logic here
    pass

@flow(name="My Flow")
async def my_flow():
    result = my_task()
    return result
```

2. Add API endpoint in `main.py`:

```python
@app.post("/flows/my-flow")
async def trigger_my_flow():
    result = await my_flow()
    return result
```

3. Rebuild container:
```bash
docker compose build pyflow
docker compose up -d pyflow
```

## Monitoring

### Check Flow Execution

```bash
# View logs
docker compose logs -f pyflow

# Test arbitrage bot
curl -X POST http://localhost:8001/flows/arbitrage/sync \
  -H "Content-Type: application/json" \
  -d '{"gpu_types": ["H100"], "min_margin_pct": 15.0}'
```

### Performance

Flows are designed to be:
- **Fast**: Concurrent provider queries
- **Reliable**: Automatic retries with Prefect
- **Observable**: Detailed logging
- **Scalable**: Async/await throughout

## Future Enhancements

- [ ] Add Prefect Cloud integration for UI
- [ ] Implement machine learning price predictions
- [ ] Add multi-hour commitment optimization
- [ ] Build inventory management flow
- [ ] Create customer LTV prediction flow

## License

MIT License
