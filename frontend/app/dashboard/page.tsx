'use client'

import { useEffect, useState } from 'react'

// TODO: Replace with real Supabase integration
type EarningsData = {
  total_earnings: number
  this_month: number
  active_referrals: number
  total_rentals: number
}

export default function Dashboard() {
  const [earnings, setEarnings] = useState<EarningsData>({
    total_earnings: 0,
    this_month: 0,
    active_referrals: 0,
    total_rentals: 0,
  })

  useEffect(() => {
    // TODO: Fetch real data from Supabase
    // Mock data for now
    setEarnings({
      total_earnings: 1247.50,
      this_month: 342.25,
      active_referrals: 23,
      total_rentals: 156,
    })
  }, [])

  const referralLink = `${typeof window !== 'undefined' ? window.location.origin : ''}/?ref=STREAMER123`

  return (
    <div className="min-h-screen py-12 px-4">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-4xl font-bold mb-8">Streamer Dashboard</h1>

        {/* Stats Grid */}
        <div className="grid md:grid-cols-4 gap-6 mb-12">
          <div className="bg-white dark:bg-gray-800 p-6 rounded-lg border">
            <div className="text-sm text-muted-foreground mb-1">Total Earnings</div>
            <div className="text-3xl font-bold">${earnings.total_earnings.toFixed(2)}</div>
          </div>
          <div className="bg-white dark:bg-gray-800 p-6 rounded-lg border">
            <div className="text-sm text-muted-foreground mb-1">This Month</div>
            <div className="text-3xl font-bold">${earnings.this_month.toFixed(2)}</div>
          </div>
          <div className="bg-white dark:bg-gray-800 p-6 rounded-lg border">
            <div className="text-sm text-muted-foreground mb-1">Active Referrals</div>
            <div className="text-3xl font-bold">{earnings.active_referrals}</div>
          </div>
          <div className="bg-white dark:bg-gray-800 p-6 rounded-lg border">
            <div className="text-sm text-muted-foreground mb-1">Total Rentals</div>
            <div className="text-3xl font-bold">{earnings.total_rentals}</div>
          </div>
        </div>

        {/* Referral Link */}
        <div className="bg-muted/50 p-8 rounded-lg mb-12">
          <h2 className="text-2xl font-bold mb-4">Your Referral Link</h2>
          <p className="text-muted-foreground mb-4">
            Share this link with your community to earn commissions on every GPU rental
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              readOnly
              value={referralLink}
              className="flex-1 px-4 py-2 border rounded-lg bg-background"
            />
            <button
              onClick={() => navigator.clipboard.writeText(referralLink)}
              className="bg-primary text-primary-foreground px-6 py-2 rounded-lg font-semibold hover:opacity-90"
            >
              Copy
            </button>
          </div>
        </div>

        {/* Recent Activity */}
        <div>
          <h2 className="text-2xl font-bold mb-4">Recent Activity</h2>
          <div className="bg-white dark:bg-gray-800 rounded-lg border">
            <div className="p-4 border-b">
              <div className="flex justify-between items-center">
                <div>
                  <div className="font-semibold">H100 Rental</div>
                  <div className="text-sm text-muted-foreground">user_abc123 - 4 hours</div>
                </div>
                <div className="text-green-600 font-semibold">+$12.40</div>
              </div>
            </div>
            <div className="p-4 border-b">
              <div className="flex justify-between items-center">
                <div>
                  <div className="font-semibold">A100 Rental</div>
                  <div className="text-sm text-muted-foreground">user_xyz789 - 8 hours</div>
                </div>
                <div className="text-green-600 font-semibold">+$18.60</div>
              </div>
            </div>
            <div className="p-4">
              <div className="flex justify-between items-center">
                <div>
                  <div className="font-semibold">RTX 4090 Rental</div>
                  <div className="text-sm text-muted-foreground">user_def456 - 2 hours</div>
                </div>
                <div className="text-green-600 font-semibold">+$3.20</div>
              </div>
            </div>
          </div>
        </div>

        {/* TODO Notice */}
        <div className="mt-8 p-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
          <p className="text-sm text-yellow-800 dark:text-yellow-200">
            <strong>TODO:</strong> This dashboard currently shows mock data. Connect to Supabase to see real earnings and activity.
          </p>
        </div>
      </div>
    </div>
  )
}
