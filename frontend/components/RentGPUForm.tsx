'use client'

import { useState } from 'react'

type QuoteResponse = {
  success: boolean
  quote?: {
    request_id: string
    provider: string
    gpu_type: string
    vram_gb: number
    region: string
    final_hourly_cost: number
    estimated_total: number
    margin_pct: number
    is_upgraded: boolean
    upgraded_from?: string
    estimated_provision_minutes: number
  }
  error?: string
}

export default function RentGPUForm() {
  const [formData, setFormData] = useState({
    gpu_type: 'H100',
    vram_gb: '80',
    hours: '4',
    region: 'any',
    priority: 'normal',
  })

  const [loading, setLoading] = useState(false)
  const [quote, setQuote] = useState<QuoteResponse | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setQuote(null)

    try {
      const response = await fetch('/api/rent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gpu_type: formData.gpu_type,
          vram_gb: parseInt(formData.vram_gb),
          hours: parseFloat(formData.hours),
          region: formData.region,
          priority: formData.priority,
        }),
      })

      const data = await response.json()
      setQuote(data)
    } catch (error) {
      setQuote({
        success: false,
        error: 'Failed to fetch quote. Please try again.',
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <form onSubmit={handleSubmit} className="space-y-6 bg-white dark:bg-gray-800 p-8 rounded-lg border">
        <div>
          <label className="block text-sm font-medium mb-2">GPU Type</label>
          <select
            value={formData.gpu_type}
            onChange={(e) => setFormData({ ...formData, gpu_type: e.target.value })}
            className="w-full px-4 py-2 border rounded-lg bg-background"
          >
            <option value="H100">H100 (80GB)</option>
            <option value="H200">H200 (141GB)</option>
            <option value="A100">A100 (40GB)</option>
            <option value="A100-80GB">A100 (80GB)</option>
            <option value="L40S">L40S (48GB)</option>
            <option value="RTX-4090">RTX 4090 (24GB)</option>
            <option value="RTX-6000-Ada">RTX 6000 Ada (48GB)</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium mb-2">VRAM (GB)</label>
          <input
            type="number"
            min="8"
            max="640"
            value={formData.vram_gb}
            onChange={(e) => setFormData({ ...formData, vram_gb: e.target.value })}
            className="w-full px-4 py-2 border rounded-lg bg-background"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-2">Duration (hours)</label>
          <input
            type="number"
            min="0.1"
            max="720"
            step="0.1"
            value={formData.hours}
            onChange={(e) => setFormData({ ...formData, hours: e.target.value })}
            className="w-full px-4 py-2 border rounded-lg bg-background"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-2">Region</label>
          <select
            value={formData.region}
            onChange={(e) => setFormData({ ...formData, region: e.target.value })}
            className="w-full px-4 py-2 border rounded-lg bg-background"
          >
            <option value="any">Any Region (Cheapest)</option>
            <option value="us-east">US East</option>
            <option value="us-west">US West</option>
            <option value="eu-west">EU West</option>
            <option value="eu-central">EU Central</option>
            <option value="asia-pacific">Asia Pacific</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium mb-2">Priority</label>
          <select
            value={formData.priority}
            onChange={(e) => setFormData({ ...formData, priority: e.target.value })}
            className="w-full px-4 py-2 border rounded-lg bg-background"
          >
            <option value="low">Low (Save Money)</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </select>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full bg-primary text-primary-foreground px-6 py-3 rounded-lg font-semibold hover:opacity-90 disabled:opacity-50"
        >
          {loading ? 'Getting Quote...' : 'Get Quote'}
        </button>
      </form>

      {/* Quote Result */}
      {quote && (
        <div className="mt-6 p-6 rounded-lg border bg-white dark:bg-gray-800">
          {quote.success && quote.quote ? (
            <div>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-2xl font-bold">Quote Ready!</h3>
                {quote.quote.is_upgraded && (
                  <span className="bg-green-100 text-green-800 px-3 py-1 rounded-full text-sm font-semibold">
                    Upgraded!
                  </span>
                )}
              </div>

              {quote.quote.is_upgraded && (
                <div className="mb-4 p-3 bg-green-50 dark:bg-green-900/20 rounded-lg">
                  <p className="text-sm text-green-800 dark:text-green-200">
                    Great news! We upgraded you from {quote.quote.upgraded_from} to {quote.quote.gpu_type} at a similar price
                  </p>
                </div>
              )}

              <div className="space-y-3">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Provider</span>
                  <span className="font-semibold">{quote.quote.provider}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">GPU</span>
                  <span className="font-semibold">{quote.quote.gpu_type} ({quote.quote.vram_gb}GB)</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Region</span>
                  <span className="font-semibold">{quote.quote.region}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Cost per hour</span>
                  <span className="font-semibold">${quote.quote.final_hourly_cost.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-lg font-bold border-t pt-3">
                  <span>Total Estimate</span>
                  <span>${quote.quote.estimated_total.toFixed(2)}</span>
                </div>
              </div>

              <div className="mt-6 p-4 bg-muted/50 rounded-lg text-sm">
                <p className="text-muted-foreground">
                  Estimated provisioning time: ~{quote.quote.estimated_provision_minutes} minutes
                </p>
                <p className="text-muted-foreground mt-1">
                  Quote ID: {quote.quote.request_id}
                </p>
              </div>

              <button className="w-full mt-4 bg-green-600 text-white px-6 py-3 rounded-lg font-semibold hover:bg-green-700">
                Proceed to Payment
              </button>
            </div>
          ) : (
            <div className="text-red-600">
              <h3 className="font-bold mb-2">Error</h3>
              <p>{quote.error || 'Failed to get quote'}</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
