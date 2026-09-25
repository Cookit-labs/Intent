const { withSentryConfig } = require('@sentry/nextjs/config')

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
  // The image optimizer (`/_next/image`) is off: the 14.2 line carries an
  // unauthenticated RCE in it (GHSA-2xp9-vwfh-vxw4) that is fixed only from
  // 15.5.24, and the server behind that route holds the sponsor key.
  // `next/image` still renders; it serves the source file as it is. Remove
  // this, and the matching audit ignore in the root package.json, once the
  // app is on a patched line.
  images: { unoptimized: true },
}

/**
 * Sentry's wrapper does two things a plain config cannot: it injects
 * sentry.client.config.ts into the browser bundle, and it turns on Next 14's
 * instrumentation hook so instrumentation.ts runs at boot. Both are inert
 * without a DSN.
 *
 * Source maps and releases are left alone entirely. Both need an auth token
 * to talk to Sentry, and a build must not depend on one — CI has none. Turn
 * `sourcemaps.disable` off, `release.create` on, and provide
 * SENTRY_AUTH_TOKEN, SENTRY_ORG and SENTRY_PROJECT when readable stacks in
 * Sentry are worth the step.
 */
module.exports = withSentryConfig(config, {
  sourcemaps: { disable: true },
  release: { create: false },
  telemetry: false,
})
