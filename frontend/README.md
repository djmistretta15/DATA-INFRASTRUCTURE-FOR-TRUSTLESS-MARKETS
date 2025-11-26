# GPU Rental Frontend

Next.js 15 web application for GPU rental marketplace with streamer referral dashboard.

## Features

- **Landing page**: Hero, features, and GPU rental form
- **Streamer dashboard**: Earnings, referrals, and activity tracking
- **Real-time quotes**: Get live GPU pricing from multiple providers
- **Responsive design**: Mobile-first Tailwind CSS
- **Supabase integration**: Authentication and real-time data (TODO)

## Getting Started

### Prerequisites
- Node.js 20+
- npm or yarn

### Installation

```bash
# Install dependencies
npm install

# Copy environment file
cp .env.example .env.local

# Edit .env.local with your configuration
```

### Development

```bash
# Run dev server
npm run dev

# Open http://localhost:3000
```

### Build for production

```bash
npm run build
npm start
```

## Environment Variables

Create `.env.local` with:

```bash
# n8n Webhook (for production)
N8N_RENT_WEBHOOK_URL=http://localhost:5678/webhook/rent

# Price Engine (fallback for local dev)
PRICE_ENGINE_URL=http://localhost:8000

# Supabase
NEXT_PUBLIC_SUPABASE_URL=your_supabase_project_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
```

## Project Structure

```
frontend/
├── app/
│   ├── layout.tsx              # Root layout with nav
│   ├── page.tsx                # Landing page
│   ├── globals.css             # Tailwind styles
│   ├── dashboard/
│   │   └── page.tsx            # Streamer earnings dashboard
│   └── api/
│       └── rent/
│           └── route.ts        # Proxy to n8n webhook
├── components/
│   └── RentGPUForm.tsx         # Main rental form component
└── lib/
    └── supabase.ts             # Supabase client setup
```

## Pages

### Landing Page (`/`)
- Hero section with value proposition
- Features showcase
- GPU rental form
- Footer with links

### Dashboard (`/dashboard`)
- Total earnings and monthly stats
- Active referrals counter
- Referral link generator
- Recent activity feed
- Mock data (TODO: connect to Supabase)

## API Routes

### `POST /api/rent`
Proxies rental requests to n8n webhook.

**Request:**
```json
{
  "gpu_type": "H100",
  "vram_gb": 80,
  "hours": 4,
  "region": "any",
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
    "estimated_total": 11.44
  }
}
```

**Fallback:** If `N8N_RENT_WEBHOOK_URL` is not set, it calls the price-engine directly.

## Components

### `RentGPUForm`
Interactive form for requesting GPU quotes.

**Features:**
- GPU type selection (H100, A100, RTX 4090, etc.)
- VRAM and duration inputs
- Region and priority selection
- Real-time quote display
- Upgrade notifications

## Styling

Uses Tailwind CSS with custom design tokens:

```css
--primary: Main brand color
--secondary: Secondary actions
--muted: Subdued text and backgrounds
--border: Border colors
--radius: Border radius (0.5rem)
```

Dark mode is configured but not currently toggled in UI.

## Supabase Integration (TODO)

The app includes Supabase client setup but uses mock data currently.

**To enable:**
1. Create Supabase project
2. Add tables: `users`, `streamers`, `gpu_orders`, `referrals`
3. Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`
4. Replace mock data in dashboard with real queries

**Example query:**
```typescript
import { supabase } from '@/lib/supabase'

const { data, error } = await supabase
  .from('gpu_orders')
  .select('*')
  .eq('streamer_id', userId)
```

## Testing

```bash
# Run linter
npm run lint

# Type check
npx tsc --noEmit
```

## Deployment

### Vercel (Recommended)
```bash
# Install Vercel CLI
npm i -g vercel

# Deploy
vercel
```

### Docker
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN npm run build
CMD ["npm", "start"]
```

### Environment Variables in Production
Set these in your hosting platform:
- `N8N_RENT_WEBHOOK_URL` (required)
- `NEXT_PUBLIC_SUPABASE_URL` (required for auth)
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` (required for auth)

## TODO

- [ ] Connect Supabase for real dashboard data
- [ ] Add user authentication (email + OAuth)
- [ ] Implement payment flow (Stripe/LemonSqueezy)
- [ ] Add email notifications
- [ ] Build out referral tracking
- [ ] Add loading states and error boundaries
- [ ] Implement SEO metadata
- [ ] Add analytics (Plausible or PostHog)

## License

MIT License
