import { describe, expect, it } from 'vitest'

import { agentsFromProposals, describePlan, revealFloor } from '../agents/competition'

/**
 * The tag under an agent's name is what it proposed, not what it "is".
 *
 * Fixed tags — "Time-sliced", "Cross-venue", "Path search" — described a
 * method the agent was never held to, and read as one whenever the proposal
 * said otherwise. A derived tag cannot contradict the proposal.
 */
describe('describing a plan', () => {
  it('says nothing before an agent has answered', () => {
    expect(describePlan({})).toBe('')
  })

  it('names a fill and its venue', () => {
    expect(describePlan({ executionMode: 'fill', source: 'soroswap' })).toBe(
      'fills now via soroswap'
    )
  })

  it('names a rest and its price', () => {
    expect(describePlan({ executionMode: 'rest', restPriceUsd: 0.16 })).toBe('rests at $0.16')
  })

  it('names a split with both halves', () => {
    expect(describePlan({ executionMode: 'split', splitPct: 70, restPriceUsd: 0.17 })).toBe(
      '70% now, rest at $0.17'
    )
  })

  it('adds slices and a follow-on when present', () => {
    expect(
      describePlan({
        executionMode: 'fill',
        source: 'aquarius',
        sliceCount: 3,
        thenAction: 'lend',
        thenVenue: 'blend',
      })
    ).toBe('fills now via aquarius · 3 slices · then lends on blend')
  })

  it('says an agent did not respond, whatever else is set', () => {
    expect(describePlan({ executionMode: 'fill', failed: 'timeout' })).toBe('did not respond')
  })
})

describe('reveal pacing', () => {
  it('keeps the first four floors where they were, then keeps stepping', () => {
    // The race used to be four fixed floors. Now it is a step per roster
    // position, so a seventh agent has a floor too rather than falling to 0.
    expect([0, 1, 2, 3].map(revealFloor)).toEqual([1100, 2500, 3900, 5300])
    expect(revealFloor(6)).toBe(9500)
  })
})

describe('a restored turn recovers its line-up', () => {
  it('builds agents from the stored proposals, colour from the key', () => {
    const agents = agentsFromProposals({
      'deepseek:deepseek-v4-flash': {
        key: 'deepseek:deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        model: 'deepseek-v4-flash',
        avgPriceUsd: 1,
        vsOraclePct: 0,
        score: 0,
      },
      twap: { key: 'twap', name: 'Atlas', avgPriceUsd: 1, vsOraclePct: 0, score: 0 },
    })
    expect(agents.map((a) => a.key)).toEqual(['deepseek:deepseek-v4-flash', 'twap'])
    expect(agents[0]?.model).toBe('deepseek-v4-flash')
    // A legacy row recorded no model; the caption is simply omitted.
    expect(agents[1]?.model).toBe('')
    expect(agents[1]?.name).toBe('Atlas')
    expect(agents[1]?.gradient).toMatch(/^linear-gradient\(/)
  })
})
