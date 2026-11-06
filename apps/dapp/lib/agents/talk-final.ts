import type { AgentProposalResult, BrainMeta, ProposalRequest } from './brain'
import { toOutcome } from './brains/openai-compatible'
import type { FinalChoice } from './talk-prompts'

const UNBILLED: BrainMeta = {
  provider: 'groq',
  model: '',
  latencyMs: 0,
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  costUsd: 0,
}

/**
 * What an agent's final choice comes to, or nothing if it doesn't hold up, in
 * which case its first take stands.
 *
 * A change is rebuilt from the agent's own first take as the model wrote it,
 * and goes through the checks a first take goes through: the route must have
 * been offered, the plan must make sense for this chain, and the figures come
 * from the route rather than from anything the agent says.
 */
export function applyFinalChoice(args: {
  first: AgentProposalResult
  rawFirst: AgentProposalResult
  choice: FinalChoice
  request: ProposalRequest
  settle: (proposal: AgentProposalResult) => AgentProposalResult
}): AgentProposalResult | undefined {
  const { first, rawFirst, choice, request, settle } = args

  if (choice.decision === 'keep') return { ...first, reasoning: choice.reasoning }

  if (choice.decision === 'hold') {
    const {
      routeId: _route,
      restPriceUsd: _rest,
      splitPct: _split,
      thenAction: _then,
      thenVenue: _venue,
      ...rest
    } = first
    return {
      ...rest,
      reasoning: choice.reasoning,
      projectedAvgPriceUsd: 0,
      projectedSlippagePct: 0,
      venues: [],
      held: true,
    }
  }

  const source = (request.market.routes ?? []).find((r) => r.id === choice.routeId)?.source
  const outcome = toOutcome(
    request,
    {
      routeId: choice.routeId,
      reasoning: choice.reasoning,
      projectedAvgPriceUsd: rawFirst.projectedAvgPriceUsd,
      projectedSlippagePct: rawFirst.projectedSlippagePct,
      venues: source !== undefined ? [source] : rawFirst.venues,
      sliceCount: rawFirst.sliceCount,
      confidence: rawFirst.confidence,
      horizonMinutes: rawFirst.horizonMinutes,
      executionMode: choice.executionMode,
      restPriceUsd: choice.restPriceUsd,
      splitPct: choice.splitPct,
      thenAction: rawFirst.thenAction ?? 'none',
      thenVenue: rawFirst.thenVenue ?? '',
    },
    UNBILLED
  )
  return outcome.ok ? settle(outcome.proposal) : undefined
}
