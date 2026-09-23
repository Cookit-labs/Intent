import { describe, expect, it } from 'vitest'

import {
  bootstrapIntervals,
  bradleyTerry,
  countRankableRaces,
  minimumRacesForRanking,
  pairwiseOutcomes,
  rankPositions,
  rankWithConfidence,
  rankingIsMeaningful,
} from '../agents/ranking'
import type { ChatTurn } from '../chat-history'

/**
 * The ranking reads races as paired comparisons. A race says only that its
 * winner scored above each competitor that answered; it says nothing about
 * agents that timed out, and nothing at all when every agent tied.
 */

interface Fixture {
  name?: string
  score?: number
  failed?: 'timeout'
}

function turn(id: string, winner: string | null, proposals: Record<string, Fixture>): ChatTurn {
  return {
    id,
    chain: 'stellar',
    text: 'swap',
    createdAt: '2026-09-23T00:00:00.000Z',
    winner,
    proposals: Object.fromEntries(
      Object.entries(proposals).map(([key, p]) => [
        key,
        {
          key,
          name: p.name ?? key,
          avgPriceUsd: 1,
          vsOraclePct: 0,
          score: p.score ?? 0,
          ...(p.failed !== undefined ? { failed: p.failed } : {}),
        },
      ])
    ),
  }
}

describe('pairwiseOutcomes', () => {
  it('records the winner beating each competitor it outscored', () => {
    const out = pairwiseOutcomes([
      turn('1', 'a', { a: { score: 100 }, b: { score: 90 }, c: { score: 80 } }),
    ])
    expect(out).toEqual([
      { winner: 'a', loser: 'b', weight: 1 },
      { winner: 'a', loser: 'c', weight: 1 },
    ])
  })

  it('does not count a failed proposal as a loss', () => {
    const out = pairwiseOutcomes([
      turn('1', 'a', { a: { score: 100 }, b: { score: 90 }, c: { failed: 'timeout' } }),
    ])
    expect(out).toEqual([{ winner: 'a', loser: 'b', weight: 1 }])
  })

  it('splits a draw half each way, so it carries no ordering', () => {
    const out = pairwiseOutcomes([turn('1', 'a', { a: { score: 100 }, b: { score: 100 } })])
    expect(out).toEqual([
      { winner: 'a', loser: 'b', weight: 0.5 },
      { winner: 'b', loser: 'a', weight: 0.5 },
    ])
  })

  it('contributes nothing from a race with no winner', () => {
    expect(pairwiseOutcomes([turn('1', null, { a: {}, b: {} })])).toEqual([])
  })
})

function beats(winner: string, loser: string, times: number, weight = 1) {
  return Array.from({ length: times }, () => ({ winner, loser, weight }))
}

describe('bradleyTerry', () => {
  it('rates a clearly dominant agent above the rest', () => {
    const strength = bradleyTerry(
      [...beats('a', 'b', 6), ...beats('a', 'c', 6), ...beats('b', 'c', 3), ...beats('c', 'b', 3)],
      ['a', 'b', 'c']
    )
    expect(strength.a).toBeGreaterThan(strength.b ?? NaN)
    expect(strength.a).toBeGreaterThan(strength.c ?? NaN)
  })

  it('gives two agents with identical records identical strength', () => {
    const strength = bradleyTerry(
      [...beats('a', 'c', 3), ...beats('b', 'c', 3), ...beats('c', 'a', 1), ...beats('c', 'b', 1)],
      ['a', 'b', 'c']
    )
    expect(strength.a).toBeCloseTo(strength.b ?? NaN, 6)
  })

  it('centres log-strength at zero', () => {
    const strength = bradleyTerry([...beats('a', 'b', 4), ...beats('b', 'c', 2)], ['a', 'b', 'c'])
    const sum = Object.values(strength).reduce((acc, v) => acc + v, 0)
    expect(sum).toBeCloseTo(0, 9)
  })

  it('keeps an undefeated agent finite', () => {
    const strength = bradleyTerry(beats('a', 'b', 10), ['a', 'b'])
    expect(Number.isFinite(strength.a)).toBe(true)
    expect(strength.a).toBeGreaterThan(strength.b ?? NaN)
  })

  it('rates a lone agent at the centre', () => {
    expect(bradleyTerry([], ['a'])).toEqual({ a: 0 })
  })
})

/** A mixed record: a wins more often than b, but not always. */
function mixedHistory(): ChatTurn[] {
  return [
    turn('1', 'a', { a: { score: 100 }, b: { score: 90 }, c: { score: 80 } }),
    turn('2', 'a', { a: { score: 100 }, b: { score: 90 } }),
    turn('3', 'b', { a: { score: 90 }, b: { score: 100 } }),
    turn('4', 'a', { a: { score: 100 }, b: { score: 90 } }),
    turn('5', 'b', { a: { score: 90 }, b: { score: 100 }, c: { score: 80 } }),
    turn('6', 'a', { a: { score: 100 }, b: { score: 90 } }),
  ]
}

describe('bootstrapIntervals', () => {
  it('is reproducible for the same seed', () => {
    const first = bootstrapIntervals(mixedHistory(), { samples: 50, seed: 7 })
    const second = bootstrapIntervals(mixedHistory(), { samples: 50, seed: 7 })
    expect(first).toEqual(second)
  })

  it('gives every agent that raced an interval with low at or below high', () => {
    const intervals = bootstrapIntervals(mixedHistory(), { samples: 50, seed: 1 })
    expect(Object.keys(intervals).sort()).toEqual(['a', 'b', 'c'])
    for (const { low, high } of Object.values(intervals)) {
      expect(low).toBeLessThanOrEqual(high)
    }
  })

  it('widens the interval when the record is mixed', () => {
    const intervals = bootstrapIntervals(mixedHistory(), { samples: 50, seed: 1 })
    expect(intervals.a?.high).toBeGreaterThan(intervals.a?.low ?? NaN)
  })
})

/** `count` races in which a beats b and c outright. */
function dominantHistory(count: number): ChatTurn[] {
  return Array.from({ length: count }, (_, i) =>
    turn(String(i), 'a', { a: { score: 100 }, b: { score: 90 }, c: { score: 80 } })
  )
}

describe('rankWithConfidence', () => {
  it('puts a clearly dominant agent first, above the 1000 centre', () => {
    const ranked = rankWithConfidence(dominantHistory(8))
    expect(ranked.map((r) => r.key)).toEqual(['a', 'b', 'c'])
    expect(ranked[0]?.rating).toBeGreaterThan(1000)
    expect(ranked[0]?.low).toBeLessThanOrEqual(ranked[0]?.rating ?? NaN)
    expect(ranked[0]?.high).toBeGreaterThanOrEqual(ranked[0]?.rating ?? NaN)
  })

  it('gives two agents with identical records the same rating', () => {
    const ranked = rankWithConfidence([
      turn('1', 'a', { a: { score: 100 }, c: { score: 80 } }),
      turn('2', 'b', { b: { score: 100 }, c: { score: 80 } }),
      turn('3', 'a', { a: { score: 100 }, c: { score: 80 } }),
      turn('4', 'b', { b: { score: 100 }, c: { score: 80 } }),
      turn('5', 'c', { a: { score: 80 }, c: { score: 100 } }),
      turn('6', 'c', { b: { score: 80 }, c: { score: 100 } }),
    ])
    const a = ranked.find((r) => r.key === 'a')
    const b = ranked.find((r) => r.key === 'b')
    expect(a?.rating).toBeCloseTo(b?.rating ?? NaN, 6)
    expect(a?.wins).toBe(2)
    expect(b?.wins).toBe(2)
  })

  it('reports no confidence with two races', () => {
    const ranked = rankWithConfidence(dominantHistory(2))
    expect(ranked.map((r) => r.confidence)).toEqual(['none', 'none', 'none'])
  })

  it('caps confidence at medium under twenty races, however narrow the interval', () => {
    expect(rankWithConfidence(dominantHistory(19))[0]?.confidence).toBe('medium')
    expect(rankWithConfidence(dominantHistory(20))[0]?.confidence).toBe('high')
  })

  it('does not order agents that only ever drew', () => {
    const ranked = rankWithConfidence(
      Array.from({ length: 6 }, (_, i) =>
        turn(String(i), 'a', { a: { score: 100 }, b: { score: 100 }, c: { score: 100 } })
      )
    )
    for (const row of ranked) {
      expect(row.rating).toBeCloseTo(1000, 6)
      expect(row.wins).toBe(0)
      expect(row.races).toBe(6)
    }
  })

  it('does not count a failed proposal as a loss or a race', () => {
    const ranked = rankWithConfidence([
      ...dominantHistory(5),
      turn('x', 'a', { a: { score: 100 }, b: { score: 90 }, c: { failed: 'timeout' } }),
      turn('y', 'a', { a: { score: 100 }, d: { failed: 'timeout' } }),
    ])
    const c = ranked.find((r) => r.key === 'c')
    expect(c?.races).toBe(5)
    expect(ranked.find((r) => r.key === 'd')).toBeUndefined()
  })

  it('reproduces the same intervals on every call', () => {
    expect(rankWithConfidence(mixedHistory())).toEqual(rankWithConfidence(mixedHistory()))
  })

  it('keeps the latest display name', () => {
    const ranked = rankWithConfidence([
      turn('1', 'a', { a: { name: 'Old', score: 100 }, b: { score: 90 } }),
      turn('2', 'a', { a: { name: 'New', score: 100 }, b: { score: 90 } }),
    ])
    expect(ranked[0]?.name).toBe('New')
  })

  it('is empty with no turns', () => {
    expect(rankWithConfidence([])).toEqual([])
  })
})

describe('rankPositions', () => {
  it('gives agents whose intervals overlap the same position', () => {
    const rows = [
      { rating: 1100, low: 1080, high: 1120 },
      { rating: 1000, low: 960, high: 1040 },
      { rating: 990, low: 950, high: 1030 },
      { rating: 900, low: 880, high: 920 },
    ]
    expect(rankPositions(rows)).toEqual([1, 2, 2, 4])
  })

  it('is empty for an empty board', () => {
    expect(rankPositions([])).toEqual([])
  })
})

describe('rankingIsMeaningful', () => {
  it('needs at least five races between two or more agents', () => {
    expect(minimumRacesForRanking).toBe(5)
    expect(rankingIsMeaningful(dominantHistory(4))).toBe(false)
    expect(rankingIsMeaningful(dominantHistory(5))).toBe(true)
  })

  it('is not met by races with a single competitor', () => {
    const solo = Array.from({ length: 6 }, (_, i) => turn(String(i), 'a', { a: { score: 100 } }))
    expect(countRankableRaces(solo)).toBe(0)
    expect(rankingIsMeaningful(solo)).toBe(false)
  })

  it('counts a draw as a race that ran', () => {
    const draws = Array.from({ length: 5 }, (_, i) =>
      turn(String(i), 'a', { a: { score: 100 }, b: { score: 100 } })
    )
    expect(countRankableRaces(draws)).toBe(5)
  })
})
