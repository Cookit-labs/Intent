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
}

/**
 * Sentry's wrapper does two things a plain config cannot: it injects
 * sentry.client.config.ts into the browser bundle, and it turns on Next 14's
 * instrumentation hook so instrumentation.ts runs at boot. Both are inert
 * without a DSN.
 *
 * Source maps are left alone entirely. Uploading them needs an auth token,
 * and a build must not depend on one — CI has none. Set `sourcemaps.disable`
 * to false and provide SENTRY_AUTH_TOKEN, SENTRY_ORG and SENTRY_PROJECT when
 * readable stacks in Sentry are worth the step.
 */
module.exports = withSentryConfig(config, {
  sourcemaps: { disable: true },
  telemetry: false,
})
