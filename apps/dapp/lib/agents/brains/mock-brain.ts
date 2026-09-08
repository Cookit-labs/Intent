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
 */
export function buildMockProposal(req: ProposalRequest): AgentProposalResult {
  const strategy = STRATEGIES[req.strategy]
  const base = req.intent.targetPriceUsd || req.intent.referencePriceUsd || 3200
  const venueIds = req.market.venues.slice(0, 2).map((v) => v.id)

  return {
    strategy: req.strategy,
    reasoning: strategy.mockReasoning,
    projectedAvgPriceUsd: base * strategy.mockPriceRatio,
    projectedSlippagePct: strategy.mockSlippagePct,
    venues: req.strategy === 'arbitrage' ? venueIds : venueIds.slice(0, 1),
    sliceCount: req.strategy === 'twap' ? 6 : 1,
    confidence: 0.7,
    horizonMinutes: req.strategy === 'twap' ? 30 : 5,
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
