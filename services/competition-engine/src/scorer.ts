import type { AgentProposal, Intent } from '@intent/types'

// Scoring weights
const WEIGHTS = {
  quality: 0.4,
  reputation: 0.35,
  slippage: 0.25,
} as const

export interface ScoredProposal {
  proposalId: string
  totalScore: number
  qualityScore: number
  reputationScore: number
  slippageScore: number
}

export function scoreProposal(
  proposal: AgentProposal,
  _intent: Intent,
  agentReputationScore: number
): ScoredProposal {
  // TODO: implement real scoring
  const qualityScore = 0
  const reputationScore = Math.min(agentReputationScore / 1000, 100)
  const slippageScore = Math.max(0, 100 - proposal.projectedSlippage * 10000)

  const totalScore =
    qualityScore * WEIGHTS.quality +
    reputationScore * WEIGHTS.reputation +
    slippageScore * WEIGHTS.slippage

  return {
    proposalId: proposal.id,
    totalScore,
    qualityScore,
    reputationScore,
    slippageScore,
  }
}