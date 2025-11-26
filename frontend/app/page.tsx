import RentGPUForm from '@/components/RentGPUForm'

export default function Home() {
  return (
    <div className="min-h-screen">
      {/* Hero Section */}
      <section className="py-20 px-4">
        <div className="max-w-4xl mx-auto text-center">
          <h1 className="text-5xl font-bold mb-6">
            Rent GPUs at the Best Prices
          </h1>
          <p className="text-xl text-muted-foreground mb-8">
            We aggregate pricing from 5+ providers to find you the best deal.
            H100s, A100s, and more. Get started in seconds.
          </p>
          <div className="flex justify-center gap-4">
            <a
              href="#rent"
              className="bg-primary text-primary-foreground px-6 py-3 rounded-lg font-semibold hover:opacity-90"
            >
              Rent Now
            </a>
            <a
              href="/dashboard"
              className="border border-border px-6 py-3 rounded-lg font-semibold hover:bg-muted"
            >
              Streamer Dashboard
            </a>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="py-16 px-4 bg-muted/50">
        <div className="max-w-6xl mx-auto">
          <h2 className="text-3xl font-bold text-center mb-12">
            Why Choose GPU Black Market?
          </h2>
          <div className="grid md:grid-cols-3 gap-8">
            <div className="text-center">
              <div className="text-4xl mb-4">⚡</div>
              <h3 className="text-xl font-semibold mb-2">Best Prices</h3>
              <p className="text-muted-foreground">
                We compare 5+ providers in real-time to find you the cheapest available GPU
              </p>
            </div>
            <div className="text-center">
              <div className="text-4xl mb-4">🚀</div>
              <h3 className="text-xl font-semibold mb-2">Instant Provisioning</h3>
              <p className="text-muted-foreground">
                Get your GPU instance up and running in under 5 minutes
              </p>
            </div>
            <div className="text-center">
              <div className="text-4xl mb-4">💎</div>
              <h3 className="text-xl font-semibold mb-2">Auto-Upgrades</h3>
              <p className="text-muted-foreground">
                We automatically upgrade you to better GPUs when prices align
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Rent Form */}
      <section id="rent" className="py-20 px-4">
        <div className="max-w-2xl mx-auto">
          <h2 className="text-3xl font-bold text-center mb-8">
            Get Your Quote
          </h2>
          <RentGPUForm />
        </div>
      </section>
    </div>
  )
}
