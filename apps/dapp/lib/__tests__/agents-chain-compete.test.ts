import { StrKey } from '@stellar/stellar-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fakeAnalyticsDb, type FakeAnalyticsDb } from './fakes/analytics-db'

/**
 * The race on a chain other than Stellar. The chain module, the roster and the
 * market are faked; under test is that a chain action starts a race, that a
 * refusal or an unpriceable action never reaches an agent, and that Stellar
 * keeps its old path.
 */

const state = vi.hoisted(() => ({
  roster: undefined as unknown,
  module: undefined as unknown,
  propose: undefined as unknown as ReturnType<typeof import('vitest').vi.fn>,
  db: undefined as unknown as FakeAnalyticsDb,
  headers: {} as Record<string, string>,
}))

vi.mock('../server/db', () => ({
  databaseConfigured: () => true,
  getPool: () => ({
    query: async (sql: string, params?: unknown[]) => state.db.query(sql, params),
  }),
  withTimeout: <T>(work: Promise<T>): Promise<T> => work,
}))
vi.mock('next/headers', () => ({ headers: async () => new Headers(state.headers) }))
const enforceRateLimit = vi.fn(async () => undefined)
vi.mock('../server/rate-limit', () => ({ enforceRateLimit }))
vi.mock('../agents/registry', () => ({ getRoster: () => state.roster }))
vi.mock('../chains/registry', () => ({
  chainModule: (chain: string) => (chain === 'near' ? state.module : undefined),
}))
vi.mock('../agents/market-context', () => ({
  buildMarketContextAsync: async () => ({
    prices: { XLM: 0.1, USDC: 1 },
    venues: [],
    routes: [],
  }),
  quoteRoutes: async () => [],
}))
vi.mock('../swap/limit-price', () => ({ fetchOrderBookTop: async () => undefined }))

const action = { kind: 'swap', amount: '5', tokenIn: 'NEAR', tokenOut: 'USDC' }

function nearModule(quote: unknown, price: number | null = 4) {
  return {
    chain: 'near',
    tokens: [
      { symbol: 'NEAR', id: 'wrap.near', decimals: 24 },
      { symbol: 'USDC', id: 'usdc.near', decimals: 6 },
    ],
    venues: [{ id: 'ref', name: 'Ref', kinds: ['swap'], quote }],
    defaultVenue: {},
    priceUsd: async () => price ?? undefined,
  }
}

const post = (body: unknown): Request =>
  new Request('http://localhost/api/agents/compete', {
    method: 'POST',
    body: JSON.stringify(body),
  })

async function frames(res: Response): Promise<Record<string, any>[]> {
  const text = await res.text()
  return text
    .split('\n\n')
    .map((chunk) => chunk.replace(/^data: /, '').trim())
    .filter((chunk) => chunk.startsWith('{'))
    .map((chunk) => JSON.parse(chunk))
}

beforeEach(() => {
  state.db = fakeAnalyticsDb()
  state.headers = {}
  delete (globalThis as { intentAnalyticsSchema?: unknown }).intentAnalyticsSchema
  vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORK', 'testnet')
  vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORKS', '')
  state.propose = vi.fn(async () => ({ ok: false, error: 'boom' }))
  state.roster = [
    {
      key: 'halcyon',
      name: 'Halcyon',
      gradient: 'a',
      model: 'm',
      brain: { propose: state.propose },
    },
  ]
  state.module = nearModule(async () => ({ receive: { amount: '19.9', symbol: 'USDC' } }))
  enforceRateLimit.mockClear()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('POST /api/agents/compete on a chain', () => {
  it('starts a race for a chain action on near', async () => {
    const { POST } = await import('../../app/api/agents/compete/route')
    const out = await frames(
      await POST(
        post({ text: 'swap 5 NEAR to USDC', chain: 'near', account: 'a.near', chainAction: action })
      )
    )
    expect(out[0]?.type).toBe('competition:started')
    expect(out[0]?.routeCount).toBe(1)
    expect(state.propose).toHaveBeenCalledTimes(1)
    const given = (state.propose as any).mock.calls[0][0]
    expect(given.market.routes).toHaveLength(1)
    expect(given.market.routes[0]).toMatchObject({ id: 'ref-1', source: 'Ref' })
    expect(given.market.venues).toEqual([{ id: 'ref', name: 'Ref', category: 'dex' }])
  })

  it('still refuses near without a chain action', async () => {
    const { POST } = await import('../../app/api/agents/compete/route')
    const out = await frames(await POST(post({ text: 'swap 5 NEAR to USDC', chain: 'near' })))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ type: 'competition:error', code: 'chain_unsupported' })
    expect(state.propose).not.toHaveBeenCalled()
  })

  it('keeps the old path for stellar', async () => {
    const { POST } = await import('../../app/api/agents/compete/route')
    const out = await frames(
      await POST(post({ text: 'swap 10 XLM to USDC', chain: 'stellar', chainAction: action }))
    )
    expect(out[0]?.type).toBe('competition:started')
    const given = (state.propose as any).mock.calls[0][0]
    expect(out[0]?.routeCount).toBeUndefined()
    expect(given.intent.input).toMatchObject({ tokenIn: 'XLM', tokenOut: 'USDC' })
  })

  it('refuses an unknown token without calling an agent', async () => {
    const { POST } = await import('../../app/api/agents/compete/route')
    const out = await frames(
      await POST(
        post({
          text: 'swap 5 NEAR to SCAM',
          chain: 'near',
          account: 'a.near',
          chainAction: { ...action, tokenOut: 'SCAM' },
        })
      )
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ type: 'competition:error', code: 'action_refused' })
    expect(out[0]?.message).toContain("I can't confirm SCAM as a verified token")
    expect(state.propose).not.toHaveBeenCalled()
  })

  it('ends in an error, calling no agent, when every quote fails', async () => {
    state.module = nearModule(async () => {
      throw new Error('down')
    })
    const { POST } = await import('../../app/api/agents/compete/route')
    const out = await frames(
      await POST(
        post({ text: 'swap 5 NEAR to USDC', chain: 'near', account: 'a.near', chainAction: action })
      )
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ type: 'competition:error', code: 'chain_unsupported' })
    expect(out[0]?.message).toContain('Nothing was signed or sent')
    expect(state.propose).not.toHaveBeenCalled()
  })

  it('rate-limits by an account of 66 characters', async () => {
    const account = 'a'.repeat(66)
    const { POST } = await import('../../app/api/agents/compete/route')
    await (await POST(post({ text: 'swap', chain: 'near', account }))).text()
    expect(enforceRateLimit).toHaveBeenCalledWith(expect.anything(), 'compete', account)
  })

  describe('refuses an amount before any venue or agent is called', () => {
    const cases: [string, string, number | null][] = [
      ['a non-numeric amount', 'lots', 4],
      ['a zero amount', '0', 4],
      ['a negative amount', '-3', 4],
      ['an amount over the trade cap', '1000000000', 4],
      ['a token with no live price', '5', null],
    ]
    it.each(cases)('%s', async (_name, amount, price) => {
      const quote = vi.fn(async () => ({ receive: { amount: '1', symbol: 'USDC' } }))
      state.module = nearModule(quote, price)
      const { POST } = await import('../../app/api/agents/compete/route')
      const out = await frames(
        await POST(
          post({
            text: 'swap NEAR to USDC',
            chain: 'near',
            account: 'a.near',
            chainAction: { ...action, amount },
          })
        )
      )
      expect(out).toHaveLength(1)
      expect(out[0]).toMatchObject({ type: 'competition:error', code: 'action_refused' })
      expect(out[0]?.message).toContain('Nothing was signed or sent')
      expect(quote).not.toHaveBeenCalled()
      expect(state.propose).not.toHaveBeenCalled()
    })
  })
})

const raceInput = (chain?: string) => ({
  id: '22222222-2222-4222-8222-222222222222',
  network: 'mainnet' as const,
  ...(chain === undefined ? {} : { chain }),
  startedAt: new Date(Date.now() - 60_000),
  durationMs: 1000,
  intent: { type: 'swap', tokenIn: 'NEAR', tokenOut: 'USDC', sizeUsd: 10 },
  attempts: [{ agent: 'halcyon', model: 'm', ok: true as const, latencyMs: 900 }],
  scores: { halcyon: 90 },
  winner: 'halcyon' as string | null,
  unanimous: true as boolean | null,
})

describe('a race records the chain it ran on', () => {
  it('writes the chain, and stellar when none is given', async () => {
    const { logRace } = await import('../server/analytics')
    await logRace(raceInput('near'))
    await logRace({ ...raceInput(), id: '33333333-3333-4333-8333-333333333333' })
    expect(state.db.races.map((r) => r.chain)).toEqual(['near', 'stellar'])
  })

  it('is written by the compete route for a chain action, and for stellar', async () => {
    const { POST } = await import('../../app/api/agents/compete/route')
    await (
      await POST(
        post({ text: 'swap 5 NEAR to USDC', chain: 'near', account: 'a.near', chainAction: action })
      )
    ).text()
    await (await POST(post({ text: 'swap 10 XLM to USDC', chain: 'stellar' }))).text()
    expect(state.db.races.map((r) => [r.chain, r.network])).toEqual([
      ['near', 'mainnet'],
      ['stellar', 'testnet'],
    ])
  })
})

describe('GET /api/agents/history', () => {
  const stellar = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 7))
  const accounts: [string, string][] = [
    ['stellar', stellar],
    ['solana', 'So11111111111111111111111111111111111111112'],
    ['sui', `0x${'a'.repeat(64)}`],
    ['near', 'alice.near'],
    ['evm', `0x${'b'.repeat(40)}`],
  ]
  const get = (account: string | null): Request =>
    new Request(
      `http://localhost/api/agents/history${account === null ? '' : `?account=${encodeURIComponent(account)}`}`
    )

  async function seedExecution(account: string, network: 'mainnet' | 'testnet'): Promise<void> {
    const { logRace, getAnalyticsRepo } = await import('../server/analytics')
    await logRace({ ...raceInput(), network })
    await (
      await getAnalyticsRepo()
    ).recordExecution({
      network,
      account,
      kind: 'swap',
      feeSponsored: false,
      ok: true,
      hash: 'HASH',
      raceId: raceInput().id,
    })
  }

  it.each(accounts)('answers a %s account its own races', async (name, account) => {
    await seedExecution(account, name === 'stellar' ? 'testnet' : 'mainnet')
    const { GET } = await import('../../app/api/agents/history/route')
    const res = await GET(get(account))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { entries: { executedHash: string }[] }
    expect(body.entries.map((e) => e.executedHash)).toEqual(['HASH'])
  })

  it('never answers another account the races of this one', async () => {
    await seedExecution('alice.near', 'mainnet')
    const { GET } = await import('../../app/api/agents/history/route')
    const body = (await (await GET(get('bob.near'))).json()) as { entries: unknown[] }
    expect(body.entries).toEqual([])
  })

  it.each([
    ['no account', null],
    ['text that is no address', 'not an address'],
    ['a stellar address with a bad checksum', `G${'A'.repeat(55)}`],
  ])('answers invalid_account for %s', async (_name, account) => {
    const { GET } = await import('../../app/api/agents/history/route')
    const res = await GET(get(account))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_account' })
  })
})

describe('POST /api/chain/near/submit and the race it came from', () => {
  const RACE = raceInput().id
  const submit = vi.fn(async () => ({ ok: true, hash: 'H1' }))

  const send = async (): Promise<Response> => {
    const { POST } = await import('../../app/api/chain/[chain]/submit/route')
    return POST(
      new Request('http://localhost/api/chain/near/submit', {
        method: 'POST',
        body: JSON.stringify({
          account: 'alice.near',
          venueId: 'ref',
          signed: { family: 'near', hashes: ['h1'] },
        }),
      }),
      { params: Promise.resolve({ chain: 'near' }) }
    )
  }

  beforeEach(() => {
    state.module = {
      chain: 'near',
      venues: [{ id: 'ref', assertSafe: () => undefined }],
      submit,
    }
  })

  async function seedRace(chain: string): Promise<void> {
    const { logRace } = await import('../server/analytics')
    await logRace(raceInput(chain))
  }

  it('links the execution to the race it carries', async () => {
    await seedRace('near')
    state.headers = { 'x-intent-race': RACE }
    const res = await send()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, hash: 'H1' })
    expect(state.db.executions.map((e) => [e.kind, e.race_id])).toEqual([['near', RACE]])
  })

  it('does not link a race that ran on another chain', async () => {
    await seedRace('solana')
    state.headers = { 'x-intent-race': RACE }
    expect((await send()).status).toBe(200)
    expect(state.db.executions.map((e) => e.race_id)).toEqual([null])
  })

  it.each([
    ['no race id', undefined],
    ['a malformed race id', "x'; drop table agent_races"],
  ])('answers the same, with no link, for %s', async (_name, header) => {
    await seedRace('near')
    state.headers = header === undefined ? {} : { 'x-intent-race': header }
    const res = await send()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, hash: 'H1' })
    expect(state.db.executions.map((e) => e.race_id)).toEqual([null])
  })

  it('answers as it would without a database when linking fails', async () => {
    state.db.down = new Error('connection refused')
    state.headers = { 'x-intent-race': RACE }
    const res = await send()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, hash: 'H1' })
  })
})
