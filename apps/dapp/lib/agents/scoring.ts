import type { AgentProposalResult, AgentStrategyKey } from './brain'

/**
 * Ranking proposals.
 *
 * Plain arithmetic on measured numbers. Two earlier versions of this file each
 * had a structural winner: the first took no arguments and always returned the
 * same agent; the second ranked on the slippage each agent *reported about
 * itself*, so the most confident claim won, and broke ties alphabetically, so
 * four identical proposals always crowned the same one.
 *
 * Now the figure ranked is how far the chosen route's real quote sits from the
 * oracle's fair value — set by the server from the route, never by the agent
 * — and ties break on a hash of the competition id, which no agent can
 * predict or influence and which lands differently from one race to the next.
 */

export interface ScoredProposal {
  strategy: AgentStrategyKey
  proposal: AgentProposalResult
  /** 100 at fair value, higher when the fill beats the oracle, lower when it trails it. */
  score: number
  /** Whether there is anything to sign. Outranks score entirely. */
  executable: boolean
}

/**
 * Score from the measured distance to fair value.
 *
 * Deliberately unbounded above 100. On testnet a route can deliver far more
 * than the oracle says the input is worth, and clamping would tie every such
 * route at the cap — turning the ranking into a draw exactly where the
 * differences are largest.
 */
function scoreOf(proposal: AgentProposalResult): number {
  return Number((100 - proposal.projectedSlippagePct).toFixed(1))
}

/**
 * A stable, unpredictable order for a tie.
 *
 * FNV-1a over the competition id and the agent key: the same competition
 * always resolves the same way (reproducible), different competitions resolve
 * differently (no standing favourite), and nothing an agent puts in its
 * proposal changes the outcome.
 */
export function tieBreak(competitionId: string, strategy: string): number {
  let hash = 0x811c9dc5
  const input = `${competitionId}:${strategy}`
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

export function scoreProposals(
  proposals: AgentProposalResult[],
  options: { competitionId: string }
): ScoredProposal[] {
  if (proposals.length === 0) return []

  return proposals
    .map((proposal) => ({
      strategy: proposal.strategy,
      proposal,
      score: scoreOf(proposal),
      executable: isExecutable(proposal),
    }))
    .sort((a, b) => {
      // Nothing to sign is disqualifying, whatever the numbers say. A losing
      // real route beats a winning opinion.
      if (a.executable !== b.executable) return a.executable ? -1 : 1
      if (b.score !== a.score) return b.score - a.score
      return (
        tieBreak(options.competitionId, a.strategy) - tieBreak(options.competitionId, b.strategy)
      )
    })
}

export function pickWinner(scored: ScoredProposal[]): AgentStrategyKey | null {
  return scored[0]?.strategy ?? null
}

/** A proposal can be executed only if it chose a route. */
function isExecutable(proposal: AgentProposalResult): boolean {
  return proposal.routeId !== undefined && proposal.routeId !== ''
}
