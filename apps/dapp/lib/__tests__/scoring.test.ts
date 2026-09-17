import { describe, expect, it } from 'vitest'

import type { AgentProposalResult, AgentStrategyKey } from '../agents/brain'
import { pickWinner, scoreProposals, tieBreak } from '../agents/scoring'

/**
 * Scoring decides who wins, so each rule gets its own test.
 *
 * Two earlier versions each had a structural winner. The first took no
 * arguments and always returned the same agent. The second ranked on the
 * slippage each agent reported about itself and broke ties alphabetically —
 * so a confident claim beat an honest one, and four identical proposals
 * always crowned the same name. What is pinned here is that neither can
 * happen again: the figure ranked is the one the server measured from the
 * route, and a tie resolves differently from one competition to the next.
 */

function proposal(
  strategy: AgentStrategyKey,
  vsOraclePct: number,
  over: Partial<AgentProposalResult> = {}
): AgentProposalResult {
  return {
    strategy,
    routeId: 'soroswap-1',
    reasoning: 'test',
    projectedAvgPriceUsd: 0.18,
    // Set by the server from the route: distance from fair value, positive
    // is worse. See lib/agents/measure.ts.
    projectedSlippagePct: vsOraclePct,
    venues: ['soroswap'],
    sliceCount: 1,
    confidence: 0.8,
    horizonMinutes: 0,
    executionMode: 'fill' as const,
    ...over,
  }
}

const RACE = 'af4c649b-2134-4f6e-bd43-c4b7d36a20c2'

describe('the measured fill decides', () => {
  it('ranks the fill closest to fair value first', () => {
    const scored = scoreProposals([proposal('twap', 2.0), proposal('shadow', 0.5)], {
      competitionId: RACE,
    })
    expect(scored[0]?.strategy).toBe('shadow')
  })

  it('ranks a fill better than fair value above one at fair value', () => {
    // Negative is better than the oracle, which testnet routes often are.
    const scored = scoreProposals([proposal('twap', 0), proposal('momentum', -40)], {
      competitionId: RACE,
    })
    expect(scored[0]?.strategy).toBe('momentum')
    expect(scored[0]?.score).toBeGreaterThan(100)
  })

  it('does not always return the same winner', () => {
    const first = pickWinner(
      scoreProposals([proposal('twap', 0.1), proposal('shadow', 5)], { competitionId: RACE })
    )
    const second = pickWinner(
      scoreProposals([proposal('twap', 5), proposal('shadow', 0.1)], { competitionId: RACE })
    )
    expect(first).toBe('twap')
    expect(second).toBe('shadow')
  })

  it('returns an empty list for no proposals', () => {
    expect(scoreProposals([], { competitionId: RACE })).toEqual([])
    expect(pickWinner([])).toBeNull()
  })
})

describe('ties have no standing favourite', () => {
  const identical = (): AgentProposalResult[] => [
    proposal('twap', 1),
    proposal('momentum', 1),
    proposal('arbitrage', 1),
    proposal('shadow', 1),
  ]

  it('resolves the same competition the same way every time', () => {
    const a = pickWinner(scoreProposals(identical(), { competitionId: RACE }))
    const b = pickWinner(scoreProposals(identical(), { competitionId: RACE }))
    expect(a).toBe(b)
  })

  it('does not depend on input order', () => {
    const a = pickWinner(scoreProposals(identical(), { competitionId: RACE }))
    const b = pickWinner(scoreProposals(identical().reverse(), { competitionId: RACE }))
    expect(a).toBe(b)
  })

  it('crowns different agents across different competitions', () => {
    // The regression this guards: alphabetical tie-breaking meant four
    // identical proposals always picked the first name in the alphabet. Over
    // many races, every agent should win some.
    const winners = new Set<string>()
    for (let i = 0; i < 200; i += 1) {
      winners.add(pickWinner(scoreProposals(identical(), { competitionId: `race-${i}` })) ?? '')
    }
    expect(winners.size).toBe(4)
  })

  it('cannot be influenced by anything in the proposal', () => {
    // The hash takes the competition id and the agent key, and nothing else.
    expect(tieBreak(RACE, 'twap')).toBe(tieBreak(RACE, 'twap'))
    expect(tieBreak(RACE, 'twap')).not.toBe(tieBreak(RACE, 'shadow'))
    expect(tieBreak(RACE, 'twap')).not.toBe(tieBreak('another-race', 'twap'))
  })
})

/**
 * A proposal that cannot be executed must never be recommended.
 *
 * No route means nothing to sign, whatever the numbers say. A losing real
 * route beats a winning opinion.
 */
describe('unexecutable proposals cannot win', () => {
  const withoutRoute = (strategy: AgentStrategyKey, vsOraclePct: number): AgentProposalResult => {
    const { routeId: _drop, ...rest } = proposal(strategy, vsOraclePct)
    return rest as AgentProposalResult
  }

  it('ranks a real route above a better-scoring proposal with no route', () => {
    const scored = scoreProposals([proposal('twap', 5), withoutRoute('shadow', -50)], {
      competitionId: RACE,
    })
    expect(pickWinner(scored)).toBe('twap')
    expect(scored[1]?.executable).toBe(false)
  })

  it('treats an empty route id as no route', () => {
    const scored = scoreProposals([proposal('twap', 5), proposal('shadow', -50, { routeId: '' })], {
      competitionId: RACE,
    })
    expect(pickWinner(scored)).toBe('twap')
  })

  it('still ranks among unexecutable proposals when nothing is executable', () => {
    const scored = scoreProposals([withoutRoute('twap', 5), withoutRoute('shadow', 1)], {
      competitionId: RACE,
    })
    expect(pickWinner(scored)).toBe('shadow')
  })
})
