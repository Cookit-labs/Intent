import { NextResponse } from 'next/server'

import { getPool, withTimeout, type QueryFn } from './db'

/**
 * Fixed-window rate limits, counted in Postgres.
 *
 * Postgres rather than memory because the app runs as serverless functions,
 * and a counter in one instance's memory limits nothing. Postgres rather
 * than Redis because only the OTP flow uses Redis and everything else here
 * is already Postgres. A fixed window is the simplest thing that holds: one
 * upsert per request, one row per (key, window), the count coming back on
 * the same round trip.
 *
 * The rule when the database cannot be reached is to allow. A limiter exists
 * to keep the app up under abuse; one that takes the app down when its own
 * store blinks has the priorities backwards. It says so once, in the log,
 * and is then quiet until the process restarts.
 */

export type RateLimitFamily = 'build' | 'submit' | 'compete' | 'resolve' | 'standing' | 'auth'

export interface RateLimitWindow {
  limit: number
  windowSeconds: number
}

/**
 * Per family, per key, per window. A key is one address or one account, so
 * these are what a single caller gets, not what the deployment serves. The
 * costly families are `compete`, which runs several models, and `build`,
 * which simulates against the RPC; `submit` is the one that spends the
 * sponsor's balance.
 */
export const RATE_LIMIT_DEFAULTS: Readonly<Record<RateLimitFamily, RateLimitWindow>> = {
  build: { limit: 30, windowSeconds: 60 },
  submit: { limit: 10, windowSeconds: 60 },
  compete: { limit: 10, windowSeconds: 60 },
  resolve: { limit: 30, windowSeconds: 60 },
  standing: { limit: 30, windowSeconds: 60 },
  auth: { limit: 10, windowSeconds: 60 },
}

type Env = Record<string, string | undefined>

/**
 * The family's window, or the `RATE_LIMIT_<FAMILY>=count/seconds` override
 * when it parses. An override that does not parse keeps the default rather
 * than opening the family up: a typo in a limit should not remove it.
 */
export function limitFor(family: RateLimitFamily, env: Env = process.env): RateLimitWindow {
  const raw = env[`RATE_LIMIT_${family.toUpperCase()}`]
  const match = raw === undefined ? null : /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(raw)
  if (match !== null) {
    const limit = Number(match[1])
    const windowSeconds = Number(match[2])
    if (limit > 0 && windowSeconds > 0) return { limit, windowSeconds }
  }
  return RATE_LIMIT_DEFAULTS[family]
}

export interface RateLimitInput {
  key: string
  limit: number
  windowSeconds: number
  now?: Date
}

export interface RateLimitDecision {
  allowed: boolean
  /** Requests left in this window after this one. */
  remaining: number
  /** Seconds until the window resets when refused; 0 when allowed. */
  retryAfterSeconds: number
}

export interface RateLimiter {
  ensureSchema: () => Promise<void>
  check: (input: RateLimitInput) => Promise<RateLimitDecision>
  /** Drops the windows that started before `before`. */
  purge: (before: Date) => Promise<void>
}

/**
 * The table, as the migration file also states it. Duplicated for the same
 * reason as `STANDING_RULES_DDL`: the migration runs only at first container
 * init, and this runs on first use. Keep the two in sync.
 */
export const RATE_LIMITS_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS rate_limits (
    key          TEXT        NOT NULL,
    window_start TIMESTAMPTZ NOT NULL,
    count        INTEGER     NOT NULL DEFAULT 0,
    PRIMARY KEY (key, window_start)
  )`,
  `CREATE INDEX IF NOT EXISTS rate_limits_window_idx ON rate_limits (window_start)`,
]

export function createRateLimiter(query: QueryFn): RateLimiter {
  return {
    async ensureSchema() {
      for (const statement of RATE_LIMITS_DDL) await query(statement)
    },

    async check({ key, limit, windowSeconds, now = new Date() }) {
      // Windows are aligned to the clock, not to the first request, so every
      // instance agrees on which row a request belongs to without reading
      // anything first.
      const windowMs = windowSeconds * 1000
      const start = Math.floor(now.getTime() / windowMs) * windowMs

      const { rows } = await query(
        `INSERT INTO rate_limits (key, window_start, count) VALUES ($1, $2, 1)
         ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1
         RETURNING count`,
        [key, new Date(start).toISOString()]
      )
      const count = Number(rows[0]?.['count'] ?? 1)
      const allowed = count <= limit

      return {
        allowed,
        remaining: Math.max(0, limit - count),
        retryAfterSeconds: allowed
          ? 0
          : Math.max(1, Math.ceil((start + windowMs - now.getTime()) / 1000)),
      }
    },

    async purge(before) {
      await query(`DELETE FROM rate_limits WHERE window_start < $1`, [before.toISOString()])
    },
  }
}

/**
 * The production limiter, over the shared pool. The schema promise is cached
 * on `globalThis` for the reason the pool is: Next's dev server re-evaluates
 * modules on hot reload.
 */
const globalForLimits = globalThis as unknown as { intentRateLimitSchema?: Promise<void> }

async function getRateLimiter(): Promise<RateLimiter> {
  const pool = getPool()
  const limiter = createRateLimiter(async (sql, params) => {
    const result = await pool.query(sql, params)
    return { rows: result.rows as Record<string, unknown>[] }
  })

  if (globalForLimits.intentRateLimitSchema === undefined) {
    globalForLimits.intentRateLimitSchema = limiter.ensureSchema().catch((e: unknown) => {
      // A failed attempt must not be cached as success, or every later call
      // would skip the DDL and fail on a missing table.
      delete globalForLimits.intentRateLimitSchema
      throw e
    })
  }
  await globalForLimits.intentRateLimitSchema

  return limiter
}

export interface RateLimitDeps {
  limiter: () => Promise<RateLimiter>
  /** How long the database has to answer before the request goes through unlimited. */
  timeoutMs?: number
  env?: Env
}

/** A check that has not answered in this long is treated as unreachable. */
const CHECK_TIMEOUT_MS = 2_000
/** Windows older than this are dropped, at most hourly per process. */
const PURGE_OLDER_THAN_MS = 24 * 3_600_000
const PURGE_EVERY_MS = 3_600_000

let warnedUnreachable = false
let nextPurgeAt = 0

export async function checkRateLimit(
  input: RateLimitInput,
  deps: RateLimitDeps = { limiter: getRateLimiter }
): Promise<RateLimitDecision> {
  try {
    return await withTimeout(
      (async () => {
        const limiter = await deps.limiter()
        const decision = await limiter.check(input)
        // Housekeeping rides on a request rather than a scheduler because
        // there is no scheduler; the delete is indexed and not awaited.
        const now = Date.now()
        if (now >= nextPurgeAt) {
          nextPurgeAt = now + PURGE_EVERY_MS
          void limiter.purge(new Date(now - PURGE_OLDER_THAN_MS)).catch(() => undefined)
        }
        return decision
      })(),
      deps.timeoutMs ?? CHECK_TIMEOUT_MS
    )
  } catch (e) {
    if (!warnedUnreachable) {
      warnedUnreachable = true
      console.warn(
        `[rate-limit] database unreachable, allowing every request: ${
          e instanceof Error ? e.message : String(e)
        }`
      )
    }
    return { allowed: true, remaining: input.limit, retryAfterSeconds: 0 }
  }
}

/**
 * The address a request came from, as the proxy in front reports it. The
 * first hop of `x-forwarded-for` is the client; later hops are proxies.
 *
 * The header is only as honest as the proxy that sets it. A platform that
 * writes it from the connection (Vercel does) makes the key the client's
 * real address; one that merely appends leaves the first hop to the client,
 * who could then pick their own bucket. This deployment's proxy is assumed
 * to write it. What is guarded here is a different abuse: a value too long
 * to be an address would fail the key's index, and that failure would read
 * as "database unreachable" and allow. Such a value is ignored. With no
 * usable header the request is counted under one shared key, which limits
 * a deployment with no proxy as a whole rather than not at all.
 */
const MAX_ADDRESS_LENGTH = 64

export function clientIp(request: Request): string {
  const first = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  if (first !== undefined && first !== '' && first.length <= MAX_ADDRESS_LENGTH) return first
  const real = request.headers.get('x-real-ip')?.trim()
  if (real !== undefined && real !== '' && real.length <= MAX_ADDRESS_LENGTH) return real
  return 'unknown'
}

/**
 * The first statement of every POST route: a 429 to return, or nothing.
 *
 * Counted by address always, and by account as well when the caller knows
 * it; either key running out refuses. The response carries `Retry-After`
 * so a client that reads headers can wait exactly long enough.
 */
export async function enforceRateLimit(
  request: Request,
  family: RateLimitFamily,
  account?: string,
  deps?: RateLimitDeps
): Promise<NextResponse | undefined> {
  const window = limitFor(family, deps?.env)
  const keys = [`ip:${clientIp(request)}:${family}`]
  if (account !== undefined && account !== '') keys.push(`account:${account}:${family}`)

  for (const key of keys) {
    const decision = await checkRateLimit({ key, ...window }, deps)
    if (!decision.allowed) {
      return NextResponse.json(
        { error: 'rate_limited', retryAfter: decision.retryAfterSeconds },
        { status: 429, headers: { 'Retry-After': String(decision.retryAfterSeconds) } }
      )
    }
  }
  return undefined
}
