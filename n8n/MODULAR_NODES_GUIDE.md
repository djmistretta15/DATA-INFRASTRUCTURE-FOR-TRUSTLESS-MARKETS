# Modular n8n Nodes Library

**Philosophy:** Each node does ONE thing perfectly. Mix and match like Lego blocks to create any workflow you can imagine! 🎨

## 🧩 Available Atomic Nodes

### Pricing Nodes

#### 1. **Get Provider Prices**
**File:** `workflows/node-get-provider-prices.json`
**Input:** GPU specs (type, vram, hours, region)
**Output:** All provider quotes with prices
**Use:** Starting point for any pricing workflow

#### 2. **Find Best Price**
**File:** `workflows/node-find-best-price.json`
**Input:** Provider quotes array
**Output:** Cheapest provider + price difference
**Use:** When you need to pick the winner

#### 3. **Check Arbitrage Opportunity**
**File:** `workflows/node-check-arbitrage-opportunity.json`
**Input:** Best price + all prices
**Output:** Arbitrage calculation (margin %, profit/day)
**Use:** Discover buy-low-sell-high opportunities

### Notification Nodes

#### 4. **Send Discord Alert**
**File:** `workflows/node-send-discord-alert.json`
**Input:** Message data (title, description, fields)
**Output:** Confirmation
**Use:** Alert your team about opportunities

### User Nodes

#### 5. **Create User**
**File:** `workflows/node-create-user.json`
**Input:** Email, username, referral code
**Output:** User object from Supabase
**Use:** Onboard new customers/streamers

#### 6. **Track Referral**
**File:** `workflows/node-track-referral.json`
**Input:** Referrer ID, conversion value
**Output:** Referral record with commission
**Use:** Track who brought whom + calculate commissions

---

## 🎯 Example Compositions

### 1. **Arbitrage Alert Bot** (Monitor Only - No Execution)

**What it does:** Every 15 minutes, check for arbitrage opportunities and alert on Discord

**Nodes to connect:**
```
Cron (15 min)
  → Get Provider Prices
  → Find Best Price
  → Check Arbitrage Opportunity
  → IF (has_opportunity = true)
    → Send Discord Alert
```

**How to build:**
1. Import all 4 node workflows
2. Create new workflow "Arbitrage Monitor"
3. Add Cron trigger → every 15 minutes
4. Add Execute Workflow node → "Node: Get Provider Prices"
5. Add Execute Workflow node → "Node: Find Best Price"
6. Add Execute Workflow node → "Node: Check Arbitrage Opportunity"
7. Add IF node → `{{ $json.has_opportunity }} === true`
8. On TRUE → Execute Workflow → "Node: Send Discord Alert"

**Configuration:**
- Set `min_margin_pct` to your threshold (e.g., 15% for aggressive, 25% for conservative)
- Add your Discord webhook URL to environment variables

---

### 2. **User Signup with Referral Flow**

**What it does:** User signs up → create account → track referral → send welcome message

**Nodes to connect:**
```
Webhook (/signup)
  → Create User
  → IF (has referral_code)
    → Track Referral
    → Send Discord Alert (notify referrer)
  → Send Email (welcome email)
  → Respond (success)
```

**How to build:**
1. Webhook trigger on `/signup`
2. Execute Workflow → "Node: Create User"
3. IF node → check if `referral_code` exists
4. TRUE branch → Execute Workflow → "Node: Track Referral"
5. Execute Workflow → "Node: Send Discord Alert" (notify the streamer who referred them)
6. Send Email node → welcome email
7. Respond to Webhook → success message

---

### 3. **Show User the Savings** (Onboarding Focus)

**What it does:** User requests quote → show them how much they're saving vs. direct provider

**Nodes to connect:**
```
Webhook (/quote)
  → Get Provider Prices
  → Find Best Price
  → Calculate Savings (Code node)
  → Respond with Savings Message
```

**Code node (Calculate Savings):**
```javascript
const best = $input.first().json;
const directPrice = best.market_avg;  // What they'd pay directly
const ourPrice = best.best_price + (best.best_price * 0.10);  // Our 10% margin
const savings = directPrice - ourPrice;
const savingsPct = (savings / directPrice) * 100;

return {
  direct_price: directPrice,
  our_price: ourPrice,
  you_save: savings,
  savings_pct: savingsPct,
  message: `🎉 You save $${savings.toFixed(2)}/hr (${savingsPct.toFixed(1)}%) by renting through us vs. going direct!`
};
```

---

### 4. **Streamer Dashboard Data Feed**

**What it does:** Provide real-time data for streamer dashboard

**Nodes to connect:**
```
Webhook (/dashboard/:streamer_id)
  → Query Supabase (get referrals)
  → Query Supabase (get earnings)
  → Calculate Stats (Code node)
  → Respond (JSON)
```

---

### 5. **Opportunity Alert → Human Approval → Execute**

**What it does:** Find arbitrage → send to Discord with approve button → if approved, reserve GPU

**Nodes to connect:**
```
Cron
  → Get Provider Prices
  → Find Best Price
  → Check Arbitrage Opportunity
  → IF (has_opportunity)
    → Send Discord (with reaction buttons)
    → Wait for Discord reaction
    → IF (approved)
      → Call PyFlow (/flows/arbitrage with execute_trades=true)
      → Send Confirmation
```

---

## 🎨 Creative Combinations

### **Price Drop Alert**
Monitor specific GPU → if price drops below threshold → alert customer

```
Cron (hourly)
  → Get Provider Prices (H100)
  → IF (price < $2.50)
    → Query Supabase (users watching H100)
    → Send Email to each
```

### **Referral Leaderboard**
Calculate top referrers weekly

```
Cron (Monday 9am)
  → Query Supabase (referrals last 7 days)
  → Sort by commission_amount
  → Format as leaderboard
  → Send Discord
```

### **Dynamic Margin Adjuster**
Adjust your margin based on competition

```
Cron (every 30 min)
  → Get Provider Prices
  → Find Best Price
  → IF (price_difference < $0.20)  # Tight competition
    → Lower our margin to 8%
  → ELSE
    → Increase margin to 15%
  → Update price-engine config
```

---

## 📋 Import Instructions

### Quick Import All Nodes:

1. Open n8n: http://localhost:5678
2. For each workflow in `n8n/workflows/`:
   - Click "Workflows" → "Import from file"
   - Select the JSON file
   - Save
3. Now you have a library of reusable nodes!

### Using Execute Workflow Node:

In any workflow, add:
- **Execute Workflow** node
- Select: "Node: Get Provider Prices" (or any atomic node)
- Pass data via `$json`
- Receive output in next node

---

## 🚀 Best Practices

### 1. **Start Simple, Compound Later**
Begin with: Get Prices → Alert
Then add: Margin calculation, user tracking, etc.

### 2. **Test Each Node Independently**
Use the "Test Workflow" button with sample data

### 3. **Use Tags**
Tag workflows: `atomic-node`, `pricing`, `notifications`, `users`

### 4. **Version Control**
Export your composed workflows regularly

### 5. **Environment Variables**
Store secrets in n8n environment:
- `DISCORD_WEBHOOK_URL`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

---

## 🎯 Your First Workflow: "Show Opportunities (No Execution)"

**Goal:** Build an arbitrage monitor that just shows you opportunities

**Steps:**
1. Import these nodes:
   - `node-get-provider-prices.json`
   - `node-find-best-price.json`
   - `node-check-arbitrage-opportunity.json`
   - `node-send-discord-alert.json`

2. Create new workflow: "Arbitrage Monitor"

3. Add nodes in this order:
   ```
   a) Cron → "Every 15 minutes"
   b) Set → Create data object:
      {
        "gpu_type": "H100",
        "vram_gb": 80,
        "hours": 24,
        "region": "any",
        "priority": "normal"
      }
   c) Execute Workflow → "Node: Get Provider Prices"
   d) Execute Workflow → "Node: Find Best Price"
      Input: {{ $json }}
   e) Execute Workflow → "Node: Check Arbitrage Opportunity"
      Input: {{ $json }}
      Add field: min_margin_pct = 20
   f) IF → {{ $json.has_opportunity }} === true
   g) TRUE → Execute Workflow → "Node: Send Discord Alert"
      Input: {
        "type": "arbitrage",
        "opportunity": {{ $json }}
      }
   ```

4. Save and activate!

**Result:** Every 15 minutes you'll get Discord alerts when there's a 20%+ arbitrage opportunity!

---

## 🔮 Future Node Ideas

Want to add more capabilities? Create these atomic nodes:

- **Node: Send Email** - Email notifications
- **Node: Log Activity** - Track all actions to Supabase
- **Node: Calculate Commission** - Referral math
- **Node: Check Inventory** - See what GPUs you have reserved
- **Node: Get User Profile** - Fetch user data
- **Node: Update Margins** - Adjust pricing dynamically
- **Node: Send Slack** - Team notifications
- **Node: Create Invoice** - Generate billing
- **Node: Verify Payment** - Check Stripe/LemonSqueezy

---

## 💡 Philosophy

> "Make each node do one thing perfectly. Then compose them into workflows that do extraordinary things."

Your n8n becomes a **visual programming environment** for your GPU business. Change, test, and deploy in minutes - no code required!

**You have complete freedom to experiment.** 🎨

---

## 🆘 Support

- **Test a node:** Use n8n's "Execute Node" button
- **Debug:** Check execution logs in n8n
- **Modify:** Each node is just JSON - edit and customize
- **Share:** Export your composed workflows and share them

**Now go build something amazing!** 🚀
