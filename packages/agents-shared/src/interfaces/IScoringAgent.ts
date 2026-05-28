import type { AgentProposal, Intent } from '@intent/types'

export interface IScoringAgent {
  score(proposal: AgentProposal, intent: Intent): Promise<ScoredProposal>
  rankProposals(proposals: AgentProposal[], intent: Intent): Promise<ScoredProposal[]>
}

export interface ScoredProposal {
  proposalId: string
  qualityScore: number
  reputationScore: number
  slippageScore: number
  totalScore: number
  reasoning: string
}