import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createStandingRulesRepo, type StandingRulesRepo } from '../server/standing-rules'
import type { StandingIntent } from '../standing-intent'

/**
 * The standing-rules SQL, against a real Postgres.
 *
 * The unit tests run the repository over an in-memory fake that answers
 * statements by shape, which proves the repository's logic and nothing about
 * the SQL itself — a typo in a column name passes there. This runs the same
 * scenarios against the Docker database (`docker compose up -d`, then
 * `DATABASE_URL=... npx vitest run standing-rules.live`) and is the only check
 * that the DDL and the queries agree.
 *
 * Skipped without `DATABASE_URL`, so a CI box with no database is unaffected.
 */

const URL = process.env['DATABASE_URL']
const SKIP = URL === undefined || URL === '' || process.env['SKIP_LIVE'] === '1'

const RUN = `live_${Date.now().toString(36)}`
const OWNER = `${RUN}@test.invalid`
const WALLET = 'G'.padEnd(56, 'A')

function rule(over: Partial<StandingIntent> = {}): StandingIntent {
  return {
    id: `${RUN}_1`,
    chain: 'stellar',
    text: 'Buy $50 of XLM if it drops to $0.16',
    createdAt: '2026-09-23T10:00:00.000Z',
    trigger: { kind: 'price_below', asset: 'XLM', priceUsd: 0.16 },
    action: { kind: 'swap', from: 'USDC', to: 'XLM', amountIn: '50' },
    status: 'armed',
    ...over,
  }
}

describe.skipIf(SKIP)('standing rules against Postgres', () => {
  let pool: Pool
  let repo: StandingRulesRepo

  beforeAll(async () => {
    pool = new Pool({ connectionString: URL, max: 2 })
    repo = createStandingRulesRepo(async (sql, params) => {
      const result = await pool.query(sql, params)
      return { rows: result.rows as Record<string, unknown>[] }
    })
    await repo.ensureSchema()
  })

  afterAll(async () => {
    await pool.query(`DELETE FROM standing_rules WHERE id LIKE $1`, [`${RUN}%`])
    await pool.end()
  })

  it('creates the schema twice without error', async () => {
    await expect(repo.ensureSchema()).resolves.toBeUndefined()
  })

  it('round-trips a rule with its columns', async () => {
    const created = await repo.createRule({ email: OWNER, wallet: WALLET, rule: rule() })
    expect(created?.id).toBe(`${RUN}_1`)

    const [listed] = await repo.listRules(OWNER, 'stellar')
    expect(listed?.rule.trigger).toEqual({ kind: 'price_below', asset: 'XLM', priceUsd: 0.16 })
    expect(listed?.status).toBe('armed')
    expect(listed?.createdAt).toBe('2026-09-23T10:00:00.000Z')
    expect(listed?.firedAt).toBeNull()
  })

  it('refuses another owner’s id', async () => {
    const stolen = await repo.createRule({
      email: `mallory_${OWNER}`,
      wallet: WALLET,
      rule: rule({ text: 'hijacked' }),
    })
    expect(stolen).toBeUndefined()
    expect((await repo.listRules(OWNER, 'stellar'))[0]?.rule.text).not.toBe('hijacked')
  })

  it('fires a one-off rule once, with a numeric price', async () => {
    await repo.markFired(`${RUN}_1`, 0.155, new Date('2026-09-23T11:00:00.000Z'))
    await repo.markFired(`${RUN}_1`, 0.1, new Date('2026-09-23T12:00:00.000Z'))

    const [found] = await repo.listRules(OWNER, 'stellar')
    expect(found?.status).toBe('fired')
    expect(found?.firedPrice).toBe(0.155)
    expect(found?.firedAt).toBe('2026-09-23T11:00:00.000Z')
    expect(found?.rule.lastFiredAt).toBe('2026-09-23T11:00:00.000Z')
    expect((await repo.armedRules()).some((r) => r.id === `${RUN}_1`)).toBe(false)
  })

  it('keeps a scheduled rule armed after firing', async () => {
    await repo.createRule({
      email: OWNER,
      wallet: WALLET,
      rule: rule({ id: `${RUN}_weekly`, trigger: { kind: 'schedule', everyHours: 168 } }),
    })
    await repo.markFired(`${RUN}_weekly`, null, new Date('2026-09-23T12:00:00.000Z'))

    const armed = (await repo.armedRules()).find((r) => r.id === `${RUN}_weekly`)
    expect(armed?.status).toBe('armed')
    expect(armed?.rule.lastFiredAt).toBe('2026-09-23T12:00:00.000Z')
    expect(armed?.firedPrice).toBeNull()
  })

  it('tracks notified and seen separately', async () => {
    const unnotified = (await repo.unnotifiedFired()).map((r) => r.id)
    expect(unnotified).toContain(`${RUN}_1`)
    expect(unnotified).toContain(`${RUN}_weekly`)

    await repo.markNotified(`${RUN}_1`, new Date('2026-09-23T11:00:05.000Z'))
    expect((await repo.unnotifiedFired()).map((r) => r.id)).not.toContain(`${RUN}_1`)

    expect((await repo.unseenFired(OWNER, 'stellar')).map((r) => r.id)).toEqual([
      `${RUN}_weekly`,
      `${RUN}_1`,
    ])
    await repo.markSeen(OWNER, [`${RUN}_1`, `${RUN}_weekly`], new Date('2026-09-23T13:00:00Z'))
    expect(await repo.unseenFired(OWNER, 'stellar')).toHaveLength(0)
  })

  it('cancels only the owner’s rule', async () => {
    expect(await repo.cancelRule(`mallory_${OWNER}`, `${RUN}_weekly`)).toBe(false)
    expect(await repo.cancelRule(OWNER, `${RUN}_weekly`)).toBe(true)
    expect((await repo.armedRules()).some((r) => r.id === `${RUN}_weekly`)).toBe(false)
  })
})
