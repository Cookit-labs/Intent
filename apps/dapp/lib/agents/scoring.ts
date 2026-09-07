import type { AgentProposalResult, AgentStrategyKey } from './brain'

/**
 * Ranking proposals.
 *
 * This is plain arithmetic on purpose. Asking a model to grade its own
 * competition would make the winner unreproducible between identical runs,
 * untestable without a network call, and open to being talked into a result by
 * a confident-sounding proposal. Scoring is also the one part of a competition
 * a user might reasonably want to audit.
 *
 * Replaces the old `winnerKey()`, which took no arguments and therefore always
 * returned the same agent regardless of what anyone proposed.
 */

export interface ScoredProposal {
  strategy: AgentStrategyKey
  proposal: AgentProposalResult
  /** 0-100, higher is better. */
  score: number
}

/**
 * Weights. Slippage dominates because it is the cost the user actually bears;
 * price is scored relative to the best offer rather than in absolute terms so
 * the scale stays meaningful across intents of very different sizes.
 */
const SLIPPAGE_WEIGHT = 70
const PRICE_WEIGHT = 30

/** Slippage at or above this is worth no points. */
const SLIPPAGE_CEILING_PCT = 1.0

function slippagePoints(slippagePct: number): number {
  const capped = Math.min(Math.max(slippagePct, 0), SLIPPAGE_CEILING_PCT)
  return (1 - capped / SLIPPAGE_CEILING_PCT) * SLIPPAGE_WEIGHT
}

/**
 * Points for fill price, relative to the best and worst on offer.
 *
 * `isBuy` flips the direction: when buying, a lower average price is better;
 * when selling, higher is. Getting this backwards would silently crown the
 * worst proposal, so it is passed explicitly rather than inferred here.
 */
function pricePoints(price: number, best: number, worst: number, isBuy: boolean): number {
  // All agents quoting the same price is a legitimate outcome (a thin market,
  // or a single obvious route). Award everyone the full weight rather than
  // dividing by a zero spread.
  if (best === worst) return PRICE_WEIGHT

  const ratio = isBuy ? (worst - price) / (worst - best) : (price - worst) / (best - worst)
  return Math.min(Math.max(ratio, 0), 1) * PRICE_WEIGHT
}

export function scoreProposals(
  proposals: AgentProposalResult[],
  options: { isBuy: boolean }
): ScoredProposal[] {
  if (proposals.length === 0) return []

  const prices = proposals.map((p) => p.projectedAvgPriceUsd)
  const best = options.isBuy ? Math.min(...prices) : Math.max(...prices)
  const worst = options.isBuy ? Math.max(...prices) : Math.min(...prices)

  return proposals
    .map((proposal) => ({
      strategy: proposal.strategy,
      proposal,
      score: Number(
        (
          slippagePoints(proposal.projectedSlippagePct) +
          pricePoints(proposal.projectedAvgPriceUsd, best, worst, options.isBuy)
        ).toFixed(1)
      ),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      // Ties break on raw slippage, then alphabetically — never on array order,
      // which would make the winner depend on which model call returned first.
      if (a.proposal.projectedSlippagePct !== b.proposal.projectedSlippagePct) {
        return a.proposal.projectedSlippagePct - b.proposal.projectedSlippagePct
      }
      return a.strategy.localeCompare(b.strategy)
    })
}

export function pickWinner(scored: ScoredProposal[]): AgentStrategyKey | null {
  return scored[0]?.strategy ?? null
}

/** Buy-side intents pay the price; sell-side receive it. */
export function isBuyIntent(intentType: string): boolean {
  return !intentType.includes('sell')
}
