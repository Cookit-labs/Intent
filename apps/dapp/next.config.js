/** @type {import('next').NextConfig} */
const config = {
  transpilePackages: ['@intent/ui', '@intent/types', '@intent/config', '@intent/sdk'],
  experimental: {
    optimizePackageImports: ['lucide-react', 'framer-motion', 'recharts'],
  },
}

module.exports = config
