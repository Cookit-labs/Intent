import type { QueryFn } from '../../server/db'

/**
 * An in-memory stand-in for Postgres, for the sign-in code store.
 *
 * The store takes a query function, so its rules can be tested without a
 * database. This fake answers the statements the store issues, matched by shape,
 * and throws on anything else so a new query cannot pass by returning nothing.
 * The clock is the fake's own: `advance` moves it, which is how the tests reach
 * expiry, cooldown and the hourly window without waiting.
 *
 * The real SQL is exercised by `otp.live.test.ts` against a real Postgres when
 * `DATABASE_URL` is set.
 */

export interface FakeOtpRow {
  email: string
  code_hash: string | null
  /** Milliseconds on the fake clock. */
  expires_at: number | null
  attempts: number
  last_sent_at: number
  sends: number
}

export interface FakeOtpDb {
  query: QueryFn
  rows: Map<string, FakeOtpRow>
  log: string[]
  /** The fake clock, in milliseconds. */
  now: () => number
  advance: (seconds: number) => void
  /** When set, every statement rejects with this error. */
  down?: Error
}

const normalise = (sql: string): string => sql.replace(/\s+/g, ' ').trim()

export function fakeOtpDb(): FakeOtpDb {
  const rows = new Map<string, FakeOtpRow>()
  const log: string[] = []
  let clock = Date.UTC(2026, 9, 9, 12, 0, 0)

  const secondsLeft = (until: number): number => Math.max(0, Math.ceil((until - clock) / 1000))

  const db: FakeOtpDb = {
    rows,
    log,
    now: () => clock,
    advance: (seconds) => {
      clock += seconds * 1000
    },
    query: async (rawSql, params = []) => {
      const sql = normalise(rawSql)
      log.push(sql)
      if (db.down !== undefined) throw db.down
      const p = params as unknown[]

      if (sql.startsWith('CREATE TABLE')) return { rows: [] }

      if (sql.startsWith('INSERT INTO otp_codes')) {
        const [email, hash] = p as [string, string]
        const held = rows.get(email)
        const inWindow = held !== undefined && held.last_sent_at > clock - 3600 * 1000
        rows.set(email, {
          email,
          code_hash: hash,
          expires_at: clock + 600 * 1000,
          attempts: 0,
          sends: held === undefined ? 1 : inWindow ? held.sends + 1 : 1,
          last_sent_at: clock,
        })
        return { rows: [] }
      }

      if (sql.startsWith('SELECT') && sql.includes('FROM otp_codes')) {
        const [email] = p as [string]
        const row = rows.get(email)
        if (row === undefined) return { rows: [] }
        return {
          rows: [
            {
              cooldown: secondsLeft(row.last_sent_at + 60 * 1000),
              window: secondsLeft(row.last_sent_at + 3600 * 1000),
              sends: row.sends,
            },
          ],
        }
      }

      if (sql.startsWith('UPDATE otp_codes SET attempts = attempts + 1')) {
        const [email] = p as [string]
        const row = rows.get(email)
        if (
          row === undefined ||
          row.code_hash === null ||
          row.expires_at === null ||
          row.expires_at <= clock
        ) {
          return { rows: [] }
        }
        row.attempts += 1
        return { rows: [{ code_hash: row.code_hash, attempts: row.attempts }] }
      }

      if (sql.startsWith('UPDATE otp_codes SET code_hash = NULL, attempts = 0')) {
        const [email, hash] = p as [string, string]
        const row = rows.get(email)
        if (row === undefined || row.code_hash !== hash) return { rows: [] }
        row.code_hash = null
        row.attempts = 0
        return { rows: [{ ok: 1 }] }
      }

      if (sql.startsWith('UPDATE otp_codes SET code_hash = NULL WHERE')) {
        const [email] = p as [string]
        const row = rows.get(email)
        if (row !== undefined) row.code_hash = null
        return { rows: [] }
      }

      throw new Error(`fake db: unrecognised statement: ${sql}`)
    },
  }
  return db
}
