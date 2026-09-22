import { describe, expect, it } from 'vitest'

import { AGENTS, describePlan } from '../agents/competition'

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

describe('the agents carry identity only', () => {
  it('has four, each with a name and a gradient and nothing prescribing a method', () => {
    expect(AGENTS).toHaveLength(4)
    for (const agent of AGENTS) {
      expect(agent.name).not.toMatch(/twap|momentum|arbitrage|shadow/i)
      expect(Object.keys(agent).sort()).toEqual(['gradient', 'key', 'name'])
    }
  })
})
