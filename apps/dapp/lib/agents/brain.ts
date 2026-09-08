import type { AgentStrategyType } from '@intent/types'

import type { ParsedIntent } from '../parse-intent'

/**
 * The seam between the competition flow and whatever produces agent proposals.
 *
 * This mirrors `ChainAdapter`: one interface, several implementations, chosen at
 * the edge. The reason is the same in both cases — a mock table and a remote
 * model share no machinery, and without a common shape every caller ends up
 * branching on which one is active.
 *
 * The vendor behind this is expected to change (DeepSeek now, on cost; likely
 * something else later), so nothing outside `brains/` should know the provider
 * exists.
 */

/** The four competing strategies. Narrower than `AgentStrategyType`, which also allows 'custom'. */
export type AgentStrategyKey = Extract<
  AgentStrategyType,
  'twap' | 'momentum' | 'shadow' | 'arbitrage'
>

export type BrainProvider = 'deepseek' | 'mock'

/**
 * Market facts handed to the model.
 *
 * Prices are passed in rather than left to the model's memory. Recall of
 * specific figures is the weakest part of a cheap model's output, and a
 * hallucinated spot price would flow straight into a projected fill.
 */
export interface MarketContext {
  /** ISO timestamp these figures were taken. */
  asOf: string
  /** USD price per token symbol. */
  prices: Record<string, number>
  /** Venues the agent may name, already filtered to the active chain. */
  venues: { id: string; name: string; category: string }[]
  volatilityHint: 'low' | 'normal' | 'elevated'
  gasHint: 'cheap' | 'normal' | 'expensive'
}

export interface ProposalRequest {
  intent: ParsedIntent
  strategy: AgentStrategyKey
  market: MarketContext
  /** Chain slug, so venue and settlement talk stays plausible for the chain. */
  chain: string
  /** Caller-owned cancellation; the brain must honour it. */
  signal?: AbortSignal
}

/**
 * What an agent proposes. Every field is checked after the model returns —
 * strict tool schemas constrain shape but cannot express ranges, so a
 * schema-valid 400% slippage is still possible and still has to be rejected.
 */
export interface AgentProposalResult {
  strategy: AgentStrategyKey
  /** One or two sentences, shown in the competition panel. */
  reasoning: string
  projectedAvgPriceUsd: number
  projectedSlippagePct: number
  /** Venue ids, validated against the ones offered in `MarketContext`. */
  venues: string[]
  /** 1 for a single fill, higher for a sliced execution. */
  sliceCount: number
  /** Self-reported, 0-1. Advisory only — it does not feed scoring. */
  confidence: number
  horizonMinutes: number
}

export type BrainErrorCode =
  | 'timeout'
  | 'rate_limited'
  | 'invalid_schema'
  | 'refused'
  | 'upstream_error'
  | 'no_api_key'

export interface BrainMeta {
  provider: BrainProvider
  model: string
  latencyMs: number
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  costUsd: number
  /** True when this came from a fallback rather than the configured provider. */
  degraded: boolean
}

/**
 * Discriminated result rather than a thrown error: a failing agent is an
 * ordinary outcome here, not an exception. One agent timing out should still
 * leave a competition with three real proposals, and that is easier to
 * guarantee when the failure is a value the caller must handle.
 */
export type ProposalOutcome =
  | { ok: true; proposal: AgentProposalResult; meta: BrainMeta }
  | { ok: false; error: BrainErrorCode; meta: BrainMeta }

export interface AgentBrain {
  id: BrainProvider
  displayName: string
  /** False when required configuration is missing, so callers can pick a fallback. */
  isConfigured: () => boolean
  /**
   * One strategy per call. Four short independent calls beat a single long
   * agentic loop: failures stay isolated, results can stream as they land, and
   * short bounded reasoning is what these models do best.
   */
  propose: (req: ProposalRequest) => Promise<ProposalOutcome>
}

export const ALL_STRATEGIES: readonly AgentStrategyKey[] = [
  'twap',
  'momentum',
  'arbitrage',
  'shadow',
]
