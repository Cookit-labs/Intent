import type {
  AgentBrain,
  AgentProposalResult,
  BrainMeta,
  ProposalOutcome,
  ProposalRequest,
} from '../brain'
import { STRATEGIES } from '../strategies'

/**
 * The offline agent: today's scripted table behind the real interface.
 *
 * This is not a test double. It is the production fallback for every case where
 * the model cannot answer — no key configured, upstream down, a single agent
 * timing out — because a competition that renders three real proposals and one
 * simulated one is better than one that renders an error. It also means the
 * whole flow (route, streaming, panel) can be built and exercised before any
 * network code exists.
 */

function meta(latencyMs: number): BrainMeta {
  return {
    provider: 'mock',
    model: 'mock',
    latencyMs,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    costUsd: 0,
    degraded: true,
  }
}

/**
 * Ratios are anchored to $3,200 so the numbers land on the original reference
 * mock at that target and scale proportionally everywhere else.
 *
 * What the plan *is* varies with the intent rather than with which agent is
 * asking. The old version branched on strategy identity — twap always got six
 * slices, arbitrage always got two venues — which is the offline mirror of the
 * lanes the live prompts used to impose. Offline proposals that always differ
 * the same way are the clearest possible demonstration of agents that cannot
 * actually think, so they now respond to the order in front of them.
 */
export function buildMockProposal(req: ProposalRequest): AgentProposalResult {
  const strategy = STRATEGIES[req.strategy]
  const base = req.intent.targetPriceUsd || req.intent.referencePriceUsd || 3200
  const venueIds = req.market.venues.slice(0, 2).map((v) => v.id)

  // A stated limit price is a reason to wait; without one there is nothing to
  // wait for. This is the same judgement the live agents now make, reached
  // deterministically so the offline path stays reproducible.
  const wants = req.intent.limitPriceUsd
  const resting = wants !== undefined

  return {
    strategy: req.strategy,
    // Marked at the source. Anything downstream that treats this as a real
    // proposal — scoring especially — would be ranking invented numbers
    // against measured ones.
    degraded: true,
    reasoning: strategy.mockReasoning,
    projectedAvgPriceUsd: base * strategy.mockPriceRatio,
    projectedSlippagePct: strategy.mockSlippagePct,
    venues: venueIds.length > 1 ? venueIds : venueIds.slice(0, 1),
    sliceCount: 1,
    confidence: 0.7,
    horizonMinutes: resting ? 60 : 5,
    executionMode: resting ? 'rest' : 'fill',
    ...(resting ? { restPriceUsd: wants } : {}),
  }
}

export const mockBrain: AgentBrain = {
  id: 'mock',
  displayName: 'Simulated agents',
  isConfigured: () => true,
  propose(req: ProposalRequest): Promise<ProposalOutcome> {
    return Promise.resolve({
      ok: true,
      proposal: buildMockProposal(req),
      meta: meta(0),
    })
  },
}
