/** @type {import('next').NextConfig} */
const config = {
  transpilePackages: ['@intent/ui', '@intent/types', '@intent/config'],
  experimental: {
    optimizePackageImports: ['lucide-react', 'framer-motion'],
  },
  images: {
    formats: ['image/avif', 'image/webp'],
    // The optimizer (`/_next/image`) is off until the app is on a Next line
    // with GHSA-2xp9-vwfh-vxw4 fixed (15.5.24+); `next/image` still renders,
    // serving the source file as it is. `formats` is kept for the day it is
    // turned back on. Same note in apps/dapp/next.config.js.
    unoptimized: true,
  },
}

module.exports = config
