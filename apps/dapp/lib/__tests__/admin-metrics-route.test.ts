import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MetricsRepo } from '../server/admin-metrics'

const state = vi.hoisted(() => ({
  repo: undefined as unknown,
  calls: [] as { fn: string; scope: unknown; filter?: unknown }[],
}))

vi.mock('../server/admin-metrics', async (original) => ({
  ...(await original<typeof import('../server/admin-metrics')>()),
  getMetricsRepo: async () => state.repo,
}))
vi.mock('../server/report', () => ({ reportError: vi.fn() }))

import { GET } from '../../app/api/admin/metrics/route'

const TOKEN = 'an-admin-token-of-length'

function repo(): MetricsRepo {
  const record =
    <T>(fn: string, value: T) =>
    async (scope: unknown, filter?: unknown): Promise<T> => {
      state.calls.push({ fn, scope, filter })
      return value
    }
  return {
    overview: record('overview', {
      transactions: 4,
      failed: 1,
      successRate: 0.8,
      volumeUsd: 10,
      lendUsd: 0,
      unvalued: 0,
      wallets: 3,
      newWallets: 1,
      sponsored: 2,
      intents: 5,
      reads: { understood: 1, unreadable: 0 },
    }),
    series: record('series', [
      { day: '2026-10-09', transactions: 4, failed: 1, volumeUsd: 10, wallets: 3 },
    ]),
    byKind: record('byKind', []),
    pairs: record('pairs', []),
    wallets: record('wallets', []),
    transactions: async (scope, filter) => {
      state.calls.push({ fn: 'transactions', scope, filter })
      return {
        total: 60,
        rows: [
          {
            id: '1',
            hash: 'ab'.repeat(32),
            account: 'G',
            kind: 'swap',
            ok: true,
            failure: null,
            feeSponsored: false,
            at: '2026-10-09T00:00:00.000Z',
            assetIn: 'XLM',
            assetOut: 'USDC',
            amountIn: '1',
            volumeUsd: 0.2,
          },
          {
            id: '2',
            hash: null,
            account: 'G',
            kind: 'swap',
            ok: false,
            failure: 'x',
            feeSponsored: false,
            at: '2026-10-09T00:00:00.000Z',
            assetIn: null,
            assetOut: null,
            amountIn: null,
            volumeUsd: null,
          },
        ],
      }
    },
    agents: record('agents', {
      races: 0,
      answerRate: null,
      noAnswer: 0,
      unanimousRate: null,
      p50Ms: null,
      p95Ms: null,
      agents: [],
      failures: [],
    }),
    intents: record('intents', { byType: [], rules: [], reads: { understood: 0, unreadable: 0 } }),
    waitlist: async () => ({ pending: 1, accepted: 2, rejected: 3 }),
  }
}

function get(query: string, headers: Record<string, string> = { 'x-admin-token': TOKEN }): Request {
  return new Request(`http://localhost/api/admin/metrics?${query}`, { headers })
}

beforeEach(() => {
  state.repo = repo()
  state.calls = []
  vi.stubEnv('ADMIN_TOKEN', TOKEN)
  vi.stubEnv('AUTH_SECRET', 'a'.repeat(40))
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('GET /api/admin/metrics', () => {
  it('refuses anyone who is not the admin, before reading anything', async () => {
    expect((await GET(get('view=overview', {}))).status).toBe(401)
    expect(
      (await GET(get('view=overview', { 'x-admin-token': 'nope-nope-nope-nope' }))).status
    ).toBe(401)
    expect(state.calls).toEqual([])
  })

  it('answers the overview for the network and range asked for', async () => {
    const res = await GET(get('view=overview&network=testnet&range=7d'))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await res.json()
    expect(body).toMatchObject({
      tracked: true,
      network: 'testnet',
      range: '7d',
      overview: { transactions: 4 },
    })
    expect(
      state.calls.every((c) => JSON.stringify(c.scope) === '{"network":"testnet","range":"7d"}')
    ).toBe(true)
  })

  it('defaults to mainnet and thirty days', async () => {
    await GET(get('view=overview'))
    expect(state.calls[0]?.scope).toEqual({ network: 'mainnet', range: '30d' })
  })

  it('rejects a view, network or range it does not know', async () => {
    expect((await GET(get('view=secrets'))).status).toBe(400)
    expect((await GET(get('view=overview&network=devnet'))).status).toBe(400)
    expect((await GET(get('view=overview&range=1y'))).status).toBe(400)
    expect((await GET(get(''))).status).toBe(400)
  })

  it('says a chain is not recorded instead of showing an empty chart', async () => {
    const body = await (await GET(get('view=overview&chain=arc'))).json()
    expect(body).toEqual({ tracked: false, chain: 'arc' })
    expect(state.calls).toEqual([])
  })

  it('pages and filters the transactions and links each to the explorer', async () => {
    const res = await GET(
      get('view=transactions&network=mainnet&page=3&kind=swap&ok=false&sponsored=true')
    )
    const body = await res.json()
    expect(state.calls[0]?.filter).toEqual({
      kind: 'swap',
      ok: false,
      sponsored: true,
      limit: 25,
      offset: 50,
    })
    expect(body).toMatchObject({ total: 60, page: 3, pageSize: 25 })
    expect(body.rows[0].explorerUrl).toBe(
      `https://stellar.expert/explorer/public/tx/${'ab'.repeat(32)}`
    )
    expect(body.rows[1].explorerUrl).toBeNull()
  })

  it('ignores a kind it does not know rather than passing it to the database', async () => {
    await GET(get('view=transactions&kind=%27%3B%20drop%20table'))
    expect(state.calls[0]?.filter).toEqual({ limit: 25, offset: 0 })
  })

  it('links testnet transactions to the testnet explorer', async () => {
    const body = await (await GET(get('view=transactions&network=testnet'))).json()
    expect(body.rows[0].explorerUrl).toContain('/explorer/testnet/tx/')
  })

  it('splits active wallets into new and returning', async () => {
    const body = await (await GET(get('view=wallets'))).json()
    expect(body).toMatchObject({ active: 3, fresh: 1, returning: 2 })
  })

  it('answers the waitlist even for a chain that is not recorded', async () => {
    const body = await (await GET(get('view=waitlist&chain=arc'))).json()
    expect(body.waitlist).toEqual({ pending: 1, accepted: 2, rejected: 3 })
  })

  it('says so when there is no database, and when a query fails', async () => {
    state.repo = undefined
    expect((await GET(get('view=overview'))).status).toBe(503)

    state.repo = {
      ...repo(),
      overview: async () => {
        throw new Error('boom')
      },
    }
    const res = await GET(get('view=overview'))
    expect(res.status).toBe(503)
    expect(JSON.stringify(await res.json())).not.toContain('boom')
  })
})
