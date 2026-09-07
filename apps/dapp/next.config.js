/** @type {import('next').NextConfig} */
const config = {
  transpilePackages: ['@intent/ui', '@intent/types', '@intent/config', '@intent/sdk'],
  async redirects() {
    // Routes moved under a chain segment. These keep pre-multichain links (and
    // the bare root) working by sending them to the default chain.
    const paths = [
      'intents',
      'agents',
      'apps',
      'analytics',
      'history',
      'vault',
      'settings',
      'competitions',
      'leaderboard',
    ]
    return [
      { source: '/', destination: '/arc/intents', permanent: false },
      ...paths.map((p) => ({
        source: `/${p}`,
        destination: `/arc/${p}`,
        permanent: false,
      })),
      ...paths.map((p) => ({
        source: `/${p}/:path*`,
        destination: `/arc/${p}/:path*`,
        permanent: false,
      })),
    ]
  },
  experimental: {
    optimizePackageImports: ['lucide-react', 'framer-motion', 'recharts'],
  },
}

module.exports = config
