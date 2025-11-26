# Python Integration with n8n

This guide covers three approaches for integrating Python code with n8n workflows.

## Approach 1: HTTP Requests to Price Engine (Current - RECOMMENDED)

This is the current architecture and **most production-ready** approach.

**Pros:**
- Clean separation of concerns
- Price engine can scale independently
- Easy to test and debug
- Can use any Python libraries without n8n constraints

**Cons:**
- Requires separate service deployment

**Already implemented** in the workflow - the price engine runs as a separate Docker container and n8n calls it via HTTP.

---

## Approach 2: n8n Code Node with Python (via Execute Command)

n8n's Code node runs JavaScript by default, but you can execute Python scripts using the Execute Command node.

### Setup

1. Install Python in the n8n container:

```dockerfile
# Add to n8n Dockerfile or use custom image
FROM n8nio/n8n:latest
USER root
RUN apk add --no-cache python3 py3-pip
RUN pip3 install httpx redis pydantic
USER node
```

2. Create a Python script that n8n can execute:

**File: `n8n/scripts/get_quote.py`**
```python
#!/usr/bin/env python3
import sys
import json
import asyncio
from pathlib import Path

# Add price-engine to path
sys.path.insert(0, '/app/price-engine')

from app.providers.salad import SaladProvider
from app.providers.vast import VastProvider
from app.core.models import QuoteRequest, GPUType, Region, Priority

async def get_quote(request_data):
    """Get quote from providers."""
    # Parse input
    req = QuoteRequest(**request_data)

    # Initialize providers
    providers = [
        SaladProvider(),
        VastProvider(),
    ]

    # Get quotes concurrently
    tasks = [
        provider.get_quote(req.gpu_type, req.vram_gb, req.hours, req.region)
        for provider in providers
    ]
    quotes = await asyncio.gather(*tasks)

    # Find best quote
    available = [q for q in quotes if q.available]
    if not available:
        return {"success": False, "error": "No providers available"}

    best = min(available, key=lambda q: q.total_cost)

    return {
        "success": True,
        "quote": best.model_dump()
    }

if __name__ == "__main__":
    # Read JSON from stdin
    input_data = json.loads(sys.stdin.read())
    result = asyncio.run(get_quote(input_data))
    print(json.dumps(result))
```

3. **Add Execute Command node in n8n:**

**Node Configuration:**
- **Command:** `python3`
- **Arguments:** `/app/n8n/scripts/get_quote.py`
- **Input Data:** Pass via stdin (JSON)

**Code:**
```javascript
// In previous node, prepare data
return {
  json: {
    gpu_type: "H100",
    vram_gb: 80,
    hours: 4,
    region: "any",
    priority: "normal"
  }
};
```

---

## Approach 3: Custom n8n Node Package (Advanced)

Create a custom n8n node that wraps your Python logic. This gives you a native n8n experience.

### Step 1: Create Node Package

```bash
cd n8n
mkdir -p custom-nodes/n8n-nodes-gpu-pricing
cd custom-nodes/n8n-nodes-gpu-pricing
npm init -y
```

**File: `package.json`**
```json
{
  "name": "n8n-nodes-gpu-pricing",
  "version": "0.1.0",
  "description": "GPU pricing nodes for n8n",
  "main": "index.js",
  "n8n": {
    "n8nNodesApiVersion": 1,
    "nodes": [
      "dist/nodes/GpuQuote/GpuQuote.node.js"
    ]
  },
  "keywords": ["n8n-community-node-package"],
  "dependencies": {
    "axios": "^1.6.0"
  },
  "devDependencies": {
    "n8n-workflow": "^1.0.0"
  }
}
```

**File: `nodes/GpuQuote/GpuQuote.node.ts`**
```typescript
import {
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
} from 'n8n-workflow';
import axios from 'axios';

export class GpuQuote implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'GPU Quote',
    name: 'gpuQuote',
    group: ['transform'],
    version: 1,
    description: 'Get GPU pricing quotes from multiple providers',
    defaults: {
      name: 'GPU Quote',
    },
    inputs: ['main'],
    outputs: ['main'],
    properties: [
      {
        displayName: 'GPU Type',
        name: 'gpuType',
        type: 'options',
        options: [
          { name: 'H100', value: 'H100' },
          { name: 'H200', value: 'H200' },
          { name: 'A100', value: 'A100' },
          { name: 'A100-80GB', value: 'A100-80GB' },
          { name: 'L40S', value: 'L40S' },
          { name: 'RTX 4090', value: 'RTX-4090' },
        ],
        default: 'H100',
        required: true,
      },
      {
        displayName: 'VRAM (GB)',
        name: 'vramGb',
        type: 'number',
        default: 80,
        required: true,
      },
      {
        displayName: 'Hours',
        name: 'hours',
        type: 'number',
        default: 4,
        required: true,
      },
      {
        displayName: 'Region',
        name: 'region',
        type: 'options',
        options: [
          { name: 'Any', value: 'any' },
          { name: 'US East', value: 'us-east' },
          { name: 'US West', value: 'us-west' },
          { name: 'EU West', value: 'eu-west' },
        ],
        default: 'any',
      },
      {
        displayName: 'Priority',
        name: 'priority',
        type: 'options',
        options: [
          { name: 'Low', value: 'low' },
          { name: 'Normal', value: 'normal' },
          { name: 'High', value: 'high' },
          { name: 'Urgent', value: 'urgent' },
        ],
        default: 'normal',
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const returnData: INodeExecutionData[] = [];

    for (let i = 0; i < items.length; i++) {
      const gpuType = this.getNodeParameter('gpuType', i) as string;
      const vramGb = this.getNodeParameter('vramGb', i) as number;
      const hours = this.getNodeParameter('hours', i) as number;
      const region = this.getNodeParameter('region', i) as string;
      const priority = this.getNodeParameter('priority', i) as string;

      // Call price engine API
      const priceEngineUrl = process.env.PRICE_ENGINE_URL || 'http://price-engine:8000';
      const response = await axios.post(`${priceEngineUrl}/quote`, {
        gpu_type: gpuType,
        vram_gb: vramGb,
        hours,
        region,
        priority,
      });

      returnData.push({
        json: response.data,
        pairedItem: i,
      });
    }

    return [returnData];
  }
}
```

### Step 2: Build and Install

```bash
# Build the node
npm install
npm run build

# Install in n8n
cd ~/.n8n/nodes
npm install /path/to/n8n-nodes-gpu-pricing

# Or for Docker:
# Copy to /home/node/.n8n/custom/
```

### Step 3: Restart n8n

```bash
docker compose restart n8n
```

Now you'll see "GPU Quote" as a native node in n8n!

---

## Approach 4: PyFlow Integration (Workflow Orchestration)

If you want to use PyFlow (Python workflow library) alongside n8n:

### Option A: PyFlow as a Service

Run PyFlow as a separate service that n8n can trigger:

```python
# File: pyflow-service/workflow.py
from prefect import flow, task
import httpx

@task
def get_provider_quotes(gpu_type, vram_gb, hours, region):
    """Get quotes from all providers."""
    # Your provider logic here
    pass

@task
def calculate_margin(quote, demand):
    """Calculate dynamic margin."""
    # Your surge pricing logic
    pass

@flow
def gpu_rental_flow(request_data):
    """Main PyFlow workflow."""
    quotes = get_provider_quotes(**request_data)
    best_quote = min(quotes, key=lambda q: q.cost)
    final_quote = calculate_margin(best_quote, demand)
    return final_quote

# Expose as FastAPI endpoint
from fastapi import FastAPI
app = FastAPI()

@app.post("/pyflow/rent")
async def trigger_flow(request: dict):
    result = gpu_rental_flow(request)
    return result
```

Then n8n calls this PyFlow service via HTTP.

### Option B: PyFlow + n8n Hybrid

Use n8n for external integrations (webhooks, Supabase, Stripe) and PyFlow for complex Python business logic:

```
n8n Webhook → PyFlow Service → n8n (payment) → PyFlow (provision) → n8n (email)
```

---

## Comparison Table

| Approach | Setup Complexity | Scalability | Maintainability | Best For |
|----------|-----------------|-------------|-----------------|----------|
| HTTP to Price Engine | Low | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | **Production (CURRENT)** |
| Execute Command | Medium | ⭐⭐⭐ | ⭐⭐⭐ | Quick scripts |
| Custom n8n Node | High | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | Native n8n UX |
| PyFlow Service | Medium | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | Complex workflows |

---

## Recommendation

**Stick with Approach 1 (HTTP to Price Engine)** for your MVP because:

1. ✅ Already implemented and working
2. ✅ Clean architecture (microservices)
3. ✅ Easy to scale (scale price-engine independently)
4. ✅ Easy to test (can test price-engine without n8n)
5. ✅ Can use full Python ecosystem without n8n constraints

**Consider Approach 3 (Custom Node)** later if you want:
- Native n8n UI for GPU operations
- Drag-and-drop GPU provider nodes
- Non-technical users configuring workflows

**Consider PyFlow** if you need:
- Complex Python-native workflow DAGs
- Prefect/Airflow-style scheduling
- Heavy data processing pipelines

---

## Quick Start: Import the Workflow

1. Open n8n: http://localhost:5678
2. Click "Workflows" → "Import from File"
3. Select `n8n/gpu-rental-workflow.json`
4. Set environment variables in Settings:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
5. Activate the workflow
6. Webhook URL will be: `http://localhost:5678/webhook/rent`

Test it:
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
