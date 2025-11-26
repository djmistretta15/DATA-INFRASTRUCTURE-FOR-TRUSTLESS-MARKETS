# GP4U-Mk-2 (GPUs For You - Mark 2)

A GPU rental arbitrage platform that aggregates pricing from multiple providers, applies dynamic margins, and enables streamers to earn commissions through referrals.

> **Note:** This is the production-ready version with modular n8n workflows, PyFlow automation, and full CI/CD.

## Architecture Overview

```
┌─────────────┐
│  Frontend   │ Next.js 15 + Tailwind + Supabase
│  (Next.js)  │ Landing + Dashboard + Rent Form
└──────┬──────┘
       │
       v
┌─────────────┐
│     n8n     │ Workflow Orchestration
│ (Webhooks)  │ /webhook/rent + /webhook/provider-callback
└──────┬──────┘
       │
       v
┌─────────────┐      ┌─────────────┐
│    Price    │◄─────┤    Redis    │ Cache + Rate Limiting
│   Engine    │      │             │ Quote Storage
│  (FastAPI)  │      └─────────────┘
└──────┬──────┘
       │
       v
┌─────────────────────────────────┐
│  GPU Provider APIs              │
│  • Salad.com                    │
│  • Vast.ai                      │
│  • Hyperstack                   │
│  • RunPod                       │
│  • Lambda Labs                  │
└─────────────────────────────────┘
       │
       v
┌─────────────┐
│  Supabase   │ Auth + Database
│             │ users, orders, referrals
└─────────────┘
```

## Quick Start

### Prerequisites
- Docker & Docker Compose
- Node.js 20+ (for local frontend dev)
- Python 3.12+ (for local price-engine dev)

### 1. Clone and Setup

```bash
git clone https://github.com/YOUR_USERNAME/GP4U-Mk-2.git
cd GP4U-Mk-2

# Copy environment files
cp infra/.env.example infra/.env
cp price-engine/.env.example price-engine/.env
cp frontend/.env.example frontend/.env

# Edit .env files with your API keys
```

### 2. Start Infrastructure

```bash
cd infra
docker compose up -d

# Check services
docker compose ps
```

This starts:
- **n8n** on http://localhost:5678 (admin/changeme)
- **Redis** on localhost:6379
- **Price Engine** on http://localhost:8000
- **Uptime Kuma** on http://localhost:3001

### 3. Configure n8n Workflow

**Option A: Import Pre-built Workflow (RECOMMENDED)**
1. Open http://localhost:5678
2. Click "Workflows" → "Import from file"
3. Select `n8n/gpu-rental-workflow.json`
4. Set environment variables (SUPABASE_URL, SUPABASE_ANON_KEY)
5. Activate the workflow
6. See `n8n/IMPORT_GUIDE.md` for detailed instructions

**Option B: Build Manually**
1. Follow the steps in `n8n/FLOW_SPEC.md` to build from scratch

### 4. Setup Supabase

1. Create a Supabase project at https://supabase.com
2. Run the schema (TODO: create schema file)
3. Copy your project URL and anon key to `.env` files

### 5. Start Frontend (Local Dev)

```bash
cd frontend
npm install
npm run dev
```

Frontend runs on http://localhost:3000

### 6. Test the Flow

**Test Price Engine directly:**
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

**Test via n8n webhook:**
```bash
curl -X POST http://localhost:5678/webhook/rent \
  -H "Content-Type: application/json" \
  -d '{
    "gpu_type": "H100",
    "vram_gb": 80,
    "hours": 4,
    "region": "any",
    "priority": "normal"
  }'
```

**Test via Frontend:**
Visit http://localhost:3000 and fill out the "Get Your Quote" form.

---

## Project Structure

```
GP4U-Mk-2/
├── infra/                      # Infrastructure & deployment
│   ├── docker-compose.yml      # Service definitions
│   ├── .env.example            # Env vars template
│   └── deploy.sh               # VPS deployment script
│
├── price-engine/               # GPU pricing API (Python/FastAPI)
│   ├── app/
│   │   ├── main.py            # FastAPI app with /health, /quote
│   │   ├── core/
│   │   │   ├── models.py      # Pydantic models
│   │   │   └── surge.py       # Dynamic pricing engine
│   │   └── providers/
│   │       ├── salad.py       # Salad.com integration
│   │       ├── vast.py        # Vast.ai integration
│   │       ├── hyperstack.py  # Hyperstack integration
│   │       ├── runpod.py      # RunPod integration
│   │       └── lambda_labs.py # Lambda Labs integration
│   ├── Dockerfile
│   ├── pyproject.toml
│   └── README.md
│
├── frontend/                   # Next.js 15 web app
│   ├── app/
│   │   ├── page.tsx           # Landing page
│   │   ├── dashboard/         # Streamer dashboard
│   │   └── api/rent/          # Proxy to n8n webhook
│   ├── components/
│   │   └── RentGPUForm.tsx    # Main rental form
│   ├── lib/
│   │   └── supabase.ts        # Supabase client
│   └── README.md
│
└── n8n/
    └── FLOW_SPEC.md           # n8n workflow documentation
```

---

## Features

### MVP (Current)
- ✅ Multi-provider price aggregation (5 providers)
- ✅ /quote endpoint with margin calculation
- ✅ Mock provider integrations (ready for real APIs)
- ✅ Basic surge pricing (time-of-day + demand-based)
- ✅ Auto-upgrade logic (H100→H200 if price within 10%)
- ✅ Frontend with landing page + streamer dashboard
- ✅ n8n orchestration workflow
- ✅ Redis caching & rate limiting
- ✅ Docker deployment stack

### Phase 2 (Planned)
- 🔲 Real provider API integrations (replace mocks)
- 🔲 Stripe/LemonSqueezy payment processing
- 🔲 Email notifications with connection details
- 🔲 Discord bot `/rent` command
- 🔲 Supabase schema + real-time dashboard data
- 🔲 Referral commission tracking & payouts
- 🔲 Cloudflare Tunnel for production ingress
- 🔲 Whitelabel mode for streamers

### Phase 3 (Future)
- 🔲 Arbitrage bot (auto-buy low, resell high)
- 🔲 Multi-hour commitment discounts
- 🔲 GPU inventory management
- 🔲 Advanced analytics dashboard

---

## Development

### Price Engine

```bash
cd price-engine

# Install dependencies
pip install -e .

# Run locally
REDIS_HOST=localhost uvicorn app.main:app --reload

# Run tests
pytest
```

### Frontend

```bash
cd frontend

# Install dependencies
npm install

# Dev server
npm run dev

# Build for production
npm run build
npm start
```

---

## API Reference

### Price Engine

#### `GET /health`
Health check endpoint.

#### `POST /quote`
Get best GPU pricing quote.

**Request:**
```json
{
  "gpu_type": "H100",
  "vram_gb": 80,
  "hours": 4.0,
  "region": "any",
  "max_price_per_hour": null,
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
    "final_hourly_cost": 2.86,
    "estimated_total": 11.44,
    "is_upgraded": false
  }
}
```

---

## License

MIT License