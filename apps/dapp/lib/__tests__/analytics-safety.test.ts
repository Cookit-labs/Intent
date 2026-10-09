import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fakeAnalyticsDb, type FakeAnalyticsDb } from './fakes/analytics-db'

/**
 * The log must never be in the way. With no database it does nothing; with a
 * database that is down or slow it reports and carries on; and what it writes
 * is for the network of the request, with nothing copied from an error.
 */

const state = vi.hoisted(() => ({
  configured: true,
  db: undefined as unknown as FakeAnalyticsDb,
  reported: [] as { where: string; error: unknown }[],
  flow: (async () => undefined) as (xdr: string) => Promise<unknown>,
}))

vi.mock('../server/execution-flow', () => ({
  describeExecution: (xdr: string) => state.flow(xdr),
}))

vi.mock('../server/db', () => ({
  databaseConfigured: () => state.configured,
  getPool: () => ({
    query: async (sql: string, params?: unknown[]) => state.db.query(sql, params),
  }),
  withTimeout: <T>(work: Promise<T>, ms: number): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no answer after ${ms}ms`)), ms)
      work.then(
        (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        (e) => {
          clearTimeout(timer)
          reject(e)
        }
      )
    }),
}))

vi.mock('../server/report', () => ({
  reportError: (where: string, error: unknown) => {
    state.reported.push({ where, error })
  },
}))

type Analytics = typeof import('../server/analytics')

async function load(env: Record<string, string> = {}): Promise<Analytics> {
  vi.resetModules()
  delete (globalThis as { intentAnalyticsSchema?: unknown }).intentAnalyticsSchema
  vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORK', 'testnet')
  vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORKS', '')
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  return import('../server/analytics')
}

beforeEach(() => {
  state.configured = true
  state.db = fakeAnalyticsDb()
  state.reported = []
  state.flow = async () => undefined
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

const ACCOUNT = 'G'.padEnd(56, 'A')

describe('logExecution', () => {
  it('writes the row, for the network the deployment is on', async () => {
    const { logExecution } = await load({ NEXT_PUBLIC_STELLAR_NETWORK: 'mainnet' })
    await logExecution({
      kind: 'swap',
      account: ACCOUNT,
      feeSponsored: true,
      result: { ok: true, hash: 'h'.repeat(64) },
    })
    expect(state.db.executions).toHaveLength(1)
    expect(state.db.executions[0]).toMatchObject({ network: 'mainnet', kind: 'swap', ok: true })
  })

  it('does nothing, and says nothing, when there is no database', async () => {
    state.configured = false
    const { logExecution } = await load()
    await expect(
      logExecution({ kind: 'swap', account: ACCOUNT, feeSponsored: false, result: { ok: true } })
    ).resolves.toBeUndefined()
    expect(state.db.log).toEqual([])
    expect(state.reported).toEqual([])
  })

  it('reports a failing database and still returns normally', async () => {
    state.db.down = new Error('connection refused')
    const { logExecution } = await load()
    await expect(
      logExecution({ kind: 'send', account: ACCOUNT, feeSponsored: false, result: { ok: true } })
    ).resolves.toBeUndefined()
    expect(state.reported.map((r) => r.where)).toEqual(['analytics/execution'])
  })

  it('records what the transaction sold, read from the envelope that was sent', async () => {
    state.flow = async (xdr) =>
      xdr === 'signed-xdr'
        ? { assetIn: 'XLM', amountIn: '10.0000000', assetOut: 'USDC', volumeUsd: 2 }
        : undefined
    const { logExecution } = await load()
    await logExecution({
      kind: 'swap',
      account: ACCOUNT,
      feeSponsored: false,
      result: { ok: true, hash: 'a'.repeat(64) },
      signedXdr: 'signed-xdr',
    })
    expect(state.db.executions[0]).toMatchObject({
      asset_in: 'XLM',
      asset_out: 'USDC',
      amount_in: '10.0000000',
      volume_usd: 2,
    })
  })

  it('does not read the envelope of a submit that failed', async () => {
    const read = vi.fn(async () => ({
      assetIn: 'XLM',
      amountIn: '1',
      assetOut: null,
      volumeUsd: 1,
    }))
    state.flow = read
    const { logExecution } = await load()
    await logExecution({
      kind: 'swap',
      account: ACCOUNT,
      feeSponsored: false,
      result: { ok: false, reason: 'underfunded' },
      signedXdr: 'signed-xdr',
    })
    expect(read).not.toHaveBeenCalled()
    expect(state.db.executions[0]).toMatchObject({ ok: false, volume_usd: null })
  })

  it('still records the row when the envelope cannot be read', async () => {
    state.flow = async () => {
      throw new Error('boom')
    }
    const { logExecution } = await load()
    await logExecution({
      kind: 'swap',
      account: ACCOUNT,
      feeSponsored: false,
      result: { ok: true, hash: 'c'.repeat(64) },
      signedXdr: 'signed-xdr',
    })
    expect(state.db.executions).toHaveLength(1)
    expect(state.db.executions[0]).toMatchObject({ volume_usd: null, asset_in: null })
    expect(state.reported.map((r) => r.where)).toEqual(['analytics/flow'])
  })

  it('records a failed submit with a fixed code and no upstream text', async () => {
    const { logExecution } = await load()
    await logExecution({
      kind: 'swap',
      account: ACCOUNT,
      feeSponsored: false,
      result: { ok: false, reason: 'underfunded', hash: 'f'.repeat(64) },
    })
    expect(state.db.executions[0]).toMatchObject({ ok: false, failure: 'underfunded' })
  })
})

describe('logRace', () => {
  const input = {
    id: '22222222-2222-4222-8222-222222222222',
    network: 'testnet' as const,
    startedAt: new Date('2026-10-07T10:00:00.000Z'),
    durationMs: 1000,
    intent: { type: 'swap', tokenIn: 'XLM', tokenOut: 'USDC', sizeUsd: 10 },
    attempts: [{ agent: 'halcyon', model: 'm', ok: true as const, latencyMs: 900 }],
    scores: { halcyon: 90 },
    winner: 'halcyon' as string | null,
    unanimous: true as boolean | null,
  }

  it('writes the race, and returns normally when the database is down', async () => {
    const { logRace } = await load()
    await logRace(input)
    expect(state.db.races).toHaveLength(1)

    state.db = fakeAnalyticsDb()
    state.db.down = new Error('down')
    await expect(
      logRace({ ...input, id: '33333333-3333-4333-8333-333333333333' })
    ).resolves.toBeUndefined()
    expect(state.reported.map((r) => r.where)).toEqual(['analytics/race'])
  })

  it('does nothing when there is no database', async () => {
    state.configured = false
    const { logRace } = await load()
    await logRace(input)
    expect(state.db.log).toEqual([])
  })
})
