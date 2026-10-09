import { createHash, randomInt, timingSafeEqual } from 'node:crypto'

import { getPool, withTimeout, type QueryFn } from './db'

/**
 * One-time sign-in codes, in Postgres.
 *
 * One row per address holds the hash of the live code, when it expires, how many
 * tries it has had and when and how often a code was last sent. The database's own
 * clock decides every expiry, so servers with different clocks agree, and each
 * state change is a single statement, so two requests at once cannot both win.
 *
 * Every code expires by comparing `expires_at` with `now()` when it is read, so
 * nothing depends on a cleanup job that could stop and leave a code alive.
 *
 * The rules are the ones this store has always had: a code lives ten minutes, dies
 * after five wrong tries, is used once, and an address waits a minute between codes
 * and gets five an hour.
 */

export const CODE_TTL_SECONDS = 10 * 60
const MAX_ATTEMPTS = 5
/** Shortest gap between two sends to the same address. */
const RESEND_COOLDOWN_SECONDS = 60
/** Sends allowed per address per hour, counted from the most recent send. */
const HOURLY_SEND_LIMIT = 5
const HOUR_SECONDS = 3600

export const OTP_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS otp_codes (
    email        TEXT        PRIMARY KEY,
    code_hash    TEXT,
    expires_at   TIMESTAMPTZ,
    attempts     INTEGER     NOT NULL DEFAULT 0,
    last_sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    sends        INTEGER     NOT NULL DEFAULT 0
  )`,
]

/**
 * Codes are stored hashed, never in plaintext. A database snapshot, a stray query,
 * or an operator glancing at the table should not yield a working login code for
 * someone else's account.
 */
function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex')
}

/** Six digits via a CSPRNG. `Math.random` is predictable and unfit for this. */
function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

export interface RateLimitResult {
  allowed: boolean
  /** Seconds until another send is permitted, when blocked. */
  retryAfter: number
  reason?: 'cooldown' | 'hourly'
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'expired' | 'invalid' | 'too_many_attempts' }

export interface OtpStore {
  ensureSchema: () => Promise<void>
  checkSendRateLimit: (email: string) => Promise<RateLimitResult>
  /** Issues a code and returns the plaintext, which only the email may contain. */
  issueCode: (email: string) => Promise<string>
  verifyCode: (email: string, submitted: string) => Promise<VerifyResult>
}

const num = (value: unknown): number => {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

export function createOtpStore(query: QueryFn): OtpStore {
  return {
    async ensureSchema() {
      for (const statement of OTP_DDL) await query(statement)
    },

    async checkSendRateLimit(email) {
      const { rows } = await query(
        `SELECT
           GREATEST(0, CEIL(EXTRACT(EPOCH FROM (last_sent_at + interval '${RESEND_COOLDOWN_SECONDS} seconds' - now()))))::int AS cooldown,
           GREATEST(0, CEIL(EXTRACT(EPOCH FROM (last_sent_at + interval '${HOUR_SECONDS} seconds' - now()))))::int AS "window",
           sends
         FROM otp_codes WHERE email = $1`,
        [email]
      )
      const row = rows[0]
      if (row === undefined) return { allowed: true, retryAfter: 0 }

      const cooldown = num(row['cooldown'])
      if (cooldown > 0) return { allowed: false, retryAfter: cooldown, reason: 'cooldown' }

      const window = num(row['window'])
      if (window > 0 && num(row['sends']) >= HOURLY_SEND_LIMIT) {
        return { allowed: false, retryAfter: window, reason: 'hourly' }
      }
      return { allowed: true, retryAfter: 0 }
    },

    async issueCode(email) {
      const code = generateCode()
      // A new code replaces the old one and clears its tries. The hour's count keeps
      // growing while sends keep coming, and starts again after an hour of quiet.
      await query(
        `INSERT INTO otp_codes (email, code_hash, expires_at, attempts, last_sent_at, sends)
         VALUES ($1, $2, now() + interval '${CODE_TTL_SECONDS} seconds', 0, now(), 1)
         ON CONFLICT (email) DO UPDATE SET
           code_hash = EXCLUDED.code_hash,
           expires_at = EXCLUDED.expires_at,
           attempts = 0,
           sends = CASE
             WHEN otp_codes.last_sent_at > now() - interval '${HOUR_SECONDS} seconds'
               THEN otp_codes.sends + 1
             ELSE 1
           END,
           last_sent_at = now()`,
        [email, hashCode(code)]
      )
      return code
    },

    /**
     * Checks a submitted code, consuming it on success.
     *
     * A try is counted before the code is compared, so a wrong guess burns one and
     * the code dies after `MAX_ATTEMPTS`. That cap is what makes a 6-digit secret
     * safe: without it, a million guesses is a few minutes of scripted requests.
     */
    async verifyCode(email, submitted) {
      const { rows } = await query(
        `UPDATE otp_codes SET attempts = attempts + 1
         WHERE email = $1 AND code_hash IS NOT NULL AND expires_at > now()
         RETURNING code_hash, attempts`,
        [email]
      )
      const row = rows[0]
      if (row === undefined) return { ok: false, reason: 'expired' }

      const stored = String(row['code_hash'])

      if (num(row['attempts']) > MAX_ATTEMPTS) {
        await query(`UPDATE otp_codes SET code_hash = NULL WHERE email = $1`, [email])
        return { ok: false, reason: 'too_many_attempts' }
      }

      // Constant-time compare so response timing cannot reveal a correct prefix.
      const a = Buffer.from(hashCode(submitted), 'hex')
      const b = Buffer.from(stored, 'hex')
      if (!(a.length === b.length && timingSafeEqual(a, b))) return { ok: false, reason: 'invalid' }

      // Consumed by one statement that only succeeds for the code just matched, so two
      // requests with the right code at once cannot both get in.
      const used = await query(
        `UPDATE otp_codes SET code_hash = NULL, attempts = 0
         WHERE email = $1 AND code_hash = $2
         RETURNING 1 AS ok`,
        [email, stored]
      )
      return used.rows.length === 1 ? { ok: true } : { ok: false, reason: 'expired' }
    },
  }
}

const QUERY_TIMEOUT_MS = 8_000

const globalForOtp = globalThis as unknown as { intentOtpStore?: Promise<OtpStore> }

/**
 * The production store, over the shared pool. The table is made on first use, like
 * the others here. A database that is down or not set fails the call, and a failed
 * call is a refused sign-in: nobody gets in on an error.
 */
function getOtpStore(): Promise<OtpStore> {
  if (globalForOtp.intentOtpStore === undefined) {
    globalForOtp.intentOtpStore = (async () => {
      const pool = getPool()
      const store = createOtpStore(async (sql, params) => {
        const result = await withTimeout(pool.query(sql, params), QUERY_TIMEOUT_MS)
        return { rows: result.rows as Record<string, unknown>[] }
      })
      await store.ensureSchema()
      return store
    })().catch((e: unknown) => {
      // A failed attempt must not be remembered as a working store.
      delete globalForOtp.intentOtpStore
      throw e
    })
  }
  return globalForOtp.intentOtpStore
}

export async function checkSendRateLimit(email: string): Promise<RateLimitResult> {
  return (await getOtpStore()).checkSendRateLimit(email)
}

export async function issueCode(email: string): Promise<string> {
  return (await getOtpStore()).issueCode(email)
}

export async function verifyCode(email: string, submitted: string): Promise<VerifyResult> {
  return (await getOtpStore()).verifyCode(email, submitted)
}
