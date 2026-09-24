import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createSponsorLedger, type SponsorLedger } from '../server/sponsor-ledger'

/**
 * The sponsor-ledger SQL, against a real Postgres.
 *
 * The unit tests prove the ledger's logic over a fake; this proves the
 * two-row upsert and that a BIGINT comes back as the string the ledger
 * expects. Runs against the Docker database (`docker compose up -d`, then
 * `DATABASE_URL=... npx vitest run sponsor-ledger.live`).
 *
 * Uses a day nobody sponsors on, and clears it before and after, so the
 * `*` row it reads is its own.
 *
 * Skipped without `DATABASE_URL`, so a CI box with no database is unaffected.
 */

const URL = process.env['DATABASE_URL']
const SKIP = URL === undefined || URL === '' || process.env['SKIP_LIVE'] === '1'

const DAY = '2000-01-01'
const RUN = `live_${Date.now().toString(36)}`
const A = `${RUN}_A`
const B = `${RUN}_B`

describe.skipIf(SKIP)('sponsor ledger against Postgres', () => {
  let pool: Pool
  let ledger: SponsorLedger

  beforeAll(async () => {
    pool = new Pool({ connectionString: URL, max: 2 })
    ledger = createSponsorLedger(async (sql, params) => {
      const result = await pool.query(sql, params)
      return { rows: result.rows as Record<string, unknown>[] }
    })
    await ledger.ensureSchema()
    await pool.query(`DELETE FROM sponsor_ledger WHERE day = $1`, [DAY])
  })

  afterAll(async () => {
    await pool.query(`DELETE FROM sponsor_ledger WHERE day = $1`, [DAY])
    await pool.end()
  })

  it('creates the schema twice without error', async () => {
    await expect(ledger.ensureSchema()).resolves.toBeUndefined()
  })

  it('records against the account and the day, and reads both back', async () => {
    await ledger.record(DAY, A, BigInt(100))
    await ledger.record(DAY, A, BigInt(250))
    await ledger.record(DAY, B, BigInt('12345678901234'))

    expect(await ledger.usage(DAY, A)).toEqual({
      totalStroops: BigInt('12345678901584'),
      totalCount: 3,
      accountStroops: BigInt(350),
      accountCount: 2,
    })
  })

  it('answers the day total alone when no account is named', async () => {
    expect(await ledger.usage(DAY)).toEqual({
      totalStroops: BigInt('12345678901584'),
      totalCount: 3,
      accountStroops: BigInt(0),
      accountCount: 0,
    })
  })
})
