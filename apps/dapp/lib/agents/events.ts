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
  agents: { key: AgentStrategyKey; name: string; tag: string; gradient: string }[]
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
  /** True when the offline fallback produced this rather than a live agent. */
  degraded: boolean
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
   * The route the winning agent chose, when it chose one.
   *
   * Carried on the winner frame rather than fetched again by the client: the
   * quote the agents actually compared is the one that should be offered for
   * signing, and re-quoting here would show the user a different number than
   * the competition was decided on.
   */
  route?: unknown
}

export interface CompetitionErrorFrame {
  type: 'competition:error'
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
