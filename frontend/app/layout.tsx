import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'GPU Black Market - Rent GPUs at the Best Prices',
  description: 'Find and rent the best GPU deals across multiple providers instantly',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <nav className="border-b">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex justify-between h-16 items-center">
              <div className="flex-shrink-0 font-bold text-xl">
                GPU Black Market
              </div>
              <div className="flex space-x-4">
                <a href="/" className="text-sm hover:text-primary">
                  Home
                </a>
                <a href="/dashboard" className="text-sm hover:text-primary">
                  Dashboard
                </a>
              </div>
            </div>
          </div>
        </nav>
        <main>{children}</main>
        <footer className="border-t mt-16">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 text-center text-sm text-muted-foreground">
            © 2025 GPU Black Market. Built for streamers, by streamers.
          </div>
        </footer>
      </body>
    </html>
  )
}
