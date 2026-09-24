import type { QueryFn } from '../../server/db'

/**
 * An in-memory stand-in for Postgres, for the rate limiter.
 *
 * Same idea as `standing-rules-db.ts`: the limiter takes a query function, so
 * its arithmetic can be tested without a database. This fake answers the
 * three statements the limiter issues — matched by shape, not parsed — and
 * throws on anything else. Setting `down` makes every statement fail, which
 * is how the tests reach the "database unreachable" path.
 *
 * The real SQL is exercised by `rate-limit.live.test.ts` against the Docker
 * Postgres when `DATABASE_URL` is set.
 */

export interface FakeRateLimitDb {
  query: QueryFn
  /** Window counts, keyed `<key>|<window_start ISO>`. */
  counts: Map<string, number>
  /** Every statement seen. */
  log: string[]
  /** When set, every statement rejects with this error. */
  down?: Error
}

function normalise(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

export function fakeRateLimitDb(): FakeRateLimitDb {
  const counts = new Map<string, number>()
  const log: string[] = []

  const db: FakeRateLimitDb = {
    counts,
    log,
    query: async (rawSql, params = []) => {
      const sql = normalise(rawSql)
      log.push(sql)
      if (db.down !== undefined) throw db.down
      const p = params as unknown[]

      if (sql.startsWith('CREATE TABLE') || sql.startsWith('CREATE INDEX')) {
        return { rows: [] }
      }

      if (sql.startsWith('INSERT INTO rate_limits')) {
        const [key, windowStart] = p as [string, string]
        const id = `${key}|${windowStart}`
        const count = (counts.get(id) ?? 0) + 1
        counts.set(id, count)
        return { rows: [{ count }] }
      }

      if (sql.startsWith('DELETE FROM rate_limits WHERE window_start <')) {
        const [before] = p as [string]
        const cutoff = new Date(before).getTime()
        for (const id of [...counts.keys()]) {
          const start = new Date(id.slice(id.indexOf('|') + 1)).getTime()
          if (start < cutoff) counts.delete(id)
        }
        return { rows: [] }
      }

      throw new Error(`fake db: unrecognised statement: ${sql}`)
    },
  }

  return db
}
