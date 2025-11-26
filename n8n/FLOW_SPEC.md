# n8n Workflow Specification: GPU Rental Flow

This document describes the n8n workflow for handling GPU rental requests. Use this as a guide to recreate the flow in the n8n UI.

## Workflow: `gpu_rent_flow`

### Overview
This workflow receives GPU rental requests from the frontend, gets a price quote from the price-engine API, and orchestrates the full rental process including provider provisioning and database tracking.

---

## Node Configuration

### 1. Webhook Node - "Receive Rental Request"
**Type:** Webhook Trigger
**Settings:**
- **HTTP Method:** POST
- **Path:** `/webhook/rent`
- **Authentication:** None (TODO: add in production)
- **Response Mode:** "Last Node"

**Expected Input (JSON):**
```json
{
  "gpu_type": "H100",
  "vram_gb": 80,
  "hours": 4.0,
  "region": "any",
  "priority": "normal",
  "max_price_per_hour": null,
  "user_id": "optional",
  "referral_code": "optional"
}
```

---

### 2. HTTP Request Node - "Get Price Quote"
**Type:** HTTP Request
**Settings:**
- **Method:** POST
- **URL:** `http://price-engine:8000/quote`
- **Headers:**
  - `Content-Type: application/json`
- **Body:** Pass through all fields from webhook input
- **Options:**
  - Timeout: 15000ms
  - Response Format: JSON

**Output Variable:** `quote_response`

---

### 3. IF Node - "Check Quote Available"
**Type:** IF
**Settings:**
- **Condition:** `{{ $json.success }} === true`
- **True Branch:** Continue to provisioning
- **False Branch:** Jump to "Send No Capacity Response"

---

### 4. HTTP Request Node - "Provision GPU Instance" (TRUE branch)
**Type:** HTTP Request
**Settings:**
- **Method:** POST
- **URL:** Dynamic based on provider
  ```javascript
  // Use provider from quote response
  const provider = $('Get Price Quote').first().json.quote.provider;
  const providerUrls = {
    'salad': 'https://api.salad.com/v1/instances',
    'vast': 'https://console.vast.ai/api/v0/asks',
    'hyperstack': 'https://api.hyperstack.cloud/v1/instances',
    'runpod': 'https://api.runpod.io/v2/pods',
    'lambda': 'https://cloud.lambdalabs.com/api/v1/instances'
  };
  return providerUrls[provider] || 'https://mock-provider.example.com/provision';
  ```
- **Authentication:** Bearer Token (from env vars per provider)
- **Body:**
  ```json
  {
    "gpu_type": "{{ $('Get Price Quote').first().json.quote.gpu_type }}",
    "duration_hours": "{{ $('Receive Rental Request').first().json.hours }}",
    "region": "{{ $('Get Price Quote').first().json.quote.region }}"
  }
  ```

**Note:** This is a stub. Real implementation requires provider-specific payloads.

**Output Variable:** `provision_response`

---

### 5. HTTP Request Node - "Create Order in Supabase"
**Type:** HTTP Request
**Settings:**
- **Method:** POST
- **URL:** `{{ $env.SUPABASE_URL }}/rest/v1/gpu_orders`
- **Headers:**
  - `apikey: {{ $env.SUPABASE_ANON_KEY }}`
  - `Authorization: Bearer {{ $env.SUPABASE_ANON_KEY }}`
  - `Content-Type: application/json`
  - `Prefer: return=representation`
- **Body:**
  ```json
  {
    "request_id": "{{ $('Get Price Quote').first().json.quote.request_id }}",
    "user_id": "{{ $('Receive Rental Request').first().json.user_id }}",
    "referral_code": "{{ $('Receive Rental Request').first().json.referral_code }}",
    "provider": "{{ $('Get Price Quote').first().json.quote.provider }}",
    "gpu_type": "{{ $('Get Price Quote').first().json.quote.gpu_type }}",
    "vram_gb": "{{ $('Get Price Quote').first().json.quote.vram_gb }}",
    "hours": "{{ $('Receive Rental Request').first().json.hours }}",
    "base_cost": "{{ $('Get Price Quote').first().json.quote.base_hourly_cost }}",
    "margin_pct": "{{ $('Get Price Quote').first().json.quote.margin_pct }}",
    "final_cost": "{{ $('Get Price Quote').first().json.quote.final_hourly_cost }}",
    "estimated_total": "{{ $('Get Price Quote').first().json.quote.estimated_total }}",
    "status": "provisioning",
    "is_upgraded": "{{ $('Get Price Quote').first().json.quote.is_upgraded }}",
    "upgraded_from": "{{ $('Get Price Quote').first().json.quote.upgraded_from }}",
    "provider_instance_id": "{{ $('Provision GPU Instance').first().json.instance_id }}",
    "created_at": "{{ $now.toISO() }}"
  }
  ```

---

### 6. Webhook Response Node - "Send Success Response"
**Type:** Webhook Response
**Settings:**
- **Response Code:** 200
- **Response Body:**
  ```json
  {
    "success": true,
    "quote": "{{ $('Get Price Quote').first().json.quote }}",
    "order_id": "{{ $('Create Order in Supabase').first().json[0].id }}",
    "connection_info": {
      "type": "{{ $('Get Price Quote').first().json.quote.connect_instructions_type }}",
      "instance_id": "{{ $('Provision GPU Instance').first().json.instance_id }}",
      "ip_address": "{{ $('Provision GPU Instance').first().json.ip_address }}",
      "port": "{{ $('Provision GPU Instance').first().json.port }}",
      "credentials": "Check your email"
    },
    "estimated_ready_in_minutes": "{{ $('Get Price Quote').first().json.quote.estimated_provision_minutes }}"
  }
  ```

---

### 7. Webhook Response Node - "Send No Capacity Response" (FALSE branch)
**Type:** Webhook Response
**Settings:**
- **Response Code:** 503
- **Response Body:**
  ```json
  {
    "success": false,
    "error": "{{ $('Get Price Quote').first().json.error }}",
    "message": "No GPU providers available for your requested configuration. Please try different specs or check back later."
  }
  ```

---

## Environment Variables Needed

Add these to your n8n instance (Settings → Environment Variables):

```bash
# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your_anon_key_here

# Provider API Keys
SALAD_API_KEY=your_key
VAST_API_KEY=your_key
HYPERSTACK_API_KEY=your_key
RUNPOD_API_KEY=your_key
LAMBDA_API_KEY=your_key
```

---

## Flow Diagram (ASCII)

```
┌─────────────────────────┐
│ Webhook: /webhook/rent  │
└────────────┬────────────┘
             │
             v
┌─────────────────────────┐
│ HTTP: Get Price Quote   │
│ POST price-engine/quote │
└────────────┬────────────┘
             │
             v
     ┌───────IF───────┐
     │ Quote Success? │
     └───┬────────┬───┘
         │        │
      YES│        │NO
         │        │
         v        v
┌────────────┐   ┌─────────────────┐
│ Provision  │   │ Send 503 Error  │
│ GPU        │   └─────────────────┘
└─────┬──────┘
      │
      v
┌─────────────┐
│ Create      │
│ Order in DB │
└─────┬───────┘
      │
      v
┌─────────────┐
│ Send 200 OK │
└─────────────┘
```

---

## Testing the Workflow

### 1. Test Quote Endpoint (Direct)
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

### 2. Test n8n Webhook
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
    "referral_code": "STREAMER123"
  }'
```

---

## Future Enhancements

1. **Payment Integration Node** - Add Stripe/LemonSqueezy/Coinbase before provisioning
2. **Email Notification Node** - Send connection details via email
3. **Discord Webhook Node** - Notify streamer of new rental
4. **Retry Logic** - Add error handling and provider fallback
5. **Monitoring** - Send metrics to monitoring service
6. **Referral Commission Calc** - Calculate and record commission for streamer

---

## Notes

- The flow currently assumes providers return consistent response formats. Real integration will require provider-specific transformation nodes.
- Error handling should be expanded for production use.
- Consider adding authentication to the webhook endpoint.
- Rate limiting should be implemented at the ingress level (Cloudflare).
