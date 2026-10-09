import { randomUUID } from 'node:crypto'

import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createOtpStore, type OtpStore } from '../server/otp'

/**
 * The sign-in code store's SQL, run against a real Postgres in a schema of its own
 * that is dropped afterwards. The in-memory fake in `otp.test.ts` checks the rules;
 * this checks that the statements really behave that way, including with several
 * connections at once. It needs DATABASE_URL and skips itself on SKIP_LIVE.
 */

const SKIP = process.env['SKIP_LIVE'] === '1' || (process.env['DATABASE_URL'] ?? '') === ''
const SCHEMA = `otp_test_${randomUUID().slice(0, 8).replace(/-/g, '')}`

let pool: Pool
let store: OtpStore

const EMAIL = 'tester@example.com'

async function sql(text: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  return (await pool.query(text, params)).rows as Record<string, unknown>[]
}

beforeAll(async () => {
  if (SKIP) return
  pool = new Pool({ connectionString: process.env['DATABASE_URL'] as string, max: 6 })
  // Every connection the pool makes works inside the test schema.
  pool.on('connect', (client) => {
    void client.query(`SET search_path TO ${SCHEMA}`)
  })
  const setup = await pool.connect()
  await setup.query(`CREATE SCHEMA ${SCHEMA}`)
  setup.release()
  store = createOtpStore(async (text, params) => ({
    rows: (await pool.query(text, params as unknown[])).rows as Record<string, unknown>[],
  }))
  await store.ensureSchema()
}, 60_000)

afterAll(async () => {
  if (SKIP || pool === undefined) return
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
  await pool.end()
})

describe.skipIf(SKIP)('the sign-in code store, against a real database', () => {
  it('makes its table again without trouble', async () => {
    await expect(store.ensureSchema()).resolves.toBeUndefined()
  })

  it('accepts the right code once, and keeps only a hash', async () => {
    const code = await store.issueCode(EMAIL)
    const [row] = await sql('select code_hash from otp_codes where email = $1', [EMAIL])
    expect(String(row?.['code_hash'])).toMatch(/^[0-9a-f]{64}$/)
    expect(String(row?.['code_hash'])).not.toContain(code)

    expect(await store.verifyCode(EMAIL, code)).toEqual({ ok: true })
    expect(await store.verifyCode(EMAIL, code)).toEqual({ ok: false, reason: 'expired' })
  })

  it('kills a code after five wrong tries', async () => {
    const email = 'five@example.com'
    const code = await store.issueCode(email)
    const wrong = code === '000000' ? '000001' : '000000'
    for (let i = 0; i < 5; i++) {
      expect(await store.verifyCode(email, wrong)).toEqual({ ok: false, reason: 'invalid' })
    }
    expect(await store.verifyCode(email, code)).toEqual({ ok: false, reason: 'too_many_attempts' })
    expect(await store.verifyCode(email, code)).toEqual({ ok: false, reason: 'expired' })
  })

  it('refuses a code once ten minutes have passed', async () => {
    const email = 'late@example.com'
    const code = await store.issueCode(email)
    await sql(`update otp_codes set expires_at = now() - interval '1 second' where email = $1`, [
      email,
    ])
    expect(await store.verifyCode(email, code)).toEqual({ ok: false, reason: 'expired' })
  })

  it('makes an address wait a minute, then lets it ask again', async () => {
    const email = 'wait@example.com'
    expect(await store.checkSendRateLimit(email)).toEqual({ allowed: true, retryAfter: 0 })
    await store.issueCode(email)
    const blocked = await store.checkSendRateLimit(email)
    expect(blocked).toMatchObject({ allowed: false, reason: 'cooldown' })
    expect(blocked.retryAfter).toBeGreaterThan(55)
    expect(blocked.retryAfter).toBeLessThanOrEqual(60)

    await sql(
      `update otp_codes set last_sent_at = now() - interval '61 seconds' where email = $1`,
      [email]
    )
    expect(await store.checkSendRateLimit(email)).toEqual({ allowed: true, retryAfter: 0 })
  })

  it('stops at five codes an hour, and starts again after an hour of quiet', async () => {
    const email = 'hour@example.com'
    for (let i = 0; i < 5; i++) {
      expect((await store.checkSendRateLimit(email)).allowed).toBe(true)
      await store.issueCode(email)
      await sql(
        `update otp_codes set last_sent_at = now() - interval '61 seconds' where email = $1`,
        [email]
      )
    }
    const blocked = await store.checkSendRateLimit(email)
    expect(blocked).toMatchObject({ allowed: false, reason: 'hourly' })
    expect(blocked.retryAfter).toBeGreaterThan(3400)
    expect(blocked.retryAfter).toBeLessThanOrEqual(3600)

    await sql(
      `update otp_codes set last_sent_at = now() - interval '61 minutes' where email = $1`,
      [email]
    )
    expect(await store.checkSendRateLimit(email)).toEqual({ allowed: true, retryAfter: 0 })
    await store.issueCode(email)
    const [row] = await sql('select sends from otp_codes where email = $1', [email])
    expect(Number(row?.['sends'])).toBe(1)
  })

  it('lets exactly one of several simultaneous right answers in', async () => {
    const email = 'race@example.com'
    const code = await store.issueCode(email)
    const results = await Promise.all(
      Array.from({ length: 6 }, () => store.verifyCode(email, code))
    )
    expect(results.filter((r) => r.ok)).toHaveLength(1)
  })

  it('lets a new code replace the old one and clears its tries', async () => {
    const email = 'again@example.com'
    const first = await store.issueCode(email)
    const wrong = first === '000000' ? '000001' : '000000'
    for (let i = 0; i < 4; i++) await store.verifyCode(email, wrong)
    await sql(
      `update otp_codes set last_sent_at = now() - interval '61 seconds' where email = $1`,
      [email]
    )
    const second = await store.issueCode(email)
    const [row] = await sql('select attempts from otp_codes where email = $1', [email])
    expect(Number(row?.['attempts'])).toBe(0)
    if (second !== first) expect((await store.verifyCode(email, first)).ok).toBe(false)
    expect((await store.verifyCode(email, second)).ok).toBe(true)
  })
})
