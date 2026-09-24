import * as Sentry from '@sentry/nextjs'

/**
 * Sentry in the browser. `withSentryConfig` in next.config.js injects this
 * file into the client bundle; nothing imports it by hand.
 *
 * Inert without a DSN: `init` is not called, so a build with no
 * NEXT_PUBLIC_SENTRY_DSN ships the SDK and never starts it. No session
 * replay, nothing opting into PII — an event carries the stack and the
 * page, not the person or their wallet.
 */
const dsn = process.env['NEXT_PUBLIC_SENTRY_DSN']

if (dsn !== undefined && dsn !== '') {
  Sentry.init({
    dsn,
    tracesSampleRate: 0.1,
    environment: process.env['NEXT_PUBLIC_STELLAR_NETWORK'] ?? 'testnet',
  })
}
