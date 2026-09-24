import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createRateLimiter, type RateLimiter } from '../server/rate-limit'

/**
 * The rate-limit SQL, against a real Postgres.
 *
 * The unit tests run the limiter over an in-memory fake that answers
 * statements by shape, which proves the arithmetic and nothing about the
 * SQL — the upsert's `RETURNING count` and the conflict target are only
 * checked here. Same scenarios as the unit tests, against the Docker
 * database (`docker compose up -d`, then
 * `DATABASE_URL=... npx vitest run rate-limit.live`).
 *
 * Skipped without `DATABASE_URL`, so a CI box with no database is unaffected.
 */

const URL = process.env['DATABASE_URL']
const SKIP = URL === undefined || URL === '' || process.env['SKIP_LIVE'] === '1'

const RUN = `live_${Date.now().toString(36)}`
/** Thirty seconds into the sixty-second window that starts at 10:00:00. */
const T0 = new Date('2026-09-24T10:00:30.000Z')
const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000)

describe.skipIf(SKIP)('rate limits against Postgres', () => {
  let pool: Pool
  let limiter: RateLimiter

  beforeAll(async () => {
    pool = new Pool({ connectionString: URL, max: 2 })
    limiter = createRateLimiter(async (sql, params) => {
      const result = await pool.query(sql, params)
      return { rows: result.rows as Record<string, unknown>[] }
    })
    await limiter.ensureSchema()
  })

  afterAll(async () => {
    await pool.query(`DELETE FROM rate_limits WHERE key LIKE $1`, [`${RUN}%`])
    await pool.end()
  })

  it('creates the schema twice without error', async () => {
    await expect(limiter.ensureSchema()).resolves.toBeUndefined()
  })

  it('counts within a window and refuses past the limit', async () => {
    const input = { key: `${RUN}:ip:1.2.3.4:build`, limit: 2, windowSeconds: 60, now: T0 }
    expect(await limiter.check(input)).toEqual({
      allowed: true,
      remaining: 1,
      retryAfterSeconds: 0,
    })
    expect(await limiter.check(input)).toEqual({
      allowed: true,
      remaining: 0,
      retryAfterSeconds: 0,
    })
    expect(await limiter.check({ ...input, now: at(10) })).toEqual({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 20,
    })
  })

  it('starts over in the next window', async () => {
    const input = { key: `${RUN}:ip:1.2.3.4:build`, limit: 2, windowSeconds: 60 }
    const next = await limiter.check({ ...input, now: at(30) })
    expect(next).toEqual({ allowed: true, remaining: 1, retryAfterSeconds: 0 })

    const { rows } = await pool.query<{ window_start: Date; count: number }>(
      `SELECT window_start, count FROM rate_limits WHERE key = $1 ORDER BY window_start`,
      [input.key]
    )
    expect(rows.map((r) => [r.window_start.toISOString(), r.count])).toEqual([
      ['2026-09-24T10:00:00.000Z', 3],
      ['2026-09-24T10:01:00.000Z', 1],
    ])
  })

  it('purges windows that started before the cut-off', async () => {
    await limiter.check({ key: `${RUN}:old`, limit: 5, windowSeconds: 60, now: at(-3600) })
    await limiter.check({ key: `${RUN}:new`, limit: 5, windowSeconds: 60, now: T0 })

    await limiter.purge(at(-60))

    const { rows } = await pool.query<{ key: string }>(
      `SELECT key FROM rate_limits WHERE key IN ($1, $2)`,
      [`${RUN}:old`, `${RUN}:new`]
    )
    expect(rows.map((r) => r.key)).toEqual([`${RUN}:new`])
  })
})
