/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    // Enable Server Actions
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },
}

module.exports = nextConfig
