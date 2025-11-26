# Complete Implementation Guide
## From Code to Running System in 30 Minutes

**Goal:** Get n8n + PyFlow + Frontend running so you can see your GPU arbitrage platform in action!

---

## ✅ Prerequisites Checklist

Before starting, ensure you have:

- [ ] Docker Desktop installed and running
- [ ] Git installed
- [ ] Node.js 20+ installed (for frontend)
- [ ] Code editor (VS Code recommended)
- [ ] Terminal/command line access
- [ ] This repository cloned locally

**Quick check:**
```bash
docker --version          # Should show Docker version
docker compose version    # Should show Compose version
node --version            # Should show v20.x or higher
git --version             # Should show Git version
```

---

## 📁 Part 1: Get the Code Running Locally (5 minutes)

### Step 1.1: Navigate to Project Directory

```bash
# Open terminal and go to your project
cd /path/to/DATA-INFRASTRUCTURE-FOR-TRUSTLESS-MARKETS

# Verify you're in the right place
ls -la
# You should see: infra/, price-engine/, pyflow-service/, frontend/, n8n/
```

### Step 1.2: Set Up Environment Files

```bash
# Copy environment templates
cp infra/.env.example infra/.env
cp price-engine/.env.example price-engine/.env
cp frontend/.env.example frontend/.env.local

# Edit the main config (optional for local testing)
nano infra/.env
```

**For now, you can leave defaults. Change these:**
```bash
N8N_BASIC_AUTH_PASSWORD=your_secure_password_here
```

Save and exit (Ctrl+X, then Y, then Enter)

### Step 1.3: Start All Backend Services

```bash
cd infra

# Build and start everything
docker compose up -d

# This will start:
# - n8n (port 5678)
# - Redis (port 6379)
# - Price Engine (port 8000)
# - PyFlow (port 8001)
# - Uptime Kuma (port 3001)
```

**Expected output:**
```
✔ Network gpu-network         Created
✔ Container gpu-redis          Started
✔ Container gpu-price-engine   Started
✔ Container gpu-pyflow         Started
✔ Container gpu-n8n           Started
✔ Container gpu-uptime-kuma    Started
```

### Step 1.4: Verify Services Are Running

```bash
# Check all containers are up
docker compose ps

# Should show all as "Up" or "healthy"
```

**Test each service:**
```bash
# Price Engine
curl http://localhost:8000/health
# Should return: {"status":"healthy"...}

# PyFlow
curl http://localhost:8001/health
# Should return: {"status":"healthy"...}

# n8n (will redirect to login)
curl -I http://localhost:5678
# Should return: HTTP/1.1 200 OK
```

✅ **Checkpoint:** All services returning healthy responses

---

## 🎨 Part 2: Set Up n8n with Your Workflows (10 minutes)

### Step 2.1: Open n8n Interface

```bash
# Open in browser
open http://localhost:5678
# Or manually visit: http://localhost:5678
```

**Login credentials:**
- Username: `admin`
- Password: (what you set in infra/.env, default: `changeme`)

### Step 2.2: Configure n8n Environment Variables

1. Click your profile icon (top-right)
2. Go to **Settings**
3. Click **Environments**
4. Click **+ Add Variable**

**Add these variables:**

| Variable Name | Value | Description |
|--------------|-------|-------------|
| `SUPABASE_URL` | `https://your-project.supabase.co` | (Optional for now) |
| `SUPABASE_ANON_KEY` | `your_anon_key` | (Optional for now) |
| `DISCORD_WEBHOOK_URL` | Get from Discord* | For notifications |

*To get Discord webhook: Discord → Server Settings → Integrations → Webhooks → New Webhook → Copy URL

**For testing without Supabase/Discord:**
- Leave SUPABASE fields empty (nodes using them are disabled by default)
- Create a test Discord webhook or skip for now

### Step 2.3: Import Atomic Node Workflows

**Import all 6 atomic nodes:**

For each file in `n8n/workflows/`:

1. In n8n, click **Workflows** (sidebar)
2. Click **Add workflow** dropdown → **Import from file**
3. Navigate to your project folder: `n8n/workflows/`
4. Select one of these files:
   - `node-get-provider-prices.json`
   - `node-find-best-price.json`
   - `node-check-arbitrage-opportunity.json`
   - `node-send-discord-alert.json`
   - `node-create-user.json`
   - `node-track-referral.json`
5. Click **Import**
6. Click **Save**
7. Repeat for all 6 files

**Expected result:**
You should now see 6 workflows in your workflow list, all tagged with "atomic-node"

### Step 2.4: Import Main GPU Rental Workflow

1. Click **Import from file**
2. Select: `n8n/gpu-rental-workflow.json`
3. Click **Import**
4. Review the workflow (should show all nodes connected)
5. **Disable Supabase node** (if not using yet):
   - Click the "Create Order in Supabase" node
   - Toggle "Disabled" switch in right panel
6. Click **Save**

### Step 2.5: Build Your First Custom Workflow - "Arbitrage Monitor"

Let's build the monitoring workflow from scratch!

1. Click **+ Add workflow** → **Blank workflow**
2. Name it: "Arbitrage Monitor"

**Add nodes in this order:**

#### Node 1: Schedule Trigger
- Search for: **Schedule Trigger**
- Drag onto canvas
- Configure:
  - Mode: **Interval**
  - Interval: **15 minutes**
- Click **Execute Node** to test

#### Node 2: Set Initial Data
- Search for: **Set**
- Drag onto canvas
- Connect from Schedule Trigger
- Configure:
  - Click **Add Value**
  - Name: `gpu_type`, Value: `H100`
  - Name: `vram_gb`, Value: `80`
  - Name: `hours`, Value: `24`
  - Name: `region`, Value: `any`
  - Name: `priority`, Value: `normal`

#### Node 3: Get Provider Prices
- Search for: **Execute Workflow**
- Drag onto canvas
- Connect from Set node
- Configure:
  - Source: **Database**
  - Workflow: Select **"Node: Get Provider Prices"**
  - Mode: **Run Once for All Items**

#### Node 4: Extract Quote Data
- Search for: **Code**
- Drag onto canvas
- Connect from Execute Workflow
- Configure:
  - Paste this code:
```javascript
// Extract all provider quotes and best quote
const response = $input.first().json;
const quotes = response.all_provider_quotes || [];

// Find cheapest available
const available = quotes.filter(q => q.available && q.hourly_cost);
available.sort((a, b) => a.hourly_cost - b.hourly_cost);

const best = available[0];
const marketAvg = available.reduce((sum, q) => sum + q.hourly_cost, 0) / available.length;

return {
  best_price: best.hourly_cost,
  best_provider: best.provider,
  gpu_type: best.gpu_type,
  market_avg: marketAvg,
  all_available: available.map(q => ({
    provider: q.provider,
    price: q.hourly_cost
  }))
};
```

#### Node 5: Check Arbitrage Opportunity
- Search for: **Code**
- Drag onto canvas
- Connect from previous Code node
- Configure:
  - Paste this code:
```javascript
// Check for arbitrage opportunity
const input = $input.first().json;
const minMarginPct = 20.0;

const cheapest = input.best_price;
const resalePrice = input.market_avg * 0.95;
const marginPct = ((resalePrice - cheapest) / cheapest) * 100;
const profitPerHour = resalePrice - cheapest;
const profit24h = profitPerHour * 24;

const hasOpportunity = marginPct >= minMarginPct;

return {
  has_opportunity: hasOpportunity,
  gpu_type: input.gpu_type,
  buy_from: input.best_provider,
  buy_price: cheapest,
  sell_price: resalePrice,
  margin_pct: Math.round(marginPct * 100) / 100,
  profit_per_hour: Math.round(profitPerHour * 100) / 100,
  profit_24h: Math.round(profit24h * 100) / 100,
  market_avg: Math.round(input.market_avg * 100) / 100,
  message: hasOpportunity
    ? `🎯 Arbitrage opportunity! Buy ${input.gpu_type} from ${input.best_provider} at $${cheapest}/hr, resell at $${resalePrice.toFixed(2)}/hr (${marginPct.toFixed(1)}% margin, $${profit24h.toFixed(2)}/day)`
    : `No arbitrage: margin only ${marginPct.toFixed(1)}% (need ${minMarginPct}%)`
};
```

#### Node 6: IF - Check If Opportunity Exists
- Search for: **IF**
- Drag onto canvas
- Connect from Check Arbitrage node
- Configure:
  - Condition: **Boolean**
  - Value 1: `{{ $json.has_opportunity }}`
  - Operation: **is true**

#### Node 7 (TRUE branch): Log to Console
- Search for: **Code**
- Drag onto canvas
- Connect from IF node's **true** output
- Configure:
  - Paste this code:
```javascript
// Log the opportunity
const data = $input.first().json;
console.log('🎯 ARBITRAGE OPPORTUNITY FOUND!');
console.log(data.message);
console.log('Details:', JSON.stringify(data, null, 2));
return data;
```

#### Node 8 (TRUE branch): Send Discord Alert (Optional)
**Only add if you have Discord webhook:**
- Search for: **HTTP Request**
- Drag onto canvas
- Connect from Log node
- Configure:
  - Method: **POST**
  - URL: `{{ $env.DISCORD_WEBHOOK_URL }}`
  - Body Content Type: **JSON**
  - Body:
```json
{
  "embeds": [{
    "title": "🎯 Arbitrage Opportunity Found!",
    "color": 3066993,
    "fields": [
      {
        "name": "GPU Type",
        "value": "{{ $json.gpu_type }}",
        "inline": true
      },
      {
        "name": "Buy From",
        "value": "{{ $json.buy_from }} @ ${{ $json.buy_price }}/hr",
        "inline": true
      },
      {
        "name": "Resell At",
        "value": "${{ $json.sell_price }}/hr",
        "inline": true
      },
      {
        "name": "Margin",
        "value": "{{ $json.margin_pct }}%",
        "inline": true
      },
      {
        "name": "Profit/Day",
        "value": "${{ $json.profit_24h }}",
        "inline": true
      }
    ],
    "timestamp": "{{ $now.toISO() }}"
  }]
}
```

#### Node 9 (FALSE branch): Log No Opportunity
- Search for: **Code**
- Drag onto canvas
- Connect from IF node's **false** output
- Configure:
```javascript
const data = $input.first().json;
console.log('ℹ️ No arbitrage opportunity');
console.log(data.message);
return { status: 'no_opportunity', message: data.message };
```

### Step 2.6: Test Your Workflow

1. Click **Execute Workflow** button (top-right)
2. Watch the execution:
   - Green = success
   - Red = error
3. Click each node to see its output
4. Check the last node - did you find an opportunity?

### Step 2.7: Activate for Continuous Monitoring

1. Toggle the **Inactive/Active** switch (top-right)
2. Now it runs every 15 minutes automatically!

✅ **Checkpoint:** Workflow executes successfully and shows price data

---

## 🐍 Part 3: Test PyFlow Service (5 minutes)

### Step 3.1: Access PyFlow API Documentation

```bash
# Open in browser
open http://localhost:8001/docs
```

You should see the Swagger UI with all PyFlow endpoints.

### Step 3.2: Test Arbitrage Bot

**Via API:**
```bash
curl -X POST http://localhost:8001/flows/arbitrage/sync \
  -H "Content-Type: application/json" \
  -d '{
    "gpu_types": ["H100", "A100"],
    "min_margin_pct": 15.0,
    "execute_trades": false
  }'
```

**Expected response:**
```json
{
  "opportunities_found": 1,
  "opportunities": [
    {
      "gpu_type": "H100",
      "buy_provider": "salad",
      "buy_cost_per_hour": 2.49,
      "sell_price_per_hour": 2.86,
      "margin_pct": 14.86,
      "estimated_profit_24h": 8.88,
      ...
    }
  ],
  "scanned_at": "2025-01-15T10:30:00Z"
}
```

**Via Swagger UI:**
1. Go to http://localhost:8001/docs
2. Click **POST /flows/arbitrage/sync**
3. Click **Try it out**
4. Edit the request body
5. Click **Execute**
6. View response below

### Step 3.3: Test Pricing Optimizer

```bash
curl -X POST http://localhost:8001/flows/pricing-optimizer/sync \
  -H "Content-Type: application/json" \
  -d '{"redis_url": "redis://redis:6379"}'
```

### Step 3.4: Integrate PyFlow with n8n

**Create new workflow in n8n:**

1. New workflow: "PyFlow Arbitrage Scanner"
2. Add **Schedule Trigger** → every 30 minutes
3. Add **HTTP Request**:
   - Method: POST
   - URL: `http://pyflow:8001/flows/arbitrage`
   - Body:
   ```json
   {
     "gpu_types": ["H100"],
     "min_margin_pct": 20.0,
     "execute_trades": false
   }
   ```
4. Add **IF** node: check if opportunities > 0
5. Add Discord notification on TRUE
6. Save and activate

✅ **Checkpoint:** PyFlow returning arbitrage data successfully

---

## 🎨 Part 4: Set Up Frontend (5 minutes)

### Step 4.1: Install Frontend Dependencies

```bash
# Open new terminal
cd /path/to/DATA-INFRASTRUCTURE-FOR-TRUSTLESS-MARKETS/frontend

# Install dependencies
npm install
```

### Step 4.2: Configure Frontend Environment

```bash
# Edit environment file
nano .env.local
```

**Set these values:**
```bash
# For local testing - direct to price engine
PRICE_ENGINE_URL=http://localhost:8000

# Or via n8n webhook (if you imported the workflow)
N8N_RENT_WEBHOOK_URL=http://localhost:5678/webhook/rent

# Supabase (optional for now)
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
```

### Step 4.3: Start Frontend Dev Server

```bash
npm run dev
```

**Expected output:**
```
  ▲ Next.js 15.0.3
  - Local:        http://localhost:3000
  - Network:      http://192.168.x.x:3000

 ✓ Ready in 2.3s
```

### Step 4.4: Test Frontend

```bash
# Open in browser
open http://localhost:3000
```

**You should see:**
- Landing page with "Rent GPUs at the Best Prices"
- Features section
- GPU rental form

### Step 4.5: Test Quote Request

1. Scroll to "Get Your Quote" form
2. Fill in:
   - GPU Type: **H100**
   - VRAM: **80 GB**
   - Duration: **4 hours**
   - Region: **Any Region**
3. Click **Get Quote**

**Expected result:**
- Quote card appears showing:
  - Provider (e.g., "salad")
  - GPU details
  - Cost per hour
  - Total estimate
  - Provisioning time

### Step 4.6: Test Dashboard

1. Visit: http://localhost:3000/dashboard
2. You should see:
   - Mock earnings data
   - Referral link
   - Recent activity
   - Stats cards

✅ **Checkpoint:** Frontend loading and getting quotes successfully

---

## 🔗 Part 5: Connect Everything Together (5 minutes)

### Step 5.1: Update Frontend to Use n8n Webhook

```bash
nano frontend/.env.local
```

**Change:**
```bash
# Comment out direct access
# PRICE_ENGINE_URL=http://localhost:8000

# Use n8n instead
N8N_RENT_WEBHOOK_URL=http://localhost:5678/webhook/rent
```

**Restart frontend:**
```bash
# Ctrl+C to stop
npm run dev
```

### Step 5.2: Test Full Flow

**Frontend → n8n → Price Engine → Frontend:**

1. Visit http://localhost:3000
2. Fill out quote form
3. Click "Get Quote"
4. Watch n8n execution:
   - Go to http://localhost:5678
   - Click "Executions" (sidebar)
   - See the latest execution
   - Click to view details
5. Quote returns to frontend

### Step 5.3: Monitor Everything with Uptime Kuma

```bash
open http://localhost:3001
```

**First-time setup:**
1. Create admin account
2. Add monitors:

**Monitor 1: Price Engine**
- Type: HTTP(s)
- Name: Price Engine
- URL: http://price-engine:8000/health
- Interval: 60 seconds

**Monitor 2: PyFlow**
- Type: HTTP(s)
- Name: PyFlow Service
- URL: http://pyflow:8001/health
- Interval: 60 seconds

**Monitor 3: n8n**
- Type: HTTP(s)
- Name: n8n
- URL: http://n8n:5678
- Interval: 60 seconds

All should show as **UP** ✅

---

## 📊 Part 6: Visual Progress Dashboard (Bonus)

### Option A: Use Uptime Kuma Status Page

1. In Uptime Kuma, click **Status Pages**
2. Click **+ New Status Page**
3. Name: "GPU Black Market Status"
4. Add all your monitors
5. Set to Public
6. Save
7. Visit the public URL to see your dashboard

### Option B: Use n8n Execution View

1. Open n8n: http://localhost:5678
2. Click **Executions**
3. This shows all workflow runs in real-time
4. Green = success, Red = failed
5. Click any execution to see detailed flow

### Option C: Build Custom Dashboard (Future)

Create a Next.js dashboard page that shows:
- Real-time arbitrage opportunities
- Active workflows
- Service health
- Quote volume
- Commission earnings

---

## ✅ Final Verification Checklist

Go through each item to confirm everything works:

### Backend Services:
- [ ] `docker compose ps` shows all containers as "Up"
- [ ] `curl http://localhost:8000/health` returns healthy
- [ ] `curl http://localhost:8001/health` returns healthy
- [ ] Redis accepting connections

### n8n:
- [ ] Can login at http://localhost:5678
- [ ] All 6 atomic nodes imported
- [ ] Main GPU rental workflow imported
- [ ] "Arbitrage Monitor" workflow created and active
- [ ] Test execution shows price data

### PyFlow:
- [ ] API docs accessible at http://localhost:8001/docs
- [ ] Arbitrage endpoint returns opportunities
- [ ] Pricing optimizer executes

### Frontend:
- [ ] Running on http://localhost:3000
- [ ] Landing page loads
- [ ] Quote form returns data
- [ ] Dashboard shows mock data

### Integration:
- [ ] Frontend → n8n → Price Engine flow works
- [ ] Quote returned to user
- [ ] n8n execution visible in history

---

## 🎉 Success! What You Have Now:

✅ **Full backend running in Docker**
✅ **n8n with modular workflows**
✅ **PyFlow automation service**
✅ **Frontend for user interaction**
✅ **Real-time arbitrage monitoring**
✅ **Visual progress tracking**

---

## 🚀 Next Steps

### Immediate:
1. **Add Discord webhook** → Get real alerts
2. **Customize arbitrage threshold** → Adjust margin %
3. **Test different GPU types** → A100, L40S, etc.
4. **Share with friends** → Get feedback

### This Week:
1. **Set up Supabase** → Real user data
2. **Enable user signups** → Build email list
3. **Create more workflows** → Price alerts, referral tracking
4. **Deploy to your server** → Follow PRODUCTION_DEPLOYMENT.md

### This Month:
1. **Add real provider APIs** → Replace mocks
2. **Implement payments** → Stripe/LemonSqueezy
3. **Build referral program** → Commission tracking
4. **Start marketing** → Share arbitrage opportunities

---

## 🆘 Troubleshooting

### Services won't start:
```bash
cd infra
docker compose down
docker compose up -d --build
```

### Frontend not connecting:
```bash
# Check .env.local has correct URLs
cat frontend/.env.local
```

### n8n workflow fails:
1. Check execution details in n8n
2. Verify environment variables set
3. Test each node individually

### PyFlow errors:
```bash
docker compose logs pyflow
```

### Need help:
```bash
# Use management script
./scripts/manage.sh health
./scripts/manage.sh logs
```

---

## 📚 Reference URLs (Save These!)

| Service | URL | Purpose |
|---------|-----|---------|
| Frontend | http://localhost:3000 | User interface |
| Dashboard | http://localhost:3000/dashboard | Streamer dashboard |
| n8n | http://localhost:5678 | Workflow management |
| Price Engine API | http://localhost:8000/docs | API documentation |
| PyFlow API | http://localhost:8001/docs | Workflow automation |
| Uptime Kuma | http://localhost:3001 | Monitoring |

---

## 🎯 Quick Commands Reference

```bash
# Start everything
cd infra && docker compose up -d

# Stop everything
cd infra && docker compose down

# View logs
docker compose logs -f [service-name]

# Restart a service
docker compose restart [service-name]

# Check status
docker compose ps

# Frontend
cd frontend && npm run dev

# Test quote
curl -X POST http://localhost:8000/quote \
  -H "Content-Type: application/json" \
  -d '{"gpu_type":"H100","vram_gb":80,"hours":4,"region":"any","priority":"normal"}'
```

---

**You're now running a complete GPU arbitrage platform! 🚀**

Time to find those opportunities and start building your community! 💰
