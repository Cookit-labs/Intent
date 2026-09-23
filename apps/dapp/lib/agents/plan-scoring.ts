import type { AgentProposalResult } from './brain'

/**
 * What a plan costs itself, beyond the route it picked.
 *
 * Scoring was `100 - vsOraclePct`, and that figure is measured from the
 * chosen route's quote alone. So the score was a pure function of `routeId`:
 * two agents picking the same route tied exactly, and the winner was drawn by
 * a hash of the competition id. Fill or rest, where to rest, how many slices,
 * whether to lend or offramp the proceeds — six of the seven decisions an
 * agent makes — changed nothing. Most wins were coin flips.
 *
 * Every penalty here corresponds to a sentence the brief already gives the
 * agents, and every one is measured from facts the server assembled: the
 * order's size, the user's own words, the recent price range, the anchor's
 * published limits. Nothing an agent says about itself is scored, which is
 * the discipline `measure.ts` established and the reason self-reported
 * figures were abandoned in the first place.
 *
 * Penalties only ever subtract. A plan that does none of these things scores
 * exactly what its route earned, so this can never make a good plan look
 * worse than it did before.
 */

export interface PlanContext {
  /** Order size in dollars, for judging whether a follow-on earns its fee. */
  escrowUsd: number
  /** Oracle price, as a fallback when no recent range is available. */
  referencePriceUsd: number
  /** Whether the user's own words asked for a lending follow-on. */
  askedToLend: boolean
  /** Whether the user's own words asked to reach fiat. */
  askedToOfframp: boolean
  /**
   * A price the user named themselves.
   *
   * An agent resting at a stated limit is obeying the user, however far from
   * the market that price sits, so the reachability penalty does not apply.
   */
  statedLimitPriceUsd?: number
  /** Lowest recent traded price, when the book could be read. */
  recentLowUsd?: number
  /** Highest recent traded price, when the book could be read. */
  recentHighUsd?: number
  /** The anchor's published maximum, when an offramp was offered. */
  offrampMaxUsd?: number
  /** The anchor's published minimum, when an offramp was offered. */
  offrampMinUsd?: number
}

export interface PlanPenalty {
  /** Stable identifier, safe to show beside a card or count on a leaderboard. */
  reason:
    | 'unreachable_rest_price'
    | 'rest_without_price'
    | 'unrequested_follow_on'
    | 'follow_on_not_worth_fee'
    | 'offramp_outside_limits'
    | 'slices_without_split'
  /** Points subtracted from the route score. */
  points: number
  /** One line a person can read, naming the figures it was judged on. */
  detail: string
}

/**
 * How far outside the recent range a resting price may sit before it reads as
 * a refusal to trade rather than patience.
 *
 * Generous on purpose. Resting above the market is the entire point of
 * resting, and an agent that judges the market will come back to it is making
 * a defensible call. What this catches is the order of magnitude — resting
 * XLM at $4 when it has traded between $0.17 and $0.19.
 */
const REST_RANGE_TOLERANCE = 0.5

/**
 * Below this, a second signature costs more attention than the follow-on
 * returns. The brief tells agents to say so rather than propose it anyway.
 */
const FOLLOW_ON_MIN_USD = 50

/** Penalty weights. Sized so an unrequested instruction outweighs a tidiness error. */
const POINTS = {
  unreachable_rest_price: 25,
  rest_without_price: 20,
  unrequested_follow_on: 30,
  follow_on_not_worth_fee: 10,
  offramp_outside_limits: 25,
  slices_without_split: 5,
} as const

function restPenalty(proposal: AgentProposalResult, context: PlanContext): PlanPenalty | undefined {
  if (proposal.executionMode !== 'rest' && proposal.executionMode !== 'split') return undefined

  const price = proposal.restPriceUsd ?? 0
  if (price <= 0) {
    return {
      reason: 'rest_without_price',
      points: POINTS.rest_without_price,
      detail: 'Resting the remainder, but no resting price was set.',
    }
  }

  // A price the user named is the user's decision, not the agent's.
  if (context.statedLimitPriceUsd !== undefined && context.statedLimitPriceUsd > 0) return undefined

  const low = context.recentLowUsd ?? context.referencePriceUsd
  const high = context.recentHighUsd ?? context.referencePriceUsd
  if (low <= 0 || high <= 0) return undefined

  const floor = low * (1 - REST_RANGE_TOLERANCE)
  const ceiling = high * (1 + REST_RANGE_TOLERANCE)
  if (price >= floor && price <= ceiling) return undefined

  return {
    reason: 'unreachable_rest_price',
    points: POINTS.unreachable_rest_price,
    detail: `Rests at $${price}, outside the recent $${low}–$${high} range.`,
  }
}

function followOnPenalties(proposal: AgentProposalResult, context: PlanContext): PlanPenalty[] {
  const action = proposal.thenAction
  if (action === undefined) return []

  const asked = action === 'lend' ? context.askedToLend : context.askedToOfframp
  if (!asked) {
    return [
      {
        reason: 'unrequested_follow_on',
        points: POINTS.unrequested_follow_on,
        detail: `Proposes ${action} without the user asking for it.`,
      },
    ]
  }

  const out: PlanPenalty[] = []

  if (context.escrowUsd > 0 && context.escrowUsd < FOLLOW_ON_MIN_USD) {
    out.push({
      reason: 'follow_on_not_worth_fee',
      points: POINTS.follow_on_not_worth_fee,
      detail: `A second signature on $${Math.round(context.escrowUsd)} costs more than it returns.`,
    })
  }

  if (action === 'offramp') {
    const { offrampMaxUsd: max, offrampMinUsd: min, escrowUsd: size } = context
    const overMax = max !== undefined && size > max
    const underMin = min !== undefined && size < min
    if (overMax || underMin) {
      out.push({
        reason: 'offramp_outside_limits',
        points: POINTS.offramp_outside_limits,
        detail: overMax
          ? `Withdraws $${Math.round(size)}, above the anchor's $${max} maximum.`
          : `Withdraws $${Math.round(size)}, below the anchor's $${min} minimum.`,
      })
    }
  }

  return out
}

function slicePenalty(proposal: AgentProposalResult): PlanPenalty | undefined {
  if (proposal.sliceCount <= 1) return undefined
  if (proposal.executionMode === 'split') return undefined
  return {
    reason: 'slices_without_split',
    points: POINTS.slices_without_split,
    detail: `Claims ${proposal.sliceCount} slices on a single ${proposal.executionMode}.`,
  }
}

/** Every way this plan costs itself, in the order a reader would meet them. */
export function planPenalties(proposal: AgentProposalResult, context: PlanContext): PlanPenalty[] {
  const out: PlanPenalty[] = []

  const rest = restPenalty(proposal, context)
  if (rest !== undefined) out.push(rest)

  out.push(...followOnPenalties(proposal, context))

  const slices = slicePenalty(proposal)
  if (slices !== undefined) out.push(slices)

  return out
}

/**
 * The route's measured quality, less what the plan around it costs.
 *
 * Floored at zero: a score is a rank, not a debt, and two catastrophic plans
 * should compare on their routes rather than on how far negative each one
 * drove itself.
 */
export function planScore(proposal: AgentProposalResult, context: PlanContext): number {
  const route = 100 - proposal.projectedSlippagePct
  const cost = planPenalties(proposal, context).reduce((sum, p) => sum + p.points, 0)
  return Number(Math.max(0, route - cost).toFixed(1))
}
