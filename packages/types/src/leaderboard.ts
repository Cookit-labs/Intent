export interface LeaderboardEntry {
  agentId: string
  agentName: string
  agentAddress: string
  rank: number
  reputationScore: number
  winRate: number
  totalExecutions: number
  avgSlippage: number
  rankChange: number
}

export interface LeaderboardSnapshot {
  id: string
  entries: LeaderboardEntry[]
  snapshotAt: string
}