import { describe, expect, it } from 'vitest'

import type { AgentProposalResult } from '../agents/brain'
import type { PlanContext } from '../agents/plan-scoring'
import { planPenalties, planScore } from '../agents/plan-scoring'

/**
 * What a proposal costs itself, beyond the route it picked.
 *
 * Scoring used to be `100 - vsOraclePct`, which is a pure function of
 * `routeId`. Every other decision an agent makes — fill or rest, where to
 * rest, whether to lend the proceeds, whether to offramp — was invisible, so
 * two agents on the same route tied exactly and the winner was drawn by a
 * hash of the competition id. Most wins were coin flips.
 *
 * The brief already tells agents not to do these things. Nothing checked.
 * Each penalty below corresponds to a sentence agents are given and can be
 * measured from facts the server already has, never from what the agent says
 * about itself.
 */

const base: AgentProposalResult = {
  agent: 'deepseek:deepseek-v4-flash',
  routeId: 'soroswap-1',
  reasoning: 'test',
  projectedAvgPriceUsd: 0.18,
  projectedSlippagePct: 0.5,
  venues: ['soroswap'],
  sliceCount: 1,
  confidence: 0.8,
  horizonMinutes: 5,
  executionMode: 'fill',
}

const context: PlanContext = {
  escrowUsd: 500,
  referencePriceUsd: 0.18,
  askedToLend: false,
  askedToOfframp: false,
  recentLowUsd: 0.17,
  recentHighUsd: 0.19,
}

function proposal(over: Partial<AgentProposalResult> = {}): AgentProposalResult {
  return { ...base, ...over }
}

describe('a plain fill on a good route is not penalised', () => {
  it('costs nothing', () => {
    expect(planPenalties(proposal(), context)).toEqual([])
  })

  it('scores the route alone, as before', () => {
    // The route measurement is still the main term. Penalties only subtract.
    expect(planScore(proposal(), context)).toBe(99.5)
  })
})

describe('resting at a price the market cannot reach', () => {
  it('is penalised when the price is far outside the recent range', () => {
    // The brief: "A price the market will never reach is not patience, it is
    // a refusal to trade." Judged against where the market has actually been.
    const [penalty] = planPenalties(proposal({ executionMode: 'rest', restPriceUsd: 4.0 }), context)
    expect(penalty?.reason).toBe('unreachable_rest_price')
  })

  it('is not penalised when the price sits inside the recent range', () => {
    expect(
      planPenalties(proposal({ executionMode: 'rest', restPriceUsd: 0.175 }), context)
    ).toEqual([])
  })

  it('is not penalised when the user named that price themselves', () => {
    // "If the user named a target price, that price is not yours to change."
    // An agent honouring a stated limit is obeying the user, not refusing to
    // trade, however far from the market it sits.
    expect(
      planPenalties(proposal({ executionMode: 'rest', restPriceUsd: 4.0 }), {
        ...context,
        statedLimitPriceUsd: 4.0,
      })
    ).toEqual([])
  })

  it('is penalised when resting with no price at all', () => {
    const [penalty] = planPenalties(proposal({ executionMode: 'rest', restPriceUsd: 0 }), context)
    expect(penalty?.reason).toBe('rest_without_price')
  })
})

describe('a follow-on nobody asked for', () => {
  it('penalises lending the user did not request', () => {
    // "Proposing a lending position nobody requested is not a better
    // strategy, it is a different instruction."
    const [penalty] = planPenalties(proposal({ thenAction: 'lend', thenVenue: 'blend' }), context)
    expect(penalty?.reason).toBe('unrequested_follow_on')
  })

  it('penalises an offramp the user did not request', () => {
    const [penalty] = planPenalties(
      proposal({ thenAction: 'offramp', thenVenue: 'testanchor' }),
      context
    )
    expect(penalty?.reason).toBe('unrequested_follow_on')
  })

  it('does not penalise lending the user asked for', () => {
    expect(
      planPenalties(proposal({ thenAction: 'lend', thenVenue: 'blend' }), {
        ...context,
        askedToLend: true,
      })
    ).toEqual([])
  })
})

describe('a follow-on too small to be worth its own signature', () => {
  it('penalises lending a trade below the second-signature threshold', () => {
    // "It costs a second signature... For a small order the extra fee and the
    // extra step may not be worth the yield — say so rather than proposing it
    // anyway." Measured against the order's own size.
    const [penalty] = planPenalties(proposal({ thenAction: 'lend', thenVenue: 'blend' }), {
      ...context,
      escrowUsd: 15,
      askedToLend: true,
    })
    expect(penalty?.reason).toBe('follow_on_not_worth_fee')
  })

  it('leaves a large enough trade alone', () => {
    expect(
      planPenalties(proposal({ thenAction: 'lend', thenVenue: 'blend' }), {
        ...context,
        escrowUsd: 500,
        askedToLend: true,
      })
    ).toEqual([])
  })
})

describe('an offramp outside what the anchor accepts', () => {
  it('is penalised above the anchor maximum', () => {
    // The limits are in the market context the agent was given. "A withdrawal
    // outside them will be refused, so say so rather than proposing it."
    const [penalty] = planPenalties(proposal({ thenAction: 'offramp', thenVenue: 'testanchor' }), {
      ...context,
      askedToOfframp: true,
      offrampMaxUsd: 100,
    })
    expect(penalty?.reason).toBe('offramp_outside_limits')
  })

  it('is not penalised inside the limits', () => {
    expect(
      planPenalties(proposal({ thenAction: 'offramp', thenVenue: 'testanchor' }), {
        ...context,
        askedToOfframp: true,
        offrampMaxUsd: 1000,
      })
    ).toEqual([])
  })
})

describe('slicing that does not correspond to a split', () => {
  it('penalises a slice count above one on a plain fill', () => {
    // "Set sliceCount to 1 unless splitting genuinely reduces impact."
    const [penalty] = planPenalties(proposal({ executionMode: 'fill', sliceCount: 7 }), context)
    expect(penalty?.reason).toBe('slices_without_split')
  })
})

describe('penalties accumulate and are bounded', () => {
  it('subtracts every penalty from the route score', () => {
    const bad = proposal({
      executionMode: 'rest',
      restPriceUsd: 4.0,
      thenAction: 'lend',
      thenVenue: 'blend',
    })
    const penalties = planPenalties(bad, context)
    expect(penalties.length).toBe(2)

    const total = penalties.reduce((sum, p) => sum + p.points, 0)
    expect(planScore(bad, context)).toBe(Number((99.5 - total).toFixed(1)))
  })

  it('never scores below zero, however bad the plan', () => {
    // A score is a rank, not a debt. Flooring keeps a catastrophic plan
    // comparable with another catastrophic plan rather than sorting on how
    // negative each one got.
    const awful = proposal({
      projectedSlippagePct: 99,
      executionMode: 'rest',
      restPriceUsd: 9999,
      sliceCount: 40,
      thenAction: 'offramp',
      thenVenue: 'testanchor',
    })
    expect(planScore(awful, { ...context, offrampMaxUsd: 1 })).toBe(0)
  })
})
