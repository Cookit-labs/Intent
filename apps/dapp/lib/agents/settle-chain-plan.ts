import type { AgentProposalResult } from './brain'
import type { ChainRouteQuote } from './chain-routes'
import { measureChainRoute } from './measure'

/**
 * A plan on a chain other than Stellar is one fill and nothing after it.
 *
 * Resting, splitting and a follow-on lend or offramp have no way to execute
 * there, and the prompt does not offer them. A model that picks one anyway
 * keeps its route and its reasoning; only the shape of the plan is corrected,
 * so scoring never rewards or punishes a choice that could not happen.
 */
export function settleChainPlan(proposal: AgentProposalResult): AgentProposalResult {
  const {
    restPriceUsd: _rest,
    splitPct: _split,
    thenAction: _then,
    thenVenue: _venue,
    ...rest
  } = proposal
  return { ...rest, executionMode: 'fill', sliceCount: 1 }
}

/**
 * A swap the server could not price. Its value is unknown, not zero loss, so
 * scoring must not let it beat a route that was measured.
 */
export function isUnmeasuredSwap(q: ChainRouteQuote): boolean {
  return q.request.kind === 'swap' && measureChainRoute(q) === undefined
}

/**
 * Replaces what the agent claimed about its route with what the quote says.
 *
 * The panel shows `projectedAvgPriceUsd` with a dollar sign, so it holds
 * dollars: paid per unit received for a swap, the price of the token paid in
 * for a deposit or a stake. A swap that could not be priced shows zero for
 * both figures rather than the agent's guess; scoring penalises it separately.
 */
export function applyChainMeasure(
  proposal: AgentProposalResult,
  q: ChainRouteQuote
): AgentProposalResult {
  const m = measureChainRoute(q)
  if (m === undefined) {
    return q.request.kind === 'swap'
      ? { ...proposal, projectedAvgPriceUsd: 0, projectedSlippagePct: 0 }
      : proposal
  }
  const unit = Number(q.request.kind === 'swap' ? q.receive?.amount : q.pay.amount)
  const avg = unit > 0 && q.valueInUsd !== undefined ? q.valueInUsd / unit : 0
  return {
    ...proposal,
    projectedAvgPriceUsd: Number(avg.toFixed(6)),
    projectedSlippagePct: Number(m.vsInPct.toFixed(2)),
  }
}
