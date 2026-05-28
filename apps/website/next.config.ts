import type { NextConfig } from 'next'

const config: NextConfig = {
  transpilePackages: ['@intent/ui', '@intent/types', '@intent/config'],
  experimental: {
    optimizePackageImports: ['lucide-react', 'framer-motion'],
  },
  images: {
    formats: ['image/avif', 'image/webp'],
  },
}

export default config