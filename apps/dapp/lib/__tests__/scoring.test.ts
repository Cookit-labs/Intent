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
    executionMode: 'fill' as const,
  }
}

describe('scoreProposals', () => {
  it('ranks the lowest slippage first when prices match', () => {
    const scored = scoreProposals([proposal('twap', 3200, 0.5), proposal('shadow', 3200, 0.1)], {
      isBuy: true,
    })
    expect(scored[0]?.strategy).toBe('shadow')
  })

  it('prefers the cheaper fill when buying', () => {
    const scored = scoreProposals([proposal('twap', 3300, 0.2), proposal('arbitrage', 3100, 0.2)], {
      isBuy: true,
    })
    expect(scored[0]?.strategy).toBe('arbitrage')
  })

  it('prefers the higher fill when selling', () => {
    const scored = scoreProposals([proposal('twap', 3300, 0.2), proposal('arbitrage', 3100, 0.2)], {
      isBuy: false,
    })
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
    const scored = scoreProposals([proposal('twap', 3200, 0), proposal('shadow', 3200, 0)], {
      isBuy: true,
    })
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

/**
 * A proposal that cannot be executed must never be recommended.
 *
 * When an agent fails, the server substitutes a canned mock so the panel shows
 * four cards rather than three and a gap. That mock carries no route, so it
 * cannot be built or signed — but scoring knew nothing about it and ranked it
 * alongside real work.
 *
 * The result was the worst possible outcome: a fabricated strategy winning on
 * invented numbers, presented as the recommendation, and failing only when the
 * user tried to act on it. A losing real proposal is better than a winning
 * fake one, because at least it can be executed.
 */
describe('unexecutable proposals cannot win', () => {
  const real = (over: Partial<AgentProposalResult> = {}): AgentProposalResult => ({
    strategy: 'shadow',
    routeId: 'horizon-1',
    reasoning: 'Real proposal.',
    projectedAvgPriceUsd: 0.18,
    projectedSlippagePct: 0.5,
    venues: ['stellar-dex'],
    sliceCount: 1,
    confidence: 0.8,
    horizonMinutes: 0,
    executionMode: 'fill' as const,
    ...over,
  })

  it('ranks a real proposal above a degraded one that scores better', () => {
    // The mock claims lower slippage than anything real, because its numbers
    // were written to look good rather than measured.
    const scored = scoreProposals(
      [
        real({ strategy: 'twap', projectedSlippagePct: 0.8 }),
        real({ strategy: 'momentum', projectedSlippagePct: 0.01, degraded: true }),
      ],
      { isBuy: true }
    )

    expect(pickWinner(scored)).toBe('twap')
  })

  it('ranks a real proposal above one with no route', () => {
    // No route means nothing to sign, whatever the numbers say.
    const scored = scoreProposals(
      [
        real({ strategy: 'twap', projectedSlippagePct: 0.9 }),
        // No route at all: the field is omitted, not set to undefined.
        (() => {
          const { routeId: _drop, ...noRoute } = real({
            strategy: 'shadow',
            projectedSlippagePct: 0.01,
          })
          return noRoute as AgentProposalResult
        })(),
      ],
      { isBuy: true }
    )

    expect(pickWinner(scored)).toBe('twap')
  })

  it('still picks the best among several real proposals', () => {
    const scored = scoreProposals(
      [
        real({ strategy: 'twap', projectedSlippagePct: 0.9 }),
        real({ strategy: 'shadow', projectedSlippagePct: 0.1 }),
      ],
      { isBuy: true }
    )
    expect(pickWinner(scored)).toBe('shadow')
  })

  it('falls back to a degraded proposal only when nothing real exists', () => {
    // Every agent failing is a real state, and reporting no winner at all
    // would be less useful than naming the only thing on offer — provided the
    // UI marks it, which it does.
    const scored = scoreProposals([real({ strategy: 'twap', degraded: true })], { isBuy: true })
    expect(pickWinner(scored)).toBe('twap')
  })
})
