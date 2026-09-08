import { describe, expect, it } from 'vitest'

import type { AgentProposalResult, AgentStrategyKey } from '../agents/brain'
import { isBuyIntent, pickWinner, scoreProposals } from '../agents/scoring'

/**
 * Scoring decides who wins a competition, so each rule gets its own test rather
 * than being implied by a single happy path. The behaviour being protected: the
 * winner depends on the proposals, which the previous implementation did not —
 * it took no arguments and always returned the same agent.
 */

function proposal(
  strategy: AgentStrategyKey,
  price: number,
  slippage: number
): AgentProposalResult {
  return {
    strategy,
    reasoning: 'test',
    projectedAvgPriceUsd: price,
    projectedSlippagePct: slippage,
    venues: ['uniswap'],
    sliceCount: 1,
    confidence: 0.8,
    horizonMinutes: 5,
  }
}

describe('scoreProposals', () => {
  it('ranks the lowest slippage first when prices match', () => {
    const scored = scoreProposals(
      [proposal('twap', 3200, 0.5), proposal('shadow', 3200, 0.1)],
      { isBuy: true }
    )
    expect(scored[0]?.strategy).toBe('shadow')
  })

  it('prefers the cheaper fill when buying', () => {
    const scored = scoreProposals(
      [proposal('twap', 3300, 0.2), proposal('arbitrage', 3100, 0.2)],
      { isBuy: true }
    )
    expect(scored[0]?.strategy).toBe('arbitrage')
  })

  it('prefers the higher fill when selling', () => {
    const scored = scoreProposals(
      [proposal('twap', 3300, 0.2), proposal('arbitrage', 3100, 0.2)],
      { isBuy: false }
    )
    expect(scored[0]?.strategy).toBe('twap')
  })

  it('does not always return the same winner', () => {
    // The specific regression the old winnerKey() had.
    const first = pickWinner(
      scoreProposals([proposal('twap', 3100, 0.1), proposal('shadow', 3300, 0.9)], {
        isBuy: true,
      })
    )
    const second = pickWinner(
      scoreProposals([proposal('twap', 3300, 0.9), proposal('shadow', 3100, 0.1)], {
        isBuy: true,
      })
    )
    expect(first).toBe('twap')
    expect(second).toBe('shadow')
  })

  it('awards every proposal full price weight when all prices are equal', () => {
    // Guards the divide-by-zero path when best === worst.
    const scored = scoreProposals(
      [proposal('twap', 3200, 0), proposal('shadow', 3200, 0)],
      { isBuy: true }
    )
    expect(scored[0]?.score).toBe(100)
    expect(scored[1]?.score).toBe(100)
  })

  it('breaks ties deterministically rather than by input order', () => {
    const a = scoreProposals([proposal('twap', 3200, 0.2), proposal('shadow', 3200, 0.2)], {
      isBuy: true,
    })
    const b = scoreProposals([proposal('shadow', 3200, 0.2), proposal('twap', 3200, 0.2)], {
      isBuy: true,
    })
    expect(a[0]?.strategy).toBe(b[0]?.strategy)
  })

  it('clamps slippage at the ceiling instead of going negative', () => {
    const scored = scoreProposals([proposal('twap', 3200, 99)], { isBuy: true })
    expect(scored[0]?.score).toBeGreaterThanOrEqual(0)
  })

  it('returns an empty list for no proposals', () => {
    expect(scoreProposals([], { isBuy: true })).toEqual([])
    expect(pickWinner([])).toBeNull()
  })
})

describe('isBuyIntent', () => {
  it.each(['market_buy', 'limit_buy', 'accumulate', 'hedge'])('treats %s as buy', (t) => {
    expect(isBuyIntent(t)).toBe(true)
  })

  it.each(['market_sell', 'limit_sell'])('treats %s as sell', (t) => {
    expect(isBuyIntent(t)).toBe(false)
  })
})
