import type { AgentProposalResult, AgentStrategyKey, BrainErrorCode } from './brain'

/**
 * The wire format between the competition route and the client.
 *
 * Event names deliberately match the `competition:*` members of `WSEventType`
 * in `@intent/types`. The documented architecture has these arriving over a
 * WebSocket hub fed by the Go backend; they arrive over SSE from a Next route
 * today because that backend does not exist yet. Keeping the payloads identical
 * means the eventual move is a change of transport inside the hook, not a
 * reshaping of everything downstream.
 */

export interface CompetitionStartedFrame {
  type: 'competition:started'
  competitionId: string
  /**
   * Identity only. What each agent proposes is not known until it answers.
   *
   * `model` names the service behind that agent, sent with the opening frame
   * so it is on the card while it is still thinking. Optional because a client
   * built against the single-provider frames must keep working.
   */
  agents: { key: AgentStrategyKey; name: string; gradient: string; model?: string }[]
  windowSeconds: number
}

export interface CompetitionProposalFrame {
  type: 'competition:proposal'
  competitionId: string
  proposal: AgentProposalResult
  /**
   * The executable route this agent chose, when it chose one.
   *
   * Carried per proposal, not only on the winner. The user picks who executes,
   * so every agent's route has to reach the client — resolving only the
   * winner's meant clicking any other agent signed the winner's trade.
   */
  route?: unknown
}

export interface CompetitionFailedFrame {
  type: 'competition:failed'
  competitionId: string
  strategy: AgentStrategyKey
  error: BrainErrorCode
}

export interface CompetitionWinnerFrame {
  type: 'competition:winner'
  competitionId: string
  winner: AgentStrategyKey
  scores: Record<string, number>
  /**
   * True when every executable proposal chose the same route and the same
   * plan, so the winner was drawn rather than judged.
   *
   * Said explicitly because a draw dressed as a recommendation is the thing
   * that looks rigged: the same name crowned twice running, for no reason
   * anyone can see. On testnet the best route is often better by a wide
   * margin, so four agents agreeing is the common case and the right answer
   * — and the panel should say "they agree", not "this one wins".
   */
  unanimous: boolean
  /**
   * The route the winning agent chose, when it chose one.
   *
   * Carried on the winner frame rather than fetched again by the client: the
   * quote the agents actually compared is the one that should be offered for
   * signing, and re-quoting here would show the user a different number than
   * the competition was decided on.
   */
  route?: unknown
}

/**
 * The competition could not run, or produced nothing.
 *
 * Distinct from `competition:failed`, which is one agent not answering while
 * the others may. This ends the race: no agents were live, the chain has no
 * execution, or every agent failed. Said plainly rather than filled in with
 * placeholders — a canned proposal here once read as a strategy somebody had
 * chosen, venues from another chain and all.
 */
export interface CompetitionErrorFrame {
  type: 'competition:error'
  code: 'agents_offline' | 'chain_unsupported' | 'no_agent_answered'
  message: string
}

export type CompetitionFrame =
  | CompetitionStartedFrame
  | CompetitionProposalFrame
  | CompetitionFailedFrame
  | CompetitionWinnerFrame
  | CompetitionErrorFrame

/** Serialises one frame as an SSE `data:` line. */
export function encodeFrame(frame: CompetitionFrame): string {
  return `data: ${JSON.stringify(frame)}\n\n`
}

/** Returns undefined rather than throwing: a malformed frame should not kill the stream. */
export function decodeFrame(raw: string): CompetitionFrame | undefined {
  try {
    const parsed = JSON.parse(raw) as CompetitionFrame
    return typeof parsed.type === 'string' ? parsed : undefined
  } catch {
    return undefined
  }
}
