import type { AgentStrategyKey, BrainErrorCode } from './brain'
import { STRATEGIES, STRATEGY_ORDER } from './strategies'

/**
 * What a competition looks like from the client's side.
 *
 * Shared between the hook that drives it, the panel that renders it, and the
 * history that records it. Nothing here touches a model or a network: it is
 * the shape of a race, not the running of one.
 *
 * This file replaces `lib/mock-competition.ts`, which held these same types
 * beside a table of canned proposals. The proposals are gone. An agent that
 * does not answer is shown as an agent that did not answer, and a competition
 * with no live agents says so — a plausible-looking placeholder is worse than
 * an honest gap, because it reads as a decision somebody made.
 */

export type CompetitionPhase = 'idle' | 'competing' | 'decided'

/** Why a competition could not run at all, as opposed to one agent failing. */
export type CompetitionErrorCode = 'agents_offline' | 'chain_unsupported' | 'no_agent_answered'

export interface CompetitionError {
  code: CompetitionErrorCode
  /** Shown to the user verbatim. */
  message: string
}

export interface AgentProposalView {
  key: string
  name: string
  /**
   * Measured from the route the agent chose, not reported by the agent.
   *
   * `avgPriceUsd` is what a unit of the received asset cost in dollars;
   * `vsOraclePct` is how far the fill sits from the oracle's fair value —
   * positive is worse, negative is better. Both come from the quote's real
   * numbers and the oracle price, so a confident claim earns nothing.
   */
  avgPriceUsd: number
  vsOraclePct: number
  score: number
  reasoning?: string
  /** The venue the chosen route executes on. */
  source?: string
  sliceCount?: number
  horizonMinutes?: number
  executionMode?: 'fill' | 'rest' | 'split'
  splitPct?: number
  restPriceUsd?: number
  thenAction?: 'lend' | 'offramp'
  thenVenue?: string
  /** Set when the agent produced no proposal: timed out, refused, or was rejected. */
  failed?: BrainErrorCode
}

export interface CompetitionState {
  proposals: Record<string, AgentProposalView>
  revealed: Record<string, boolean>
  /**
   * The model behind each agent, keyed by strategy.
   *
   * Shown on the card so the line-up is visible rather than asserted. Four
   * agents on one model converge, and when they do the user deserves to see
   * why; four on three models disagree, and that is worth seeing too. Empty
   * until the opening frame arrives.
   */
  models: Record<string, string>
  phase: CompetitionPhase
  secondsLeft: number
  winner: string | null
  /**
   * True when the agents that answered all proposed the same thing, so
   * `winner` is a draw among equals rather than a judgement between them.
   * The panel shows agreement instead of a crown.
   */
  unanimous?: boolean
  /** Present when the competition could not run, in place of proposals. */
  error?: CompetitionError
}

/**
 * Reveal timing. Floors, not a schedule — see `pacing.ts`. An agent that
 * answers quickly still waits its turn so the cards read as a race; one that
 * answers late appears the moment it can.
 */
export const REVEAL_DELAYS = [1100, 2500, 3900, 5400] as const
export const RACE_DURATION = 6800
export const DECIDE_AT = RACE_DURATION + 600
export const WINDOW_SECONDS = 30

export interface CompetingAgent {
  key: AgentStrategyKey
  name: string
  gradient: string
}

/** The four agents, in display order. Identity only — what each proposes is up to it. */
export const AGENTS: CompetingAgent[] = STRATEGY_ORDER.map((key) => ({
  key,
  name: STRATEGIES[key].name,
  gradient: STRATEGIES[key].gradient,
}))

function money(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`
}

/**
 * The tag under an agent's name, derived from what it proposed.
 *
 * The tags used to be fixed — "Time-sliced", "Cross-venue", "Path search" —
 * and read as each agent's permanent method, when the brief has been shared
 * for some time and any agent may fill, rest or split on any venue. A fixed
 * tag beside a proposal that contradicted it was worse than no tag. This one
 * cannot contradict the proposal, because it is the proposal.
 */
export function describePlan(
  view: Pick<
    AgentProposalView,
    | 'executionMode'
    | 'restPriceUsd'
    | 'splitPct'
    | 'source'
    | 'sliceCount'
    | 'thenAction'
    | 'thenVenue'
    | 'failed'
  >
): string {
  if (view.failed !== undefined) return 'did not respond'

  const parts: string[] = []

  switch (view.executionMode) {
    case 'rest':
      parts.push(view.restPriceUsd !== undefined ? `rests at ${money(view.restPriceUsd)}` : 'rests')
      break
    case 'split':
      parts.push(
        view.splitPct !== undefined && view.restPriceUsd !== undefined
          ? `${view.splitPct}% now, rest at ${money(view.restPriceUsd)}`
          : 'splits'
      )
      break
    case 'fill':
      parts.push('fills now')
      break
    default:
      return ''
  }

  if (view.source !== undefined) parts[0] = `${parts[0]} via ${view.source}`
  if (view.sliceCount !== undefined && view.sliceCount > 1) parts.push(`${view.sliceCount} slices`)
  if (view.thenAction === 'lend') parts.push(`then lends on ${view.thenVenue ?? 'a pool'}`)
  if (view.thenAction === 'offramp')
    parts.push(`then withdraws to fiat via ${view.thenVenue ?? 'an anchor'}`)

  return parts.join(' · ')
}
