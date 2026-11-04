import type { AgentProposalResult } from './brain'

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
