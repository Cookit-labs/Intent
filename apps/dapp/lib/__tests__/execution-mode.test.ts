import { describe, expect, it } from 'vitest'

import { resolveExecutionPlan, validateProposal } from '../agents/tool-schema'

/**
 * An agent proposes a plan, not a description.
 *
 * The four agents used to be locked to one axis each — TWAP had to slice,
 * Momentum was forbidden from splitting — so an agent that correctly judged
 * "this order is too small to slice, just fill it" was rejected for being
 * right. Every agent can now reach any conclusion the evidence supports, which
 * means the proposal has to carry which one it reached.
 *
 * The price is where the danger is. An agent naming a resting price is a
 * language model choosing the number that decides whether an order ever fills,
 * so it is bounded rather than trusted.
 */

const base = {
  routeId: 'horizon-1',
  reasoning: 'Order is small relative to book depth, so a single fill costs less than waiting.',
  projectedAvgPriceUsd: 0.11,
  projectedSlippagePct: 0.2,
  venues: ['stellar-dex'],
  sliceCount: 1,
  confidence: 0.8,
  horizonMinutes: 0,
  executionMode: 'fill' as const,
  restPriceUsd: 0,
  splitPct: 0,
  thenAction: 'none',
  thenVenue: '',
}

const ctx = {
  referencePriceUsd: 0.11,
  allowedVenueIds: ['stellar-dex'],
  allowedRouteIds: ['horizon-1'],
}

describe('an agent states how it will execute', () => {
  it('accepts an immediate fill', () => {
    const result = validateProposal(base, ctx)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.executionMode).toBe('fill')
  })

  it('accepts an order that rests', () => {
    const result = validateProposal(
      { ...base, executionMode: 'rest', restPriceUsd: 0.09, horizonMinutes: 60 },
      ctx
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.executionMode).toBe('rest')
  })

  it('refuses a mode it does not understand', () => {
    expect(validateProposal({ ...base, executionMode: 'teleport' }, ctx).ok).toBe(false)
  })

  /**
   * The lane problem, as a test.
   *
   * Under the old prompts TWAP was required to use sliceCount above 1, so this
   * proposal — a single fill, correctly judged — would have been rejected.
   */
  it('accepts a single fill from any agent', () => {
    const result = validateProposal({ ...base, sliceCount: 1 }, ctx)
    expect(result.ok).toBe(true)
  })

  it('accepts slicing from any agent', () => {
    const result = validateProposal({ ...base, sliceCount: 8, horizonMinutes: 120 }, ctx)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.sliceCount).toBe(8)
  })
})

/**
 * Which price an order actually rests at.
 *
 * Three rules in priority order, and the first one is absolute: a price the
 * user typed is not the agent's to move.
 */
describe('resolving the price an order rests at', () => {
  const book = { bid: 0.108, ask: 0.12 }

  it('uses the price the user stated, ignoring the agent', () => {
    // The user said $0.09. The agent wants $0.115. The user wins.
    const plan = resolveExecutionPlan({
      mode: 'rest',
      agentPriceUsd: 0.115,
      statedLimitPriceUsd: 0.09,
      selling: { kind: 'classic', code: 'USDC', issuer: 'GBBD47' },
      book,
    })

    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(plan.restPriceUsd).toBe(0.09)
      expect(plan.priceSource).toBe('user')
    }
  })

  it('lets the agent choose when the user named no price', () => {
    const plan = resolveExecutionPlan({
      mode: 'rest',
      agentPriceUsd: 0.11,
      statedLimitPriceUsd: undefined,
      selling: { kind: 'classic', code: 'USDC', issuer: 'GBBD47' },
      book,
    })

    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(plan.restPriceUsd).toBe(0.11)
      expect(plan.priceSource).toBe('agent')
    }
  })

  it('clamps an agent price that rests too far from the market', () => {
    // Buying at 0.01 against a 0.12 ask would never fill. Clamped to the band
    // rather than rejected: the judgement to rest is still sound.
    const plan = resolveExecutionPlan({
      mode: 'rest',
      agentPriceUsd: 0.01,
      statedLimitPriceUsd: undefined,
      selling: { kind: 'classic', code: 'USDC', issuer: 'GBBD47' },
      book,
    })

    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(plan.restPriceUsd).toBeGreaterThan(0.01)
      expect(plan.clamped).toBe(true)
    }
  })

  it('rejects an agent price that would cross the spread', () => {
    // Resting at 0.35 when sellers ask 0.12 fills instantly. That is a market
    // order wearing a limit order's label.
    const plan = resolveExecutionPlan({
      mode: 'rest',
      agentPriceUsd: 0.35,
      statedLimitPriceUsd: undefined,
      selling: { kind: 'classic', code: 'USDC', issuer: 'GBBD47' },
      book,
    })

    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.reason).toBe('would_fill_now')
  })

  it('rejects a stated price that would cross, rather than clamping it', () => {
    // A user price is never moved, so a crossing one has to be refused. Silently
    // adjusting it would fill at a price they did not choose.
    const plan = resolveExecutionPlan({
      mode: 'rest',
      agentPriceUsd: 0.09,
      statedLimitPriceUsd: 0.35,
      selling: { kind: 'classic', code: 'USDC', issuer: 'GBBD47' },
      book,
    })

    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.reason).toBe('would_fill_now')
  })

  it('needs no price at all to fill now', () => {
    const plan = resolveExecutionPlan({
      mode: 'fill',
      agentPriceUsd: 0,
      statedLimitPriceUsd: undefined,
      selling: { kind: 'classic', code: 'USDC', issuer: 'GBBD47' },
      book,
    })

    expect(plan.ok).toBe(true)
    if (plan.ok) expect(plan.restPriceUsd).toBeUndefined()
  })

  it('cannot rest when nothing is quoted', () => {
    const plan = resolveExecutionPlan({
      mode: 'rest',
      agentPriceUsd: 0.09,
      statedLimitPriceUsd: undefined,
      selling: { kind: 'classic', code: 'USDC', issuer: 'GBBD47' },
      book: { bid: undefined, ask: undefined },
    })

    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.reason).toBe('no_market')
  })

  it('reads a sell order against the bid', () => {
    // Selling XLM: resting above the bid waits, at or below it trades now.
    const plan = resolveExecutionPlan({
      mode: 'rest',
      agentPriceUsd: 0.05,
      statedLimitPriceUsd: undefined,
      selling: { kind: 'classic', code: 'XLM' },
      book,
    })

    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.reason).toBe('would_fill_now')
  })
})

/**
 * Every agent must be executable.
 *
 * The promise is that picking any agent — recommended or not — fills the
 * intent. An agent that reasons well, names a route in its prose, and then
 * leaves routeId blank breaks that: the proposal renders normally and cannot
 * be signed. Observed live, from two of four agents in one competition.
 */
describe('a proposal always carries something signable', () => {
  const withRoutes = {
    referencePriceUsd: 0.11,
    allowedVenueIds: ['stellar-dex'],
    allowedRouteIds: ['horizon-1', 'horizon-2'],
  }

  it('falls back to the best route when the agent named none', () => {
    const result = validateProposal({ ...base, routeId: '' }, withRoutes)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.routeId).toBe('horizon-1')
  })

  it('keeps a route the agent did name', () => {
    const result = validateProposal({ ...base, routeId: 'horizon-2' }, withRoutes)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.routeId).toBe('horizon-2')
  })

  it('still rejects a route that does not exist', () => {
    // Choosing wrong is not the same as not choosing. Substituting here would
    // sign a trade the agent did not pick.
    expect(validateProposal({ ...base, routeId: 'horizon-9' }, withRoutes).ok).toBe(false)
  })

  it('leaves the id empty when nothing was offered', () => {
    const result = validateProposal(
      { ...base, routeId: '' },
      { referencePriceUsd: 0.11, allowedVenueIds: ['stellar-dex'], allowedRouteIds: [] }
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.routeId).toBe('')
  })
})

/**
 * An agent proposing several steps rather than one.
 *
 * The capability that makes the competition consequential. Four agents
 * proposing four strategies previously signed the same single transaction, so
 * choosing between them changed the reasoning shown and nothing else. A plan
 * is where they can genuinely diverge.
 *
 * The schema stays deliberately narrow: an agent chooses a *shape* from a
 * fixed set, not arbitrary operations. Letting a model compose freely would
 * mean validating whatever it invented, and the validator is the only thing
 * standing between a user and an agent-composed transaction.
 */
describe('agents may propose a plan', () => {
  it('accepts a split between filling now and resting', () => {
    const result = validateProposal(
      { ...base, executionMode: 'split', restPriceUsd: 0.09, splitPct: 50 },
      ctx
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.executionMode).toBe('split')
      expect(result.value.splitPct).toBe(50)
    }
  })

  it('requires a resting price when splitting', () => {
    // Half now and half resting at nothing is not a plan.
    const result = validateProposal(
      { ...base, executionMode: 'split', restPriceUsd: 0, splitPct: 50 },
      ctx
    )
    expect(result.ok).toBe(false)
  })

  it('refuses a split that is entirely one side', () => {
    // 0% or 100% is not a split — it is a fill or a rest, and saying so
    // plainly keeps the modes meaningful.
    for (const pct of [0, 100]) {
      expect(
        validateProposal(
          { ...base, executionMode: 'split', restPriceUsd: 0.09, splitPct: pct },
          ctx
        ).ok
      ).toBe(false)
    }
  })

  it('ignores a split percentage on a plain fill', () => {
    // A stray field must not turn a single-step proposal into a plan.
    const result = validateProposal({ ...base, executionMode: 'fill', splitPct: 40 }, ctx)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.executionMode).toBe('fill')
  })
})

/**
 * The price guard must not reject the truth.
 *
 * It exists to catch a fabricated number and was doing the opposite. Agents
 * are shown two venues whose prices genuinely differ — Horizon quoting 503 XLM
 * for 500 USDC against Soroswap's 4,732 for the same input — but the guard was
 * given only the *first* route's rate to judge against.
 *
 * So an agent that picked the better venue and quoted its rate honestly, 0.1056
 * against Horizon's 0.9930, was rejected as implausible. All four failed, the
 * server substituted canned mock proposals, and the app displayed strategies
 * citing Curve and Uniswap on a Stellar intent. The competition looked
 * hardcoded because the real agents were being thrown away.
 *
 * The fix is not a wider tolerance — that would have let genuine fabrications
 * through. Every route an agent may choose contributes its rate as a valid
 * basis, because choosing any of them is a legitimate answer.
 */
describe('every offered route is a legitimate basis', () => {
  const twoVenues = {
    referencePriceUsd: 0.18,
    // Horizon and Soroswap, as measured live. Nearly ten times apart, and both
    // real.
    routeRates: [0.993009, 0.105647],
    allowedVenueIds: ['stellar-dex'],
    allowedRouteIds: ['horizon-1', 'soroswap-2'],
  }

  it('accepts the rate of the better route', () => {
    // The exact figure every agent produced, and the exact one being rejected.
    const result = validateProposal({ ...base, projectedAvgPriceUsd: 0.105647 }, twoVenues)
    expect(result.ok, result.ok ? '' : result.reason).toBe(true)
  })

  it('accepts the rate of the worse route', () => {
    // An agent may legitimately prefer the classic venue — deeper book, no
    // contract risk — and quoting its rate is not a fabrication.
    expect(validateProposal({ ...base, projectedAvgPriceUsd: 0.993009 }, twoVenues).ok).toBe(true)
  })

  it('accepts the market reference itself', () => {
    expect(validateProposal({ ...base, projectedAvgPriceUsd: 0.18 }, twoVenues).ok).toBe(true)
  })

  it('still rejects a number matching no route and no market', () => {
    // The guard has to keep working: this figure is shown to the user as a
    // projected fill, and an agent inventing one is the failure it exists for.
    expect(validateProposal({ ...base, projectedAvgPriceUsd: 50 }, twoVenues).ok).toBe(false)
    expect(validateProposal({ ...base, projectedAvgPriceUsd: 0.4 }, twoVenues).ok).toBe(false)
  })

  it('stays strict when only one basis exists', () => {
    // With a single reference the guard is as tight as it ever was. Widening
    // only happens where the evidence genuinely disagrees.
    const single = { ...twoVenues, routeRates: [0.18] }
    expect(validateProposal({ ...base, projectedAvgPriceUsd: 0.19 }, single).ok).toBe(true)
    expect(validateProposal({ ...base, projectedAvgPriceUsd: 0.9 }, single).ok).toBe(false)
  })
})
