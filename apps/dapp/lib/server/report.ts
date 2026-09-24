/**
 * Where the server says what went wrong.
 *
 * Until now a route's `catch` ended with the client: the message went to the
 * browser and nothing went anywhere an operator would look, so a Horizon
 * outage or a pool that stopped answering was invisible until someone wrote
 * in. `reportError` is the one place both happen — a line on the server log
 * every time, and a copy to Sentry when a DSN is configured — so a route
 * gains a report by adding a call, not a dependency.
 *
 * What never leaves this module matters as much as what does. Context is
 * whatever a handler had to hand: the body, the account, the signed envelope,
 * the session. It is redacted by key before it is logged or forwarded,
 * because a log line carrying a signed XDR or a token is a leak with a
 * timestamp on it. Redaction is by name rather than by recognising values —
 * a route knows what it is passing, and a name is what it will pass next
 * time too. The one value-shaped rule is for a Stellar secret seed, which is
 * unmistakable and must not survive under any key.
 */

const REDACTED = '[redacted]'

/** Keys whose value is a credential, a signature, or something signed. */
const SECRET_KEY =
  /secret|token|password|passphrase|xdr|cookie|authorization|api.?key|private|seed|mnemonic|signature/i

/** Keys whose value is an address. Shown as its first letter and domain. */
const EMAIL_KEY = /email/i

/** A Stellar secret seed: S followed by 55 base32 characters. */
const SECRET_SEED = /S[A-Z2-7]{55}/

function maskEmail(value: unknown): string {
  if (typeof value !== 'string') return REDACTED
  const at = value.indexOf('@')
  if (at < 1) return REDACTED
  return `${value[0]}…${value.slice(at)}`
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return SECRET_SEED.test(value) ? REDACTED : value
  if (Array.isArray(value)) return value.map(redactValue)
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    return redactContext(value as Record<string, unknown>)
  }
  return value
}

/** The context as it may be logged: secrets replaced, emails masked, nested values walked. */
export function redactContext(context: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(context)) {
    if (SECRET_KEY.test(key)) out[key] = REDACTED
    else if (EMAIL_KEY.test(key)) out[key] = maskEmail(value)
    else out[key] = redactValue(value)
  }
  return out
}

/** The remote copy. Receives context already redacted. */
export interface ReportSink {
  error: (where: string, error: unknown, context: Record<string, unknown>) => void
  event: (name: string, context: Record<string, unknown>) => void
}

export interface ReporterDeps {
  /** Where the line goes. Production: the server console. */
  log: (line: string, error?: unknown) => void
  /** Absent when there is nowhere to send a copy. */
  sink?: ReportSink
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

export function createReporter(deps: ReporterDeps) {
  const { log, sink } = deps

  function forward(send: () => void): void {
    if (sink === undefined) return
    try {
      send()
    } catch {
      // The log line is the report; the copy is best effort. A reporting
      // outage must not become a second failure in the route that called us.
    }
  }

  function reportError(where: string, error: unknown, context?: Record<string, unknown>): void {
    const safe = context === undefined ? undefined : redactContext(context)
    const tail = safe === undefined ? '' : ` ${JSON.stringify(safe)}`
    log(`[${where}] ${describe(error)}${tail}`, error)
    forward(() => sink?.error(where, error, safe ?? {}))
  }

  function reportEvent(name: string, context?: Record<string, unknown>): void {
    const safe = context === undefined ? undefined : redactContext(context)
    const tail = safe === undefined ? '' : ` ${JSON.stringify(safe)}`
    log(`[${name}]${tail}`)
    forward(() => sink?.event(name, safe ?? {}))
  }

  return { reportError, reportEvent }
}

type Env = Record<string, string | undefined>

/** The DSN Sentry sends to, server side. Undefined means Sentry is off. */
export function sentryDsn(env: Env = process.env): string | undefined {
  const dsn = env['SENTRY_DSN'] ?? env['NEXT_PUBLIC_SENTRY_DSN']
  return dsn === undefined || dsn === '' ? undefined : dsn
}

/**
 * Loaded on first use, and only when a DSN is set. `@sentry/nextjs` is a
 * large module — seconds to require outside a bundle — and a deployment
 * without Sentry should pay nothing for the option of having it.
 */
let sentry: Promise<typeof import('@sentry/nextjs')> | undefined

function withSentry(use: (s: typeof import('@sentry/nextjs')) => void): void {
  if (sentryDsn() === undefined) return
  sentry ??= import('@sentry/nextjs')
  void sentry.then(use).catch(() => undefined)
}

const sentrySink: ReportSink = {
  error(where, error, context) {
    withSentry((s) => {
      s.captureException(error, { tags: { where }, extra: context })
    })
  },
  event(name, context) {
    withSentry((s) => {
      s.captureMessage(name, { level: 'info', extra: context })
    })
  },
}

export const { reportError, reportEvent } = createReporter({
  log: (line, error) => {
    if (error === undefined) console.error(line)
    else console.error(line, error)
  },
  sink: sentrySink,
})
