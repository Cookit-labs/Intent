import { beforeEach, describe, expect, it } from 'vitest'

import type { BrainProvider } from '../agents/brain'
import { benchedUntilFor, lineUp, noteRateLimited, resetLineUp } from '../agents/lineup'
import type { RosterAgent } from '../agents/registry'

/**
 * The free OpenRouter key allows 50 requests a day across every free model, so
 * a race seats two of its agents in turn rather than all five, and a provider
 * that answered 429 sits out until its reset instead of failing again.
 */

function agent(provider: BrainProvider, model: string): RosterAgent {
  return { key: `${provider}-${model}`, name: model, gradient: '', provider, model } as RosterAgent
}

const roster = [
  agent('groq', 'qwen'),
  ...['a', 'b', 'c', 'd', 'e'].map((m) => agent('openrouter', m)),
  agent('deepseek', 'flash'),
]

const keys = (r: RosterAgent[]): string[] => r.map((a) => a.key)

beforeEach(() => resetLineUp())

describe('lineUp', () => {
  it('seats two OpenRouter agents and everyone else', () => {
    expect(keys(lineUp(roster))).toEqual([
      'groq-qwen',
      'openrouter-a',
      'openrouter-b',
      'deepseek-flash',
    ])
  })

  it('gives every OpenRouter model a turn', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 3; i += 1) {
      for (const a of lineUp(roster)) if (a.provider === 'openrouter') seen.add(a.model)
    }
    expect([...seen].sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('benches a rate-limited provider until its reset', () => {
    const now = 1_000_000
    noteRateLimited('openrouter', 30_000, now)
    expect(lineUp(roster, now + 1).some((a) => a.provider === 'openrouter')).toBe(false)
    expect(lineUp(roster, now + 30_001).some((a) => a.provider === 'openrouter')).toBe(true)
  })

  it('names when the first provider is back once all are benched', () => {
    const now = 1_000_000
    noteRateLimited('groq', 10_000, now)
    noteRateLimited('openrouter', 60_000, now)
    noteRateLimited('deepseek', 120_000, now)
    expect(lineUp(roster, now)).toEqual([])
    expect(benchedUntilFor(roster, now)).toBe(now + 10_000)
  })
})
