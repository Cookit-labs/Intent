import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { NAIRA_DDL } from '../naira/orders'
import {
  createMetricsRepo,
  type AdminChain,
  type MetricsRepo,
  type Scope,
} from '../server/admin-metrics'
import { ANALYTICS_DDL } from '../server/analytics'
import { backfillBatch } from '../server/backfill-values'
import type { Movement } from '../server/chain-lookup'
import { SOLANA_TOKENS } from '../chains/solana/tokens'
import { WEAVE_DDL } from '../weave/orders'

/**
 * Every chain in the admin's numbers, against a real Postgres in a schema of its own: the
 * backfill of rows logged before the chain was recorded, and each chain apart and together.
 * Needs DATABASE_URL and skips itself on SKIP_LIVE, like admin-metrics.live.test.ts.
 */

const SKIP = process.env['SKIP_LIVE'] === '1' || (process.env['DATABASE_URL'] ?? '') === ''
const MIGRATIONS = join(__dirname, '../../../../packages/db/migrations')
const SCHEMA = `chains_test_${randomUUID().slice(0, 8).replace(/-/g, '')}`

let client: Client
let repo: MetricsRepo

const hash = (): string => randomUUID().replace(/-/g, '').padEnd(64, '0')

async function oldRow(kind: string, usd: number | null, h = hash()): Promise<void> {
  await client.query(
    `INSERT INTO usage_executions
       (id, network, hash, account, kind, fee_sponsored, ok, submitted_at, asset_in, volume_usd)
     VALUES ($1, 'mainnet', $2, 'W-old', $3, false, true, now() - interval '1 day', $4, $5)`,
    [randomUUID(), h, kind, usd === null ? null : 'XLM', usd]
  )
}

async function newRow(chain: string, kind: string, usd: number | null): Promise<void> {
  await client.query(
    `INSERT INTO usage_executions
       (id, network, hash, account, kind, fee_sponsored, ok, submitted_at, asset_in, volume_usd, chain)
     VALUES ($1, 'mainnet', $2, $3, $4, false, true, now() - interval '1 hour', 'X', $5, $6)`,
    [randomUUID(), hash(), `W-${chain}`, kind, usd, chain]
  )
}

async function ddl(statements: readonly string[]): Promise<void> {
  for (const statement of statements) await client.query(statement)
}

beforeAll(async () => {
  if (SKIP) return
  client = new Client({ connectionString: process.env['DATABASE_URL'] as string })
  await client.connect()
  await client.query(`CREATE SCHEMA ${SCHEMA}`)
  await client.query(`SET search_path TO ${SCHEMA}`)
  for (const file of ['002_standing_rules.sql', '006_standing_rules_network.sql']) {
    await client.query(readFileSync(join(MIGRATIONS, file), 'utf8'))
  }
  await ddl(ANALYTICS_DDL)
  await ddl(WEAVE_DDL)
  await ddl(NAIRA_DDL)

  // As the log looked before the chain was recorded.
  await oldRow('swap', 4)
  await oldRow('solana', null)
  const suiDeposit = hash()
  await oldRow('offramp', null, suiDeposit)
  await client.query(`UPDATE usage_executions SET chain = NULL, asset_in = NULL`)
  await client.query(
    `INSERT INTO weave_orders
       (id, chain, email, account, provider_order, idempotency_key, currency, institution_code,
        institution_name, account_identifier, account_name, deposit_address, amount,
        estimated_dest, status, provider_status, deposit_hash)
     VALUES ($1, 'sui', 'a@b.c', 'W-old', 'p1', 'k1', 'NGN', 'x', 'Bank', '0000', 'A', 'addr',
             '25', '37000', 'paid', 'paid', $2)`,
    [randomUUID(), suiDeposit]
  )
  // The next cold start runs the statements again, which fills in what they can.
  await ddl(ANALYTICS_DDL)

  await newRow('solana', 'swap', 75)
  await newRow('near', 'send', 6)
  await newRow('monad', 'lend', 10)

  await client.query(
    `INSERT INTO intent_reads (id, network, understood, chain)
     VALUES ($1, 'mainnet', true, 'solana'), ($2, 'mainnet', true, 'stellar'), ($3, 'mainnet', false, NULL)`,
    [randomUUID(), randomUUID(), randomUUID()]
  )
  await client.query(
    `INSERT INTO agent_races
       (id, network, started_at, intent_type, token_in, token_out, agents, answered, outcome,
        duration_ms, chain)
     VALUES ($1, 'mainnet', now() - interval '1 hour', 'swap', 'SOL', 'USDC', 1, 1, 'no_winner', 10, 'solana')`,
    [randomUUID()]
  )

  repo = createMetricsRepo(async (sql, params) => ({
    rows: (await client.query(sql, params as unknown[])).rows as Record<string, unknown>[],
  }))
}, 60_000)

afterAll(async () => {
  if (SKIP || client === undefined) return
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
  await client.end()
})

const scope = (chain?: AdminChain): Scope =>
  chain === undefined
    ? { network: 'mainnet', range: '30d' }
    : { network: 'mainnet', range: '30d', chain }

describe.skipIf(SKIP)('every chain in the dashboard, against a real database', () => {
  it('fills in the chain of rows logged before it was recorded', async () => {
    const { rows } = await client.query(
      `SELECT kind, chain, asset_in, volume_usd::float AS usd FROM usage_executions
       WHERE account = 'W-old' ORDER BY kind`
    )
    expect(rows).toEqual([
      { kind: 'offramp', chain: 'sui', asset_in: 'USDC', usd: 25 },
      { kind: 'swap', chain: 'stellar', asset_in: null, usd: 4 },
      { kind: 'unknown', chain: 'solana', asset_in: null, usd: null },
    ])
  })

  it('adds every chain together by default', async () => {
    const all = await repo.overview(scope())
    expect(all).toMatchObject({ transactions: 6, volumeUsd: 4 + 25 + 75 + 6, lendUsd: 10 })
    expect(all.reads).toEqual({ understood: 2, unreadable: 1 })
    expect(await repo.overview(scope('all'))).toEqual(all)
  })

  it('shows one chain on its own', async () => {
    expect(await repo.overview(scope('solana'))).toMatchObject({
      transactions: 2,
      volumeUsd: 75,
      unvalued: 0,
      wallets: 2,
      intents: 1,
      reads: { understood: 1, unreadable: 0 },
    })
    expect(await repo.overview(scope('stellar'))).toMatchObject({
      transactions: 1,
      volumeUsd: 4,
      intents: 0,
    })
    expect(await repo.overview(scope('sui'))).toMatchObject({ transactions: 1, volumeUsd: 25 })
    expect(await repo.overview(scope('avalanche'))).toMatchObject({ transactions: 0, volumeUsd: 0 })
  })

  it('says which chain each transaction ran on', async () => {
    const { rows, total } = await repo.transactions(scope('all'), { limit: 25, offset: 0 })
    expect(total).toBe(6)
    expect(new Set(rows.map((r) => r.chain))).toEqual(
      new Set(['stellar', 'solana', 'sui', 'near', 'monad'])
    )
    const near = await repo.transactions(scope('near'), { limit: 25, offset: 0 })
    expect(near.rows.map((r) => [r.chain, r.kind])).toEqual([['near', 'send']])
  })

  it('answers every view for one chain without an error', async () => {
    for (const chain of ['solana', 'stellar', 'all'] as const) {
      await repo.series(scope(chain))
      await repo.byKind(scope(chain))
      await repo.pairs(scope(chain))
      await repo.wallets(scope(chain))
      await repo.agents(scope(chain))
      await repo.intents(scope(chain))
      await repo.naira(scope(chain))
    }
    expect((await repo.naira(scope('solana'))).cashedOut.count).toBe(0)
    expect((await repo.naira(scope('sui'))).cashedOut).toMatchObject({ count: 1, usd: 25 })
  })

  it('values past transactions from their chain once, and leaves a failed lookup to retry', async () => {
    const query = async (sql: string, params?: unknown[]) => ({
      rows: (await client.query(sql, params)).rows as Record<string, unknown>[],
    })
    const unreadable = hash()
    const flaky = hash()
    for (const h of [unreadable, flaky]) {
      await client.query(
        `INSERT INTO usage_executions
           (id, network, hash, account, kind, fee_sponsored, ok, submitted_at, chain)
         VALUES ($1, 'mainnet', $2, 'W-sol', 'unknown', false, true, now(), 'solana')`,
        [randomUUID(), h]
      )
    }
    const swap: Movement = {
      ok: true,
      mine: new Map([
        ['So11111111111111111111111111111111111111112', BigInt(-2_000_000_000)],
        ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', BigInt(300_000_000)],
      ]),
      others: [],
    }
    const reads: string[] = []
    const deps = {
      read: async (_chain: string, h: string) => {
        reads.push(h)
        if (h === flaky) throw new Error('node down')
        return h === unreadable ? undefined : swap
      },
      tokens: () => SOLANA_TOKENS,
      price: async () => 150,
    }

    const first = await backfillBatch(query, deps)
    expect(first).toEqual({ looked: 3, valued: 1, unreadable: 1, retry: 1, remaining: 1 })
    const { rows } = await client.query(
      `SELECT kind, asset_in, asset_out, amount_in::text AS amount, volume_usd::float AS usd, looked_up
       FROM usage_executions WHERE account = 'W-old' AND chain = 'solana'`
    )
    expect(rows).toEqual([
      {
        kind: 'swap',
        asset_in: 'SOL',
        asset_out: 'USDC',
        amount: '2',
        usd: 300,
        looked_up: 'chain',
      },
    ])
    expect((await repo.overview(scope('solana'))).volumeUsd).toBe(75 + 300)

    reads.length = 0
    const second = await backfillBatch(query, deps)
    expect(reads).toEqual([flaky])
    expect(second.remaining).toBe(1)
  })
})
