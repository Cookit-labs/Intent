import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentProposalResult, TalkCall } from '../agents/brain'
import { pickWinner, scoreProposals, unanimousChoice } from '../agents/scoring'
import { fakeAnalyticsDb, type FakeAnalyticsDb } from './fakes/analytics-db'

/**
 * Talk inside the race route. Chain, roster and market are faked; under test is
 * what reaches the client and what gets scored.
 */

// Importing the route graph for the first time takes more than the default 5s here.
vi.setConfig({ testTimeout: 60_000 })

const state = vi.hoisted(() => ({
  roster: undefined as unknown,
  module: undefined as unknown,
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
vi.mock('../server/rate-limit', () => ({ enforceRateLimit: vi.fn(async () => undefined) }))
vi.mock('../agents/registry', () => ({ getRoster: () => state.roster }))
vi.mock('../chains/registry', () => ({
  chainModule: (chain: string) => (chain === 'near' ? state.module : undefined),
}))
vi.mock('../agents/market-context', () => ({
  buildMarketContextAsync: async () => ({
    asOf: 'now',
    prices: { XLM: 0.1, USDC: 1 },
    venues: [],
    volatilityHint: 'normal',
    gasHint: 'normal',
    routes: [],
  }),
  quoteRoutes: async () => [],
}))
vi.mock('../swap/limit-price', () => ({ fetchOrderBookTop: async () => undefined }))

const action = { kind: 'swap', amount: '5', tokenIn: 'NEAR', tokenOut: 'USDC' }

const nearModule = {
  chain: 'near',
  tokens: [
    { symbol: 'NEAR', id: 'wrap.near', decimals: 24 },
    { symbol: 'USDC', id: 'usdc.near', decimals: 6 },
  ],
  venues: [
    {
      id: 'ref',
      name: 'Ref',
      kinds: ['swap'],
      quote: async () => ({ receive: { amount: '19.9', symbol: 'USDC' } }),
    },
    {
      id: 'rhea',
      name: 'Rhea',
      kinds: ['swap'],
      quote: async () => ({ receive: { amount: '19.5', symbol: 'USDC' } }),
    },
  ],
  defaultVenue: {},
  priceUsd: async () => 4,
}

const take = (agent: string, routeId = 'rhea-1'): AgentProposalResult => ({
  agent,
  routeId,
  reasoning: `${agent} first take`,
  projectedAvgPriceUsd: 4,
  projectedSlippagePct: 0,
  venues: [],
  sliceCount: 1,
  confidence: 0.5,
  horizonMinutes: 0,
  executionMode: 'fill',
})

const meta = {
  provider: 'groq',
  model: 'm',
  latencyMs: 1,
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  costUsd: 0,
}

const final = (decision: string, routeId = '', reasoning = 'Decided.'): unknown => ({
  decision,
  routeId,
  executionMode: 'fill',
  restPriceUsd: 0,
  splitPct: 0,
  reasoning,
})

function agent(
  key: string,
  replies: Record<string, unknown> | undefined,
  routeId?: string
): Record<string, unknown> {
  return {
    key,
    name: key.toUpperCase(),
    gradient: 'a',
    model: 'm',
    provider: 'groq',
    brain: {
      propose: async () => ({ ok: true, proposal: take(key, routeId), meta }),
      ...(replies !== undefined
        ? {
            talk: async (call: TalkCall) => ({
              ok: true,
              args: replies[call.tool.name] ?? { to: '', question: '', answer: '' },
              meta,
            }),
          }
        : {}),
    },
  }
}

const post = (chain = 'near', talk = true): Request =>
  new Request('http://localhost/api/agents/compete', {
    method: 'POST',
    body: JSON.stringify({
      text: 'swap 5 NEAR to USDC',
      chain,
      ...(talk ? { talk: true } : {}),
      account: 'a.near',
      ...(chain === 'near' ? { chainAction: action } : {}),
    }),
  })

async function race(chain = 'near', talk = true): Promise<Record<string, any>[]> {
  const { POST } = await import('../../app/api/agents/compete/route')
  const text = await (await POST(post(chain, talk))).text()
  return text
    .split('\n\n')
    .map((chunk) => chunk.replace(/^data: /, '').trim())
    .filter((chunk) => chunk.startsWith('{'))
    .map((chunk) => JSON.parse(chunk))
}

const types = (frames: Record<string, any>[]): string[] => frames.map((f) => f.type)
const proposalOf = (frames: Record<string, any>[], key: string): Record<string, any> | undefined =>
  frames.find((f) => f.type === 'competition:proposal' && f.proposal.agent === key)

beforeEach(() => {
  state.db = fakeAnalyticsDb()
  state.headers = {}
  state.module = nearModule
  delete (globalThis as { intentAnalyticsSchema?: unknown }).intentAnalyticsSchema
  vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORK', 'testnet')
  vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORKS', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('the race with talk', () => {
  it('leaves a race of agents that cannot talk as it was', async () => {
    state.roster = [agent('a', undefined), agent('b', undefined)]
    const out = await race()
    expect(types(out)).not.toContain('competition:take')
    expect(types(out)).not.toContain('competition:talk')
    expect(types(out).filter((t) => t === 'competition:proposal')).toHaveLength(2)
    expect(types(out)).toContain('competition:winner')
  })

  it('runs the race an older client was built for when it does not ask for talk', async () => {
    // A tab open from before talk shipped knows nothing of a held plan, and would
    // offer Review on one and sign the winner's trade.
    const called = vi.fn()
    state.roster = [
      agent('a', { final_plan: final('hold', '', 'Not now.') }),
      agent('b', { final_plan: final('hold', '', 'Too thin.') }),
    ]
    for (const seat of state.roster as { brain: { talk: unknown } }[]) seat.brain.talk = called
    const out = await race('near', false)
    expect(types(out)).not.toContain('competition:take')
    expect(types(out)).not.toContain('competition:talk')
    expect(called).not.toHaveBeenCalled()
    expect(types(out).filter((t) => t === 'competition:proposal')).toHaveLength(2)
    expect(types(out)).toContain('competition:winner')
  })

  it('stops the models when the person leaves mid-talk', async () => {
    let asked: AbortSignal | undefined
    const waiting = (call: TalkCall): Promise<unknown> =>
      new Promise((resolve) => {
        asked = call.signal
        call.signal?.addEventListener('abort', () => resolve({ ok: false, error: 'timeout', meta }))
      })
    const seats = [agent('a', {}), agent('b', {})] as { brain: { talk: unknown } }[]
    for (const seat of seats) seat.brain.talk = waiting
    state.roster = seats

    const { POST } = await import('../../app/api/agents/compete/route')
    const reader = (await POST(post())).body?.getReader()
    while (asked === undefined) {
      const { done } = (await reader?.read()) ?? { done: true }
      if (done === true) break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(asked).toBeDefined()

    await reader?.cancel()
    expect(asked?.aborted).toBe(true)
  })

  it('shows first takes and talk first, and final plans after', async () => {
    state.roster = [
      agent('a', { ask_agent: { to: 'B', question: 'Why Rhea?' }, final_plan: final('keep') }),
      agent('b', { answer_agents: { answer: 'It settles fast.' }, final_plan: final('keep') }),
    ]
    const out = await race()
    const kinds = types(out)
    expect(kinds[0]).toBe('competition:started')
    expect(kinds.lastIndexOf('competition:take')).toBeLessThan(kinds.indexOf('competition:talk'))
    expect(kinds.lastIndexOf('competition:talk')).toBeLessThan(
      kinds.indexOf('competition:proposal')
    )
    expect(kinds.lastIndexOf('competition:proposal')).toBeLessThan(
      kinds.indexOf('competition:winner')
    )
    const lines = out.filter((f) => f.type === 'competition:talk').map((f) => f.line)
    expect(lines).toContainEqual({ kind: 'asked', agent: 'a', to: 'b', text: 'Why Rhea?' })
    expect(lines).toContainEqual({
      kind: 'answered',
      agent: 'b',
      to: ['a'],
      text: 'It settles fast.',
    })
  })

  it('sends no route with a first take, which cannot be reviewed', async () => {
    state.roster = [agent('a', {}), agent('b', {})]
    const out = await race()
    for (const frame of out.filter((f) => f.type === 'competition:take')) {
      expect(frame.route).toBeUndefined()
    }
  })

  it('offers a changed plan on the route it moved to, measured by the server', async () => {
    state.roster = [
      agent('a', { final_plan: final('change', 'ref-1', 'Ref pays more.') }),
      agent('b', { final_plan: final('keep') }),
    ]
    const out = await race()
    const changed = proposalOf(out, 'a')
    expect(changed?.proposal.routeId).toBe('ref-1')
    expect(changed?.route.venueId).toBe('ref')
    expect(changed?.proposal.reasoning).toBe('Ref pays more.')
    expect(changed?.proposal.projectedSlippagePct).not.toBe(0)
    expect(out.filter((f) => f.type === 'competition:talk').map((f) => f.line)).toContainEqual({
      kind: 'changed',
      agent: 'a',
    })
    // Ref pays more, so scoring on final plans recommends the agent that moved.
    expect(out.find((f) => f.type === 'competition:winner')?.winner).toBe('a')
  })

  it('keeps the first take when a change names a route that was not offered', async () => {
    state.roster = [
      agent('a', { final_plan: final('change', 'nope-1', 'Elsewhere.') }),
      agent('b', {}),
    ]
    const out = await race()
    expect(proposalOf(out, 'a')?.proposal.routeId).toBe('rhea-1')
    expect(proposalOf(out, 'a')?.proposal.reasoning).toBe('a first take')
  })

  it('gives a held plan no route and no way to win', async () => {
    state.roster = [
      agent('a', { final_plan: final('hold', '', 'Not at this price.') }),
      agent('b', { final_plan: final('keep') }),
    ]
    const out = await race()
    const held = proposalOf(out, 'a')
    expect(held?.proposal.held).toBe(true)
    expect(held?.proposal.routeId).toBeUndefined()
    expect(held?.route).toBeUndefined()
    expect(held?.proposal.reasoning).toBe('Not at this price.')
    const winner = out.find((f) => f.type === 'competition:winner')
    expect(winner?.winner).toBe('b')
    expect(winner?.unanimous).toBe(false)
  })

  it('names no winner and raises no error when every agent holds off', async () => {
    state.roster = [
      agent('a', { final_plan: final('hold', '', 'Not now.') }),
      agent('b', { final_plan: final('hold', '', 'Too thin.') }),
    ]
    const out = await race()
    expect(types(out)).not.toContain('competition:winner')
    expect(types(out)).not.toContain('competition:error')
    expect(proposalOf(out, 'a')?.proposal.held).toBe(true)
    expect(proposalOf(out, 'b')?.proposal.held).toBe(true)
  })

  it('holds off the same way on stellar', async () => {
    state.roster = [
      agent('a', { final_plan: final('hold', '', 'Not now.') }),
      agent('b', { final_plan: final('hold', '', 'Too thin.') }),
    ]
    const out = await race('stellar')
    expect(types(out)).toContain('competition:talk')
    expect(types(out)).not.toContain('competition:winner')
    expect(types(out)).not.toContain('competition:error')
  })
})

describe('scoring a held plan', () => {
  const held: AgentProposalResult = { ...take('h'), held: true }
  const { routeId: _none, ...heldNoRoute } = held

  it('never picks one', () => {
    const scored = scoreProposals([heldNoRoute], { competitionId: 'c' })
    expect(pickWinner(scored)).toBeNull()
  })

  it('does not call agents unanimous when one held off', () => {
    const scored = scoreProposals([take('a'), take('b'), heldNoRoute], { competitionId: 'c' })
    expect(unanimousChoice(scored)).toBe(false)
  })

  it('still calls them unanimous when none did', () => {
    const scored = scoreProposals([take('a'), take('b')], { competitionId: 'c' })
    expect(unanimousChoice(scored)).toBe(true)
  })
})
