import * as Sentry from '@sentry/nextjs'

import { sentryDsn } from './lib/server/report'

/**
 * Sentry on the Node runtime. Loaded by `register` in instrumentation.ts,
 * and only when a DSN is set — a deployment without Sentry never loads the
 * SDK. The guard here is for anything that imports this file directly.
 *
 * Errors are always sent; the sample rate is for traces alone, and one
 * request in ten is enough to see where time goes without paying for all of
 * it. Nothing here opts into PII: an event carries the route and the stack,
 * not the person.
 */
const dsn = sentryDsn()

if (dsn !== undefined) {
  Sentry.init({
    dsn,
    tracesSampleRate: 0.1,
    environment: process.env['NEXT_PUBLIC_STELLAR_NETWORK'] ?? 'testnet',
  })
}
