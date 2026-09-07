import { describe, expect, it } from 'vitest'

import { planDecision, planReveal } from '../agents/pacing'

/**
 * The pacing rules that keep a live race feeling like the scripted one.
 */
describe('planReveal', () => {
  it('holds an early arrival back to its floor', () => {
    const { revealAtMs, delayMs } = planReveal(2500, 400)
    expect(revealAtMs).toBe(2500)
    expect(delayMs).toBe(2100)
  })

  it('reveals a late arrival immediately', () => {
    const { revealAtMs, delayMs } = planReveal(1100, 5000)
    expect(revealAtMs).toBe(5000)
    expect(delayMs).toBe(0)
  })

  it('never asks for a negative delay', () => {
    expect(planReveal(0, 9999).delayMs).toBe(0)
  })

  it('preserves the staggered order when everything lands at once', () => {
    // All four responses arriving together is the common case with a fast
    // model, and is exactly when the floors matter.
    const floors = [1100, 2500, 3900, 5400]
    const reveals = floors.map((f) => planReveal(f, 50).revealAtMs)
    expect(reveals).toEqual(floors)
    expect([...reveals].sort((a, b) => a - b)).toEqual(reveals)
  })
})

describe('planDecision', () => {
  it('waits for the scripted decision point when reveals were fast', () => {
    expect(planDecision(7400, 5400)).toBe(7400)
  })

  it('waits for the last card plus a gap when reveals ran long', () => {
    expect(planDecision(7400, 9000)).toBe(9400)
  })

  it('never announces on top of the final reveal', () => {
    const decided = planDecision(7400, 7300)
    expect(decided).toBeGreaterThan(7300)
  })
})
