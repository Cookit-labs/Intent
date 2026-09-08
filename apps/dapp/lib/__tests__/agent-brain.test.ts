import { afterEach, describe, expect, it } from 'vitest'

import type { MarketContext, ProposalRequest } from '../agents/brain'
import { ALL_STRATEGIES } from '../agents/brain'
import { STRATEGIES, STRATEGY_ORDER } from '../agents/strategies'
import { mockBrain } from '../agents/brains/mock-brain'
import { getAgentBrain } from '../agents/registry'
import { parseIntent } from '../parse-intent'

const market: MarketContext = {
  asOf: new Date().toISOString(),
  prices: { WETH: 3500, USDC: 1 },
  venues: [
    { id: 'uniswap', name: 'Uniswap', category: 'dex' },
    { id: 'curve', name: 'Curve', category: 'dex' },
  ],
  volatilityHint: 'normal',
  gasHint: 'normal',
}

function request(strategy: (typeof ALL_STRATEGIES)[number]): ProposalRequest {
  return {
    intent: parseIntent('Accumulate 2 ETH below $3,200'),
    strategy,
    market,
    chain: 'arc',
  }
}

describe('mockBrain', () => {
  it('satisfies the AgentBrain contract for every strategy', async () => {
    for (const strategy of ALL_STRATEGIES) {
      const outcome = await mockBrain.propose(request(strategy))
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) continue

      expect(outcome.proposal.strategy).toBe(strategy)
      expect(outcome.proposal.reasoning.length).toBeGreaterThan(0)
      expect(outcome.proposal.projectedAvgPriceUsd).toBeGreaterThan(0)
      expect(outcome.proposal.venues.length).toBeGreaterThan(0)
    }
  })

  it('marks its output as degraded so the UI can say so', async () => {
    const outcome = await mockBrain.propose(request('twap'))
    expect(outcome.meta.degraded).toBe(true)
    expect(outcome.meta.costUsd).toBe(0)
  })

  it('produces four distinguishable proposals', async () => {
    const results = await Promise.all(ALL_STRATEGIES.map((s) => mockBrain.propose(request(s))))
    const reasonings = results.flatMap((r) => (r.ok ? [r.proposal.reasoning] : []))
    expect(new Set(reasonings).size).toBe(ALL_STRATEGIES.length)
  })

  it('slices for TWAP and does not for momentum', async () => {
    const twap = await mockBrain.propose(request('twap'))
    const momentum = await mockBrain.propose(request('momentum'))
    if (!twap.ok || !momentum.ok) throw new Error('expected both to succeed')
    expect(twap.proposal.sliceCount).toBeGreaterThan(1)
    expect(momentum.proposal.sliceCount).toBe(1)
  })

  it('only names venues that were offered', async () => {
    const offered = new Set(market.venues.map((v) => v.id))
    for (const strategy of ALL_STRATEGIES) {
      const outcome = await mockBrain.propose(request(strategy))
      if (!outcome.ok) continue
      for (const venue of outcome.proposal.venues) expect(offered.has(venue)).toBe(true)
    }
  })
})

describe('strategy definitions', () => {
  it('covers every strategy exactly once, in a stable display order', () => {
    expect(Object.keys(STRATEGIES).sort()).toEqual([...ALL_STRATEGIES].sort())
    expect(STRATEGY_ORDER).toHaveLength(ALL_STRATEGIES.length)
    expect(new Set(STRATEGY_ORDER).size).toBe(ALL_STRATEGIES.length)
  })

  it('gives each strategy a distinct prompt and identity', () => {
    const prompts = Object.values(STRATEGIES).map((s) => s.systemPrompt)
    expect(new Set(prompts).size).toBe(prompts.length)
    const gradients = Object.values(STRATEGIES).map((s) => s.gradient)
    expect(new Set(gradients).size).toBe(gradients.length)
  })

  it('states a forbidden move in every prompt', () => {
    // Structural differentiation is what stops four prompts producing four
    // paraphrases of the same answer.
    for (const s of Object.values(STRATEGIES)) {
      expect(s.systemPrompt).toMatch(/FORBIDDEN/)
    }
  })

  it('tells every agent not to use prices from memory', () => {
    for (const s of Object.values(STRATEGIES)) {
      expect(s.systemPrompt).toMatch(/Never use a price from memory/)
    }
  })
})

describe('getAgentBrain', () => {
  const original = process.env['AGENT_BRAIN']

  afterEach(() => {
    if (original === undefined) delete process.env['AGENT_BRAIN']
    else process.env['AGENT_BRAIN'] = original
  })

  it('defaults to the mock when unset', () => {
    delete process.env['AGENT_BRAIN']
    expect(getAgentBrain().id).toBe('mock')
  })

  it('falls back to the mock when deepseek is asked for but not configured', () => {
    process.env['AGENT_BRAIN'] = 'deepseek'
    delete process.env['DEEPSEEK_API_KEY']
    expect(getAgentBrain().id).toBe('mock')
  })
})
