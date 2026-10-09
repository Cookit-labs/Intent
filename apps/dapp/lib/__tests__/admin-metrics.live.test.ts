import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createMetricsRepo, type MetricsRepo } from '../server/admin-metrics'
import { ANALYTICS_DDL } from '../server/analytics'

/**
 * The dashboard's SQL, run against a real Postgres in a schema of its own that is
 * dropped afterwards. A fake database cannot prove an aggregate, so this is where
 * the numbers are checked. It needs DATABASE_URL and skips itself on SKIP_LIVE,
 * like the other tests that reach outside the process.
 */

const SKIP = process.env['SKIP_LIVE'] === '1' || (process.env['DATABASE_URL'] ?? '') === ''
const MIGRATIONS = join(__dirname, '../../../../packages/db/migrations')
const SCHEMA = `metrics_test_${randomUUID().slice(0, 8).replace(/-/g, '')}`

const W1 = 'G'.padEnd(55, 'A') + '1'
const W2 = 'G'.padEnd(55, 'A') + '2'
const W3 = 'G'.padEnd(55, 'A') + '3'
const W9 = 'G'.padEnd(55, 'A') + '9'

let client: Client
let repo: MetricsRepo

async function exec(
  network: string,
  account: string,
  kind: string,
  ok: boolean,
  ago: string,
  flow: { in?: string; out?: string; amount?: string; usd?: number | null } = {},
  sponsored = false,
  failure: string | null = null
): Promise<void> {
  await client.query(
    `INSERT INTO executions
       (id, network, hash, account, kind, fee_sponsored, ok, failure, submitted_at,
        asset_in, asset_out, amount_in, volume_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() - $9::interval, $10, $11, $12, $13)`,
    [
      randomUUID(),
      network,
      randomUUID().replace(/-/g, '').padEnd(64, '0'),
      account,
      kind,
      sponsored,
      ok,
      failure,
      ago,
      flow.in ?? null,
      flow.out ?? null,
      flow.amount ?? null,
      flow.usd ?? null,
    ]
  )
}

async function race(
  network: string,
  type: string,
  agents: { agent: string; ok: boolean; ms: number; won?: boolean; failure?: string }[],
  unanimous: boolean | null
): Promise<void> {
  const id = randomUUID()
  const answered = agents.filter((a) => a.ok).length
  await client.query(
    `INSERT INTO agent_races
       (id, network, started_at, intent_type, token_in, token_out, size_usd, agents, answered,
        winner, unanimous, outcome, duration_ms)
     VALUES ($1, $2, now() - interval '1 day', $3, 'XLM', 'USDC', 10, $4, $5, $6, $7, $8, 1000)`,
    [
      id,
      network,
      type,
      agents.length,
      answered,
      agents.find((a) => a.won)?.agent ?? null,
      unanimous,
      answered === 0 ? 'no_agent_answered' : 'winner',
    ]
  )
  for (const a of agents) {
    await client.query(
      `INSERT INTO agent_proposals (race_id, agent, model, ok, failure, latency_ms, won)
       VALUES ($1, $2, 'm', $3, $4, $5, $6)`,
      [id, a.agent, a.ok, a.failure ?? null, a.ms, a.won ?? false]
    )
  }
}

beforeAll(async () => {
  if (SKIP) return
  client = new Client({ connectionString: process.env['DATABASE_URL'] as string })
  await client.connect()
  await client.query(`CREATE SCHEMA ${SCHEMA}`)
  await client.query(`SET search_path TO ${SCHEMA}`)
  for (const file of [
    '001_waitlist.sql',
    '002_standing_rules.sql',
    '006_standing_rules_network.sql',
  ]) {
    await client.query(readFileSync(join(MIGRATIONS, file), 'utf8'))
  }
  for (const statement of ANALYTICS_DDL) await client.query(statement)
  repo = createMetricsRepo(async (sql, params) => ({
    rows: (await client.query(sql, params as unknown[])).rows as Record<string, unknown>[],
  }))

  // Mainnet
  await exec(
    'mainnet',
    W1,
    'swap',
    true,
    '1 day',
    { in: 'XLM', out: 'USDC', amount: '10', usd: 2 },
    true
  )
  await exec('mainnet', W2, 'swap', true, '1 hour', { in: 'USDC', out: 'XLM', amount: '5', usd: 5 })
  await exec('mainnet', W1, 'offer', true, '2 days', {
    in: 'XLM',
    out: 'USDC',
    amount: '100',
    usd: 20,
  })
  await exec('mainnet', W3, 'send', true, '10 days', { in: 'XLM', amount: '5', usd: 1 })
  await exec('mainnet', W1, 'lend', true, '3 days', { in: 'XLM', amount: '30', usd: 7.5 })
  await exec('mainnet', W2, 'swap', false, '1 day', {}, false, 'underfunded')
  await exec('mainnet', W2, 'swap', true, '4 days', {
    in: 'XLM',
    out: 'USDC',
    amount: '1',
    usd: null,
  })
  // Testnet: must never show up in a mainnet number.
  await exec('testnet', W9, 'swap', true, '1 day', {
    in: 'XLM',
    out: 'USDC',
    amount: '9999',
    usd: 999,
  })

  await race(
    'mainnet',
    'swap',
    [
      { agent: 'halcyon', ok: true, ms: 800, won: true },
      { agent: 'vesper', ok: true, ms: 1200 },
      { agent: 'argus', ok: false, ms: 5000, failure: 'timeout' },
    ],
    true
  )
  await race(
    'mainnet',
    'limit',
    [
      { agent: 'halcyon', ok: true, ms: 1000, won: true },
      { agent: 'vesper', ok: false, ms: 400, failure: 'rate_limited' },
      { agent: 'argus', ok: false, ms: 5000, failure: 'timeout' },
    ],
    false
  )
  await race('testnet', 'swap', [{ agent: 'halcyon', ok: true, ms: 100, won: true }], true)

  for (const [network, understood, reason] of [
    ['mainnet', true, null],
    ['mainnet', true, null],
    ['mainnet', false, 'unreadable'],
    ['testnet', true, null],
  ] as const) {
    await client.query(
      `INSERT INTO intent_reads (id, network, understood, reason) VALUES ($1, $2, $3, $4)`,
      [randomUUID(), network, understood, reason]
    )
  }

  for (const [network, status] of [
    ['mainnet', 'armed'],
    ['mainnet', 'armed'],
    ['mainnet', 'fired'],
    ['testnet', 'cancelled'],
  ] as const) {
    await client.query(
      `INSERT INTO standing_rules (id, email, wallet, chain, rule, status, network)
       VALUES ($1, 'a@b.c', $2, 'stellar', '{}', $3, $4)`,
      [randomUUID(), W1, status, network]
    )
  }

  await client.query(
    `INSERT INTO waitlist_signups (email, status) VALUES ('a@x.com','pending'),('b@x.com','accepted'),('c@x.com','accepted'),('d@x.com','rejected')`
  )
}, 60_000)

afterAll(async () => {
  if (SKIP || client === undefined) return
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
  await client.end()
})

const seven = { network: 'mainnet', range: '7d' } as const
const everything = { network: 'mainnet', range: 'all' } as const

describe.skipIf(SKIP)('the dashboard queries, against a real database', () => {
  it('counts and prices the week on mainnet, and nothing from testnet', async () => {
    const o = await repo.overview(seven)
    expect(o).toMatchObject({
      transactions: 5,
      failed: 1,
      volumeUsd: 27,
      lendUsd: 7.5,
      unvalued: 1,
      wallets: 2,
      newWallets: 2,
      sponsored: 1,
      intents: 2,
      reads: { understood: 2, unreadable: 1 },
    })
    expect(o.successRate).toBeCloseTo(5 / 6)
  })

  it('widens to everything, and keeps the networks apart', async () => {
    const all = await repo.overview(everything)
    expect(all).toMatchObject({ transactions: 6, volumeUsd: 28, wallets: 3, newWallets: 3 })
    const testnet = await repo.overview({ network: 'testnet', range: 'all' })
    expect(testnet).toMatchObject({ transactions: 1, volumeUsd: 999, intents: 1 })
  })

  it('gives one point per day with the quiet days at zero', async () => {
    const series = await repo.series(seven)
    expect(series).toHaveLength(7)
    expect(series.reduce((n, p) => n + p.transactions, 0)).toBe(5)
    expect(series.reduce((n, p) => n + p.volumeUsd, 0)).toBe(27)
    expect(series.filter((p) => p.transactions === 0).length).toBeGreaterThan(0)
    const days = series.map((p) => p.day)
    expect([...days].sort()).toEqual(days)
  })

  it('splits by kind, with lending as its own line', async () => {
    const kinds = Object.fromEntries((await repo.byKind(seven)).map((k) => [k.kind, k]))
    expect(kinds['swap']).toMatchObject({ transactions: 3, failed: 1, volumeUsd: 7 })
    expect(kinds['offer']).toMatchObject({ transactions: 1, volumeUsd: 20 })
    expect(kinds['lend']).toMatchObject({ transactions: 1, volumeUsd: 7.5 })
    expect(kinds['send']).toBeUndefined()
  })

  it('ranks the pairs that count towards volume', async () => {
    const pairs = await repo.pairs(seven)
    expect(pairs[0]).toMatchObject({
      assetIn: 'XLM',
      assetOut: 'USDC',
      volumeUsd: 22,
      transactions: 3,
    })
    expect(pairs.some((p) => p.assetIn === 'XLM' && p.assetOut === null)).toBe(false)
  })

  it('ranks wallets by volume', async () => {
    const wallets = await repo.wallets(seven)
    expect(wallets.map((w) => w.account)).toEqual([W1, W2])
    expect(wallets[0]).toMatchObject({ transactions: 3, volumeUsd: 29.5 })
  })

  it('pages and filters the transactions, newest first', async () => {
    const page = await repo.transactions(seven, { limit: 3, offset: 0 })
    expect(page.total).toBe(6)
    expect(page.rows).toHaveLength(3)
    expect(page.rows[0]?.account).toBe(W2)

    const failed = await repo.transactions(seven, { ok: false, limit: 10, offset: 0 })
    expect(failed.rows).toHaveLength(1)
    expect(failed.rows[0]).toMatchObject({ ok: false, failure: 'underfunded' })

    const sponsored = await repo.transactions(seven, { sponsored: true, limit: 10, offset: 0 })
    expect(sponsored.total).toBe(1)

    const offers = await repo.transactions(seven, { kind: 'offer', limit: 10, offset: 0 })
    expect(offers.rows[0]).toMatchObject({ kind: 'offer', assetIn: 'XLM', volumeUsd: 20 })
  })

  it('reports each agent and what they fail on', async () => {
    const a = await repo.agents(seven)
    expect(a.races).toBe(2)
    expect(a.noAnswer).toBe(0)
    expect(a.answerRate).toBeCloseTo(3 / 6)
    expect(a.unanimousRate).toBeCloseTo(1 / 2)
    const halcyon = a.agents.find((x) => x.agent === 'halcyon')
    expect(halcyon).toMatchObject({ races: 2, answered: 2, wins: 2, p50Ms: 900 })
    expect(a.failures).toEqual([
      { reason: 'timeout', count: 2 },
      { reason: 'rate_limited', count: 1 },
    ])
  })

  it('counts intents by type, rules by status and reads by outcome', async () => {
    const i = await repo.intents(seven)
    expect(i.byType.map((t) => t.type).sort()).toEqual(['limit', 'swap'])
    expect(Object.fromEntries(i.rules.map((r) => [r.status, r.count]))).toEqual({
      armed: 2,
      fired: 1,
    })
    expect(i.reads).toEqual({ understood: 2, unreadable: 1 })
  })

  it('counts the waitlist by status', async () => {
    expect(await repo.waitlist()).toEqual({ pending: 1, accepted: 2, rejected: 1 })
  })

  it('answers with zeros, not errors, for a network with no activity', async () => {
    const o = await repo.overview({ network: 'mainnet', range: '7d' })
    expect(o.transactions).toBeGreaterThan(0)
    const quiet = createMetricsRepo(async () => ({ rows: [] }))
    expect(await quiet.overview(seven)).toMatchObject({
      transactions: 0,
      successRate: null,
      volumeUsd: 0,
      intents: 0,
    })
    expect(await quiet.series({ network: 'mainnet', range: 'all' })).toEqual([])
  })
})
