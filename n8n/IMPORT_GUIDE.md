# n8n Workflow Import Guide

Quick guide to import and configure the GPU rental workflow.

## Step 1: Start n8n

```bash
cd infra
docker compose up -d n8n
```

Open http://localhost:5678 and login with:
- **Username:** admin
- **Password:** changeme (or what you set in `.env`)

---

## Step 2: Import Workflow

1. In n8n, click **"Workflows"** in the sidebar
2. Click **"Add workflow"** → **"Import from file"**
3. Select: `n8n/gpu-rental-workflow.json`
4. Click **"Import"**

You should now see the complete GPU rental flow with all nodes connected!

---

## Step 3: Configure Environment Variables

The workflow uses environment variables for sensitive data.

### In n8n UI:
1. Click your profile icon (top-right)
2. Go to **Settings** → **Environments**
3. Add these variables:

```bash
# Required
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your_supabase_anon_key_here

# Optional (for provider provisioning later)
SALAD_API_KEY=your_salad_key
VAST_API_KEY=your_vast_key
HYPERSTACK_API_KEY=your_hyperstack_key
RUNPOD_API_KEY=your_runpod_key
LAMBDA_API_KEY=your_lambda_key
```

### Or via Docker Environment:

Edit `infra/docker-compose.yml`:

```yaml
n8n:
  environment:
    - SUPABASE_URL=https://your-project.supabase.co
    - SUPABASE_ANON_KEY=your_key_here
```

Then restart:
```bash
docker compose restart n8n
```

---

## Step 4: Enable/Disable Nodes

The workflow has one **disabled node** by default:

- **"Create Order in Supabase"** - Enable this once you have Supabase configured

To enable:
1. Click the node
2. Toggle the **"Disabled"** switch in the right panel

---

## Step 5: Activate Workflow

1. Click the toggle in the top-right: **"Inactive"** → **"Active"**
2. Your webhook is now live!

**Webhook URL:**
```
http://localhost:5678/webhook/rent
```

For production with Cloudflare Tunnel:
```
https://yourdomain.com/webhook/rent
```

---

## Step 6: Test the Workflow

### Test from Command Line:

```bash
curl -X POST http://localhost:5678/webhook/rent \
  -H "Content-Type: application/json" \
  -d '{
    "gpu_type": "H100",
    "vram_gb": 80,
    "hours": 4,
    "region": "any",
    "priority": "normal",
    "user_id": "test_user_123",
    "referral_code": "STREAMER456"
  }'
```

### Expected Response:

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
    "final_hourly_cost": 2.86,
    "hours": 4.0,
    "estimated_total": 11.44,
    "is_upgraded": false
  },
  "order_id": "mock_order_id",
  "message": "Quote generated successfully. Proceed to payment.",
  "next_step": "payment"
}
```

### Test from Frontend:

1. Start the frontend:
   ```bash
   cd frontend
   npm install
   npm run dev
   ```

2. Visit http://localhost:3000

3. Fill out the "Get Your Quote" form

4. You should see the quote appear with provider, pricing, and GPU details!

---

## Step 7: View Execution History

1. In n8n, click **"Executions"** in the sidebar
2. You'll see all workflow runs with:
   - Input data
   - Each node's output
   - Success/failure status
   - Execution time

Great for debugging!

---

## Workflow Node Overview

Here's what each node does:

| Node | Type | Description |
|------|------|-------------|
| **Receive Rental Request** | Webhook | Listens for POST requests on `/webhook/rent` |
| **Get Price Quote** | HTTP Request | Calls price-engine at `http://price-engine:8000/quote` |
| **Check Quote Available** | IF | Routes to success or error based on quote availability |
| **Prepare Order Data** | Code | Transforms quote data for Supabase insert |
| **Create Order in Supabase** | HTTP Request | Inserts order into `gpu_orders` table (disabled by default) |
| **Send Success Response** | Respond to Webhook | Returns 200 with quote and order details |
| **Send No Capacity Response** | Respond to Webhook | Returns 503 when no GPUs available |

---

## Troubleshooting

### Issue: "price-engine:8000 connection refused"

**Cause:** Price engine container not running or not on same Docker network.

**Fix:**
```bash
cd infra
docker compose up -d price-engine
docker compose logs price-engine
```

Ensure `price-engine` is healthy:
```bash
curl http://localhost:8000/health
```

---

### Issue: "Supabase unauthorized"

**Cause:** Missing or incorrect `SUPABASE_ANON_KEY`.

**Fix:**
1. Get your key from Supabase dashboard: Settings → API → anon public
2. Add to n8n environment variables
3. Restart workflow

---

### Issue: Webhook returns 404

**Cause:** Workflow not activated.

**Fix:**
1. Open the workflow
2. Click the "Inactive" toggle to activate
3. Ensure "Webhook" node has path set to `rent`

---

## Next Steps

### 1. Connect to Real Supabase

Create these tables in Supabase SQL Editor:

```sql
-- GPU Orders table
CREATE TABLE gpu_orders (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  request_id TEXT UNIQUE NOT NULL,
  user_id UUID REFERENCES auth.users(id),
  referral_code TEXT,
  provider TEXT NOT NULL,
  gpu_type TEXT NOT NULL,
  vram_gb INTEGER NOT NULL,
  region TEXT NOT NULL,
  hours NUMERIC NOT NULL,
  base_hourly_cost NUMERIC NOT NULL,
  margin_pct NUMERIC NOT NULL,
  final_hourly_cost NUMERIC NOT NULL,
  estimated_total NUMERIC NOT NULL,
  status TEXT DEFAULT 'pending_payment',
  is_upgraded BOOLEAN DEFAULT FALSE,
  upgraded_from TEXT,
  connect_instructions_type TEXT,
  provider_instance_id TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable Row Level Security
ALTER TABLE gpu_orders ENABLE ROW LEVEL SECURITY;

-- Policy: Users can view their own orders
CREATE POLICY "Users can view own orders"
  ON gpu_orders FOR SELECT
  USING (auth.uid() = user_id);

-- Policy: Service role can insert orders
CREATE POLICY "Service role can insert"
  ON gpu_orders FOR INSERT
  WITH CHECK (true);
```

Then enable the "Create Order in Supabase" node.

---

### 2. Add Payment Processing

Add a new branch after "Prepare Order Data":

1. Add **Stripe** node (or HTTP Request to Stripe API)
2. Create payment intent
3. Return payment URL to user
4. Add webhook to handle payment success
5. Then provision GPU

---

### 3. Add Email Notifications

After successful order:

1. Add **Send Email** node (Gmail, SendGrid, etc.)
2. Send connection details:
   - SSH credentials
   - IP address
   - Port
   - Setup instructions

---

### 4. Add Provider Provisioning

Replace the mock provisioning with real API calls:

1. Duplicate the "Check Quote Available" IF node
2. Add provider-specific HTTP Request nodes:
   - Salad → `https://api.salad.com/v1/instances`
   - Vast → `https://console.vast.ai/api/v0/asks`
   - RunPod → `https://api.runpod.io/v2/pods`
   - etc.
3. Parse response for instance ID, IP, credentials
4. Store in Supabase

---

## Additional Resources

- **n8n Documentation:** https://docs.n8n.io
- **n8n Community Forum:** https://community.n8n.io
- **Price Engine API Docs:** http://localhost:8000/docs
- **Python Integration Guide:** `n8n/PYTHON_INTEGRATION_GUIDE.md`

---

## Support

Questions or issues?
- Check n8n execution logs
- Check price-engine logs: `docker compose logs price-engine`
- Review the workflow execution in n8n UI
