import type { AgentProposal } from './agent'

export type CompetitionStatus = 'open' | 'closed' | 'cancelled'

export interface Competition {
  id: string
  intentId: string
  startedAt: string
  endsAt: string
  status: CompetitionStatus
  winnerAgentId?: string
  winnerProposalId?: string
  proposals: AgentProposal[]
}