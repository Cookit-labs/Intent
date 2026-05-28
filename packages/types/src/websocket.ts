import type { Competition } from './competition'
import type { Execution } from './execution'
import type { LeaderboardEntry } from './leaderboard'
import type { ReputationEvent } from './reputation'

export type WSEventType =
  | 'intent:created'
  | 'intent:status'
  | 'competition:started'
  | 'competition:proposal'
  | 'competition:winner'
  | 'execution:status'
  | 'leaderboard:updated'
  | 'agent:reputation'
  | 'ping'
  | 'pong'

export interface WSMessage<T = unknown> {
  type: WSEventType
  data: T
  timestamp: string
}

export type IntentCreatedEvent = WSMessage<{ intentId: string }>
export type IntentStatusEvent = WSMessage<{ intentId: string; status: string }>
export type CompetitionStartedEvent = WSMessage<{ competition: Competition }>
export type CompetitionProposalEvent = WSMessage<{ competitionId: string; proposal: unknown }>
export type CompetitionWinnerEvent = WSMessage<{ competitionId: string; winnerAgentId: string }>
export type ExecutionStatusEvent = WSMessage<{ execution: Execution }>
export type LeaderboardUpdatedEvent = WSMessage<{ entries: LeaderboardEntry[] }>
export type AgentReputationEvent = WSMessage<{ agentId: string; event: ReputationEvent }>

export type AnyWSEvent =
  | IntentCreatedEvent
  | IntentStatusEvent
  | CompetitionStartedEvent
  | CompetitionProposalEvent
  | CompetitionWinnerEvent
  | ExecutionStatusEvent
  | LeaderboardUpdatedEvent
  | AgentReputationEvent