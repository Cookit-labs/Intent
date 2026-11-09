import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ANALYTICS_DDL, createAnalyticsRepo } from '../server/analytics'
import type { QueryFn } from '../server/db'

const state = vi.hoisted(() => ({
  configured: true,
  rows: [] as Record<string, unknown>[],
  fail: false,
  asked: [] as unknown[],
  backfills: 0,
}))

vi.mock('../server/db', async (actual) => ({
  ...(await actual<typeof import('../server/db')>()),
  databaseConfigured: () => state.configured,
}))
vi.mock('../server/rate-limit', () => ({ enforceRateLimit: async () => undefined }))
vi.mock('../server/report', () => ({ reportError: () => undefined }))
vi.mock('../server/backfill-values', () => ({
  valuePastTransactions: async () => {
    state.backfills += 1
  },
}))
vi.mock('../server/analytics', async (actual) => ({
  ...(await actual<typeof import('../server/analytics')>()),
  getAnalyticsRepo: async () => ({
    activityForAccount: async (query: unknown) => {
      state.asked.push(query)
      if (state.fail) throw new Error('down')
      return state.rows
    },
  }),
}))
vi.mock('next/server', async (actual) => ({
  ...(await actual<typeof import('next/server')>()),
  after: (run: () => unknown) => void run(),
}))

const { GET } = await import('../../app/api/chain/[chain]/activity/route')

const SUI = `0x${'a'.repeat(64)}`
const row = {
  hash: 'H',
  kind: 'lend',
  action: 'supply',
  venue: 'navi',
  assetIn: 'USDC',
  assetOut: null,
  amountIn: '5',
  confirmed: true,
  at: '2026-11-07T10:00:00.000Z',
}

function ask(chain: string, account: string): Promise<Response> {
  return GET(new Request(`http://x/api/chain/${chain}/activity?account=${account}`), {
    params: Promise.resolve({ chain }),
  })
}

beforeEach(() => {
  state.configured = true
  state.rows = []
  state.fail = false
  state.asked = []
  state.backfills = 0
})

describe('GET /api/chain/[chain]/activity', () => {
  it('names the venue, not its id', async () => {
    state.rows = [row]
    const res = await ask('sui', SUI)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { entries: { venue: string }[] }
    expect(body.entries[0]?.venue).toBe('NAVI')
    expect(state.asked).toEqual([{ network: 'mainnet', chain: 'sui', account: SUI }])
  })

  it.each(['solana', 'sui', 'near', 'avalanche', 'monad', 'stellar'])(
    'answers for %s',
    async (c) => {
      const account = { solana: '11111111111111111111111111111111', sui: SUI }[c] ?? ''
      const fallback =
        c === 'near'
          ? 'someone.near'
          : c === 'stellar'
            ? `G${'A'.repeat(55)}`
            : `0x${'b'.repeat(40)}`
      const res = await ask(c, account === '' ? fallback : account)
      expect(res.status).toBe(200)
    }
  )

  it('refuses a chain with no record and an address that is not one', async () => {
    expect((await ask('arc', SUI)).status).toBe(404)
    expect((await ask('sui', 'nope')).status).toBe(400)
  })

  it('reports a failed read as a failure, never as a wallet with no history', async () => {
    state.fail = true
    expect((await ask('sui', SUI)).status).toBe(503)
  })

  it('says nothing is recorded where there is no database', async () => {
    state.configured = false
    const res = await ask('sui', SUI)
    expect(await res.json()).toEqual({ entries: [] })
  })

  it('asks a chain about a row it cannot yet name, and only then', async () => {
    state.rows = [row]
    await ask('sui', SUI)
    expect(state.backfills).toBe(0)
    state.rows = [{ ...row, kind: 'unknown', action: null, venue: null }]
    await ask('sui', SUI)
    expect(state.backfills).toBe(1)
  })
})

describe('reading a wallet from the log', () => {
  function repoAnswering(rows: Record<string, unknown>[]): {
    repo: ReturnType<typeof createAnalyticsRepo>
    calls: { sql: string; params: unknown[] }[]
  } {
    const calls: { sql: string; params: unknown[] }[] = []
    const query: QueryFn = async (sql, params) => {
      calls.push({ sql, params: params ?? [] })
      return { rows }
    }
    return { repo: createAnalyticsRepo(query), calls }
  }

  it('asks only for what reached the chain, on this chain, leaving out setup steps', async () => {
    const { repo, calls } = repoAnswering([])
    await repo.activityForAccount({ network: 'mainnet', chain: 'sui', account: SUI })
    const [call] = calls
    expect(call?.params.slice(0, 3)).toEqual(['mainnet', 'sui', SUI])
    expect(call?.sql).toMatch(/chain = \$2/)
    expect(call?.sql).toMatch(/hash IS NOT NULL/)
    expect(call?.sql).toMatch(/ok OR failure = 'pending'/)
    expect(call?.sql).toMatch(/kind <> 'setup'/)
    expect(call?.sql).toMatch(/lower\(account\) = lower\(\$3\)/)
  })

  it('turns a row into an entry', async () => {
    const { repo } = repoAnswering([
      {
        hash: 'H',
        kind: 'lend',
        action: 'supply',
        venue: 'navi',
        asset_in: 'USDC',
        asset_out: null,
        amount_in: '5.000',
        ok: false,
        submitted_at: '2026-11-07T10:00:00.000Z',
      },
    ])
    const [entry] = await repo.activityForAccount({
      network: 'mainnet',
      chain: 'sui',
      account: SUI,
    })
    expect(entry).toEqual({
      hash: 'H',
      kind: 'lend',
      action: 'supply',
      venue: 'navi',
      assetIn: 'USDC',
      assetOut: null,
      amountIn: '5.000',
      confirmed: false,
      at: '2026-11-07T10:00:00.000Z',
    })
  })

  it('writes the venue and the action', async () => {
    const { repo, calls } = repoAnswering([])
    await repo.recordExecution({
      network: 'mainnet',
      chain: 'sui',
      account: SUI,
      kind: 'lend',
      feeSponsored: false,
      ok: true,
      hash: 'H',
      venue: 'navi',
      action: 'supply',
    })
    const [call] = calls
    expect(call?.sql).toMatch(/chain, venue, action, race_id/)
    expect(call?.params[15]).toBe('navi')
    expect(call?.params[16]).toBe('supply')
  })
})

describe('the schema', () => {
  const migration = readFileSync(
    join(__dirname, '..', '..', '..', '..', 'packages', 'db', 'migrations', '017_usage_venue.sql'),
    'utf8'
  )

  it.each(['venue', 'action'])('adds %s in the migration and on first use alike', (column) => {
    const statement = `ALTER TABLE usage_executions ADD COLUMN IF NOT EXISTS ${column} TEXT`
    expect(migration).toContain(statement)
    expect(ANALYTICS_DDL).toContain(statement)
  })
})

describe('the History page', () => {
  const page = readFileSync(
    join(__dirname, '..', '..', 'app', '[chain]', 'history', 'page.tsx'),
    'utf8'
  )

  it('only opens the Stellar positions on Stellar', () => {
    expect(page).toMatch(/positions === 'blend' \? <OpenPositions \/> : null/)
    expect(page).toMatch(/positions === 'venues' \? <ChainPositions \/> : null/)
  })
})
