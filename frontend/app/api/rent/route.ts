import { NextRequest, NextResponse } from 'next/server'

/**
 * Proxy endpoint that forwards GPU rental requests to n8n webhook.
 * This keeps n8n URL internal and allows us to add middleware (auth, rate limiting, etc).
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()

    // Validate required fields
    const { gpu_type, vram_gb, hours, region, priority } = body
    if (!gpu_type || !vram_gb || !hours) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields' },
        { status: 400 }
      )
    }

    // Get n8n webhook URL from environment
    const n8nWebhookUrl = process.env.N8N_RENT_WEBHOOK_URL

    if (!n8nWebhookUrl) {
      console.error('N8N_RENT_WEBHOOK_URL not configured')

      // FALLBACK: For local dev, call price-engine directly
      const priceEngineUrl = process.env.PRICE_ENGINE_URL || 'http://localhost:8000'

      try {
        const response = await fetch(`${priceEngineUrl}/quote`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })

        if (!response.ok) {
          throw new Error(`Price engine error: ${response.status}`)
        }

        const data = await response.json()
        return NextResponse.json(data)
      } catch (error) {
        console.error('Price engine fallback failed:', error)
        return NextResponse.json(
          {
            success: false,
            error: 'N8N_RENT_WEBHOOK_URL not configured and price engine fallback failed'
          },
          { status: 503 }
        )
      }
    }

    // Forward to n8n webhook
    const response = await fetch(n8nWebhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      throw new Error(`n8n webhook returned ${response.status}`)
    }

    const data = await response.json()
    return NextResponse.json(data)

  } catch (error) {
    console.error('Rent API error:', error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Internal server error',
      },
      { status: 500 }
    )
  }
}
