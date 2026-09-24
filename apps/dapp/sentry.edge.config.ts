import * as Sentry from '@sentry/nextjs'

import { sentryDsn } from './lib/server/report'

/**
 * Sentry on the edge runtime, where middleware runs. The same shape as the
 * Node config and the same rule: nothing happens without a DSN.
 */
const dsn = sentryDsn()

if (dsn !== undefined) {
  Sentry.init({
    dsn,
    tracesSampleRate: 0.1,
    environment: process.env['NEXT_PUBLIC_STELLAR_NETWORK'] ?? 'testnet',
  })
}
