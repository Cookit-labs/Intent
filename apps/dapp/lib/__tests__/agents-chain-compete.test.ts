import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
}))

vi.mock('../server/analytics', () => ({ logRace: async () => undefined }))
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
    expect(out[0]?.type).toBe('competition:error')
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
    expect(out[0]).toMatchObject({ type: 'competition:error' })
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
      expect(out[0]?.type).toBe('competition:error')
      expect(out[0]?.message).toContain('Nothing was signed or sent')
      expect(quote).not.toHaveBeenCalled()
      expect(state.propose).not.toHaveBeenCalled()
    })
  })
})
