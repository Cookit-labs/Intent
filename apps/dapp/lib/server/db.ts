import { Pool } from 'pg'

/**
 * Postgres pool, shared across route handlers.
 *
 * Note on where this lives: the Go backend in the sibling repo also owns a
 * Postgres connection and a router. Auth is implemented here instead so the
 * gate ships with the frontend and needs no second service running to test.
 * When the two consolidate, these handlers are the thing to move — they are
 * deliberately thin for that reason.
 *
 * The pool is cached on `globalThis` because Next's dev server re-evaluates
 * modules on every hot reload; without this, each edit would leak a pool and
 * Postgres would refuse connections after a few dozen saves.
 */
const globalForDb = globalThis as unknown as { intentPool?: Pool }

/**
 * Whether a database is configured at all.
 *
 * Distinct from whether one answers. A configured database that cannot be
 * reached is a blip the stores built on it ride out (the limiter allows,
 * the sponsor ledger sponsors without its books); one that was never
 * configured is a deployment error, and the callers that must not run
 * without a ledger — the fee sponsor — refuse rather than ride it out.
 */
export function databaseConfigured(env: Record<string, string | undefined> = process.env): boolean {
  const url = env['DATABASE_URL']
  return url !== undefined && url.trim() !== ''
}

export function getPool(): Pool {
  const existing = globalForDb.intentPool
  if (existing !== undefined) return existing

  if (!databaseConfigured()) {
    throw new Error('DATABASE_URL is not set. Run `docker compose up -d` and check .env.local')
  }

  const pool = new Pool({ connectionString: process.env['DATABASE_URL'], max: 5 })
  globalForDb.intentPool = pool
  return pool
}

/**
 * What the repositories take instead of the pool, so unit tests can run them
 * over an in-memory fake. The production wiring adapts `pool.query` to it.
 */
export type QueryFn = (
  sql: string,
  params?: unknown[]
) => Promise<{ rows: Record<string, unknown>[] }>

/**
 * Rejects when `work` has not settled within `ms`.
 *
 * The pool has no connect timeout of its own, and a host that drops packets
 * would otherwise hold a request for as long as the OS takes to give up. For
 * the stores that must never block — the limiter, the sponsor ledger — that
 * is the difference between a slow database and a down app. The work itself
 * is not cancelled; the caller has simply moved on.
 */
export function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer after ${ms}ms`)), ms)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (e: unknown) => {
        clearTimeout(timer)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    )
  })
}

export type WaitlistStatus = 'pending' | 'accepted' | 'rejected'

export interface WaitlistEntry {
  id: string
  email: string
  status: WaitlistStatus
  note: string | null
  createdAt: string
  acceptedAt: string | null
  firstLoginAt: string | null
}

/**
 * Emails are compared case-insensitively everywhere. Doing the normalisation in
 * one exported function (rather than at each call site) is what stops
 * `Foo@x.com` signing up twice or missing an acceptance recorded as `foo@x.com`.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

interface WaitlistRow {
  id: string
  email: string
  status: WaitlistStatus
  note: string | null
  created_at: Date
  accepted_at: Date | null
  first_login_at: Date | null
}

function toEntry(row: WaitlistRow): WaitlistEntry {
  return {
    id: String(row.id),
    email: row.email,
    status: row.status,
    note: row.note,
    createdAt: row.created_at.toISOString(),
    acceptedAt: row.accepted_at?.toISOString() ?? null,
    firstLoginAt: row.first_login_at?.toISOString() ?? null,
  }
}

export async function findByEmail(email: string): Promise<WaitlistEntry | undefined> {
  const { rows } = await getPool().query<WaitlistRow>(
    'SELECT * FROM waitlist_signups WHERE email = $1',
    [normalizeEmail(email)]
  )
  const row = rows[0]
  return row === undefined ? undefined : toEntry(row)
}

/**
 * Records a signup. Re-submitting an existing email is not an error — it keeps
 * the original row and status, so someone already accepted cannot demote
 * themselves to pending by signing up again.
 */
export async function addSignup(email: string, note: string | null): Promise<WaitlistEntry> {
  const { rows } = await getPool().query<WaitlistRow>(
    `INSERT INTO waitlist_signups (email, note)
     VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET note = COALESCE(EXCLUDED.note, waitlist_signups.note)
     RETURNING *`,
    [normalizeEmail(email), note]
  )
  return toEntry(rows[0] as WaitlistRow)
}

export async function setStatus(email: string, status: WaitlistStatus): Promise<void> {
  await getPool().query(
    `UPDATE waitlist_signups
     SET status = $2,
         accepted_at = CASE WHEN $2 = 'accepted' AND accepted_at IS NULL THEN now() ELSE accepted_at END
     WHERE email = $1`,
    [normalizeEmail(email), status]
  )
}

export async function markFirstLogin(email: string): Promise<void> {
  await getPool().query(
    `UPDATE waitlist_signups
     SET first_login_at = COALESCE(first_login_at, now())
     WHERE email = $1`,
    [normalizeEmail(email)]
  )
}

export async function listSignups(): Promise<WaitlistEntry[]> {
  const { rows } = await getPool().query<WaitlistRow>(
    'SELECT * FROM waitlist_signups ORDER BY created_at DESC LIMIT 500'
  )
  return rows.map(toEntry)
}
