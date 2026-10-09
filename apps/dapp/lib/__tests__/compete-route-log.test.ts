import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The agent competition records itself. The race, who answered, how long each
 * took, who won and whether they agreed are what the analytics dashboard turns
 * into agent statistics. The agents, the market and the scoring are faked here;
 * what is under test is that the route reports what happened, once, and only
 * for a race that actually ran.
 */

const state = vi.hoisted(() => ({
  races: [] as Record<string, unknown>[],
  roster: undefined as unknown,
  scored: [] as { agent: string; score: number; penalties: string[] }[],
  winner: null as string | null,
  unanimous: false,
}))

vi.mock('../server/analytics', () => ({
  logRace: async (input: Record<string, unknown>) => {
    state.races.push(input)
  },
}))
vi.mock('../server/rate-limit', () => ({ enforceRateLimit: async () => undefined }))
vi.mock('../agents/registry', () => ({ getRoster: () => state.roster }))
vi.mock('../agents/market-context', () => ({
  buildMarketContextAsync: async () => ({ prices: { XLM: 0.1, USDC: 1 }, routes: [] }),
  quoteRoutes: async () => [],
}))
vi.mock('../swap/limit-price', () => ({ fetchOrderBookTop: async () => undefined }))
vi.mock('../agents/scoring', () => ({
  scoreProposals: () => state.scored,
  pickWinner: () => state.winner,
  unanimousChoice: () => state.unanimous,
}))

function brain(result: unknown, delayMs = 0) {
  return {
    propose: async () => {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
      return result
    },
  }
}

function proposal(agent: string) {
  return {
    agent,
    routeId: `route-${agent}`,
    executionMode: 'fill',
    projectedAvgPriceUsd: 0.1,
    projectedSlippagePct: 0.2,
  }
}

const post = (body: unknown): Request =>
  new Request('http://localhost/api/agents/compete', {
    method: 'POST',
    body: JSON.stringify(body),
  })

beforeEach(() => {
  state.races = []
  state.scored = []
  state.winner = null
  state.unanimous = false
  state.roster = [
    {
      key: 'halcyon',
      name: 'Halcyon',
      gradient: 'a',
      model: 'model-a',
      brain: brain({ ok: true, proposal: proposal('halcyon') }),
    },
    {
      key: 'orrin',
      name: 'Orrin',
      gradient: 'b',
      model: 'model-b',
      brain: brain({ ok: false, error: 'aborted: timeout' }, 5),
    },
  ]
})

afterEach(() => {
  vi.resetModules()
})

describe('POST /api/agents/compete', () => {
  it('records a race with who answered, who failed and why, and who won', async () => {
    state.scored = [{ agent: 'halcyon', score: 91.5, penalties: [] }]
    state.winner = 'halcyon'
    state.unanimous = false

    const { POST } = await import('../../app/api/agents/compete/route')
    const res = await POST(post({ text: 'swap 10 XLM to USDC', chain: 'stellar' }))
    await res.text()

    expect(state.races).toHaveLength(1)
    const race = state.races[0] as Record<string, any>
    expect(race.network).toBe('testnet')
    expect(race.winner).toBe('halcyon')
    expect(race.unanimous).toBe(false)
    expect(race.scores).toEqual({ halcyon: 91.5 })
    expect(race.intent).toMatchObject({ tokenIn: 'XLM', tokenOut: 'USDC' })
    expect(typeof race.id).toBe('string')
    expect(race.durationMs).toBeGreaterThanOrEqual(0)

    const attempts = race.attempts as Record<string, any>[]
    expect(attempts.map((a) => a.agent).sort()).toEqual(['halcyon', 'orrin'])
    expect(attempts.find((a) => a.agent === 'halcyon')).toMatchObject({
      ok: true,
      model: 'model-a',
      routeId: 'route-halcyon',
      executionMode: 'fill',
    })
    expect(attempts.find((a) => a.agent === 'orrin')).toMatchObject({
      ok: false,
      model: 'model-b',
      error: 'aborted: timeout',
    })
    for (const a of attempts) expect(a.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('records a race that nobody answered, with no winner', async () => {
    state.roster = [
      {
        key: 'halcyon',
        name: 'Halcyon',
        gradient: 'a',
        model: 'm',
        brain: brain({ ok: false, error: 'boom' }),
      },
    ]
    const { POST } = await import('../../app/api/agents/compete/route')
    const res = await POST(post({ text: 'swap 10 XLM to USDC', chain: 'stellar' }))
    await res.text()

    expect(state.races).toHaveLength(1)
    expect(state.races[0]).toMatchObject({ winner: null, unanimous: null, scores: {} })
  })

  it('records nothing for a request that never started a race', async () => {
    const { POST } = await import('../../app/api/agents/compete/route')
    await (await POST(post({ text: 'swap 10 XLM to USDC', chain: 'arc' }))).text()
    state.roster = undefined
    await (await POST(post({ text: 'swap 10 XLM to USDC', chain: 'stellar' }))).text()
    expect(state.races).toEqual([])
  })
})
