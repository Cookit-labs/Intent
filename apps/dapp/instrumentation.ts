import { sentryDsn } from './lib/server/report'

/**
 * Next's boot hook, turned on by `experimental.instrumentationHook` (which
 * withSentryConfig sets for Next 14). Loads the Sentry config for whichever
 * runtime is starting — and only when a DSN is set, so a deployment without
 * Sentry never loads the SDK at all.
 *
 * Next 14 has no `onRequestError` hook. What a route catches reaches Sentry
 * through `reportError` at the call site instead.
 */
export async function register(): Promise<void> {
  if (sentryDsn() === undefined) return
  if (process.env['NEXT_RUNTIME'] === 'nodejs') await import('./sentry.server.config')
  if (process.env['NEXT_RUNTIME'] === 'edge') await import('./sentry.edge.config')
}
