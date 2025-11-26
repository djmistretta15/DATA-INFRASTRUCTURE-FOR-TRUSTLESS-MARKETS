# Production Deployment Guide

Complete guide to deploy GPU Black Market 2.0 to your personal server with CI/CD, mobile management, and full integration.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                  Your Personal Server                    │
│                                                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │   n8n        │  │  Price Engine│  │   PyFlow     │  │
│  │   :5678      │◄─┤   :8000      │◄─┤   :8001      │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
│         │                  │                   │         │
│         └──────────────────┴───────────────────┘         │
│                          │                               │
│                    ┌─────▼─────┐                         │
│                    │   Redis   │                         │
│                    │   :6379   │                         │
│                    └───────────┘                         │
└─────────────────────────────────────────────────────────┘
                            │
                            │ Cloudflare Tunnel
                            │
                    ┌───────▼───────┐
                    │   Internet    │
                    └───────────────┘
                            │
              ┌─────────────┼─────────────┐
              │             │             │
         ┌────▼───┐    ┌────▼───┐   ┌────▼───┐
         │Frontend│    │ GitHub │   │Terminus│
         │(Vercel)│    │Actions │   │  iPad  │
         └────────┘    └────────┘   └────────┘
```

---

## Prerequisites

### Your Personal Server
- **OS:** Ubuntu 22.04+ (recommended)
- **RAM:** 4GB minimum, 8GB recommended
- **Storage:** 50GB minimum
- **CPU:** 2+ cores
- **Network:** Public IP or dynamic DNS

### Required Accounts
- ✅ GitHub account (you have this)
- ✅ Cloudflare account (free tier OK)
- ✅ Supabase account (free tier OK)
- Optional: Vercel for frontend hosting

### Your Devices
- ✅ iPad with Terminus (you have this)
- ✅ SSH access to your server

---

## Part 1: Initial Server Setup

### Step 1: Connect to Your Server

```bash
# From Terminus on iPad or any terminal
ssh your-username@your-server-ip
```

### Step 2: Install Dependencies

```bash
# Update system
sudo apt-get update && sudo apt-get upgrade -y

# Install Docker
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER

# Install Docker Compose
sudo apt-get install -y docker-compose-plugin

# Install useful tools
sudo apt-get install -y git curl jq htop

# Logout and back in for docker group to take effect
exit
```

### Step 3: Clone Repository

```bash
# SSH back in
ssh your-username@your-server-ip

# Clone your repo
sudo mkdir -p /opt/gpu-black-market
sudo chown $USER:$USER /opt/gpu-black-market
cd /opt/gpu-black-market

git clone https://github.com/YOUR_USERNAME/DATA-INFRASTRUCTURE-FOR-TRUSTLESS-MARKETS.git .
```

### Step 4: Configure Environment

```bash
# Copy environment templates
cp infra/.env.example infra/.env
cp price-engine/.env.example price-engine/.env
cp frontend/.env.example frontend/.env.local

# Edit with your API keys
nano infra/.env
```

**Important variables to set in `infra/.env`:**
```bash
# n8n
N8N_HOST=your-domain.com
N8N_BASIC_AUTH_PASSWORD=strong_password_here

# Margins
BASE_MARGIN_PCT=15
SURGE_ENABLED=true

# Provider API Keys (get these from providers)
SALAD_API_KEY=your_key
VAST_API_KEY=your_key
# ... etc
```

### Step 5: Start Services

```bash
cd /opt/gpu-black-market/infra
docker compose up -d

# Check status
docker compose ps

# View logs
docker compose logs -f
```

**Services will be running on:**
- n8n: http://localhost:5678
- Price Engine: http://localhost:8000
- PyFlow: http://localhost:8001
- Redis: localhost:6379
- Uptime Kuma: http://localhost:3001

---

## Part 2: Cloudflare Tunnel Setup

This exposes your services securely without opening ports!

### Step 1: Install Cloudflared

```bash
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb
```

### Step 2: Authenticate

```bash
cloudflared tunnel login
```

This will open a browser. Login to Cloudflare and select your domain.

### Step 3: Create Tunnel

```bash
cloudflared tunnel create gpu-market

# Note the tunnel ID from output
```

### Step 4: Configure Tunnel

Create `/opt/gpu-black-market/cloudflared-config.yml`:

```yaml
tunnel: YOUR_TUNNEL_ID
credentials-file: /root/.cloudflared/YOUR_TUNNEL_ID.json

ingress:
  # Frontend (if self-hosted)
  - hostname: yourdomain.com
    service: http://localhost:3000

  # n8n
  - hostname: n8n.yourdomain.com
    service: http://localhost:5678

  # Price Engine API
  - hostname: api.yourdomain.com
    service: http://localhost:8000

  # PyFlow API
  - hostname: pyflow.yourdomain.com
    service: http://localhost:8001

  # Catch-all
  - service: http_status:404
```

### Step 5: Start Tunnel

```bash
sudo cloudflared service install
sudo systemctl start cloudflared
sudo systemctl enable cloudflared

# Check status
sudo systemctl status cloudflared
```

### Step 6: Configure DNS

In Cloudflare dashboard:
1. Go to your domain
2. DNS settings
3. Add CNAME records:
   - `n8n` → your-tunnel-id.cfargotunnel.com
   - `api` → your-tunnel-id.cfargotunnel.com
   - `pyflow` → your-tunnel-id.cfargotunnel.com

**Now accessible at:**
- https://n8n.yourdomain.com
- https://api.yourdomain.com
- https://pyflow.yourdomain.com

---

## Part 3: GitHub Actions CI/CD

### Step 1: Add GitHub Secrets

In your GitHub repo:
1. Go to Settings → Secrets and variables → Actions
2. Add these secrets:

```
SSH_PRIVATE_KEY     = Your SSH private key
SERVER_HOST         = your-server-ip
SERVER_USER         = your-username
DEPLOY_PATH         = /opt/gpu-black-market
SLACK_WEBHOOK       = (optional) your Slack webhook URL
```

**Generate SSH key for deployment:**
```bash
# On your local machine
ssh-keygen -t ed25519 -C "github-actions" -f ~/.ssh/github-deploy

# Copy public key to server
ssh-copy-id -i ~/.ssh/github-deploy.pub your-username@your-server-ip

# Copy private key content to GitHub secret
cat ~/.ssh/github-deploy
# Paste this into SSH_PRIVATE_KEY secret
```

### Step 2: Push to Main Branch

```bash
git push origin main
```

GitHub Actions will automatically:
1. Run tests
2. Build Docker images
3. Push to GitHub Container Registry
4. Deploy to your server
5. Restart services

---

## Part 4: Mobile Management with Terminus

### Quick Commands from Your iPad

Add this alias to your server's `~/.bashrc`:

```bash
alias gm='/opt/gpu-black-market/scripts/manage.sh'
```

Then reload:
```bash
source ~/.bashrc
```

### Terminus Shortcuts

From your iPad's Terminus app:

```bash
# Check status
gm status

# View logs
gm logs price-engine

# Test quote
gm quote H100

# Run arbitrage scan
gm arb

# Health check
gm health

# Restart everything
gm restart

# Update to latest
gm update
```

### Create Terminus Widget (iOS)

1. Open Shortcuts app on iPad
2. Create new shortcut: "GPU Status"
3. Add action: "Run Script Over SSH"
4. Server: your-server-ip
5. Script: `/opt/gpu-black-market/scripts/manage.sh status`
6. Add to home screen

Now you can check status with one tap!

---

## Part 5: n8n + PyFlow Integration

### Import n8n Workflow

```bash
# In Terminus or SSH
curl https://n8n.yourdomain.com
# Login: admin / your_password

# Import workflow
# 1. Click "Workflows" → "Import from file"
# 2. Select: n8n/gpu-rental-workflow.json
# 3. Activate workflow
```

### Add PyFlow Triggers in n8n

**Create Arbitrage Schedule:**

1. In n8n, create new workflow
2. Add "Cron" node:
   - Name: "Arbitrage Bot Schedule"
   - Mode: "Every 15 minutes"
3. Add "HTTP Request" node:
   - Method: POST
   - URL: `http://pyflow:8001/flows/arbitrage`
   - Body JSON:
     ```json
     {
       "gpu_types": ["H100", "A100"],
       "min_margin_pct": 20.0,
       "execute_trades": false,
       "notification_webhook": "https://n8n.yourdomain.com/webhook/arbitrage-alert"
     }
     ```
4. Save and activate

**Create Pricing Optimizer Schedule:**

1. Add "Cron" node: every 30 minutes
2. Add "HTTP Request" to `http://pyflow:8001/flows/pricing-optimizer`

---

## Part 6: Frontend Deployment (Vercel)

### Option A: Deploy to Vercel (Recommended)

```bash
# Install Vercel CLI on your local machine
npm i -g vercel

# Deploy frontend
cd frontend
vercel

# Add environment variables in Vercel dashboard:
N8N_RENT_WEBHOOK_URL=https://n8n.yourdomain.com/webhook/rent
NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_key
```

### Option B: Self-host Frontend

Add to `infra/docker-compose.yml`:

```yaml
frontend:
  build:
    context: ../frontend
    dockerfile: Dockerfile
  ports:
    - "3000:3000"
  environment:
    - N8N_RENT_WEBHOOK_URL=http://n8n:5678/webhook/rent
  networks:
    - gpu-network
```

---

## Part 7: Monitoring & Alerts

### Uptime Kuma Setup

1. Open: https://yourdomain.com:3001
2. Create monitors for:
   - Price Engine: `http://price-engine:8000/health`
   - PyFlow: `http://pyflow:8001/health`
   - n8n: `http://n8n:5678`
   - Frontend: your Vercel URL

### n8n Alert Workflow

Create workflow:
1. Webhook trigger: `/webhook/alert`
2. Discord/Slack/Email node
3. Use from Uptime Kuma

---

## Part 8: Maintenance

### Daily Tasks (Automated)

```bash
# Add to crontab
crontab -e
```

Add:
```cron
# Health check every 5 minutes
*/5 * * * * /opt/gpu-black-market/scripts/manage.sh health

# Daily backup at 2 AM
0 2 * * * /opt/gpu-black-market/scripts/manage.sh backup

# Update every Sunday at 3 AM
0 3 * * 0 /opt/gpu-black-market/scripts/manage.sh update
```

### From Terminus

```bash
# Morning check
gm health && gm stats

# View overnight activity
gm logs --since 8h

# Test quote
gm quote H100

# Check arbitrage opportunities
gm arb
```

---

## Part 9: Security Checklist

- [ ] Change default n8n password
- [ ] Enable Cloudflare WAF rules
- [ ] Setup Fail2Ban for SSH
- [ ] Use strong API keys
- [ ] Enable Supabase RLS policies
- [ ] Setup database backups
- [ ] Enable Docker log rotation
- [ ] Setup SSL certificates (via Cloudflare)
- [ ] Review n8n webhook authentication
- [ ] Enable rate limiting in Cloudflare

---

## Troubleshooting

### Services Won't Start

```bash
# Check logs
gm logs

# Check resources
gm stats

# Restart
gm restart
```

### Can't Access from Internet

```bash
# Check Cloudflare tunnel
sudo systemctl status cloudflared
sudo cloudflared tunnel info

# Check firewall
sudo ufw status
```

### Database Issues

```bash
# Connect to Redis
gm redis

# Check keys
KEYS *

# Check memory
INFO memory
```

---

## Support & Resources

- **Management Tool:** `/opt/gpu-black-market/scripts/manage.sh`
- **Logs:** `gm logs [service]`
- **Health:** `gm health`
- **GitHub Actions:** Check repo's Actions tab
- **n8n Docs:** https://docs.n8n.io
- **PyFlow Status:** http://pyflow.yourdomain.com/docs

---

## Quick Reference Card

Save this in Terminus for quick access:

```bash
# Status & Health
gm status              # Service status
gm health              # Health checks
gm stats               # Resource usage

# Operations
gm start               # Start all
gm stop                # Stop all
gm restart             # Restart all
gm update              # Git pull + rebuild

# Testing
gm quote H100          # Test quote
gm arb                 # Run arbitrage scan

# Debugging
gm logs price-engine   # View logs
gm shell price-engine  # Open shell
gm redis               # Redis CLI

# Maintenance
gm backup              # Create backup
```

---

**You're all set! 🚀**

Your GPU rental platform is now:
- ✅ Running on your personal server
- ✅ Auto-deploying from GitHub
- ✅ Accessible via Cloudflare Tunnel
- ✅ Manageable from your iPad
- ✅ Integrated with PyFlow for automation
- ✅ Monitored and backed up

Next: Add real provider API keys and start making money! 💰
