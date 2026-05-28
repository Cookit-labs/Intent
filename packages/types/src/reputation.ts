export type ReputationEventType = 'win' | 'loss' | 'slash' | 'decay'

export interface ReputationScore {
  agentId: string
  score: number
  winRate: number
  totalExecutions: number
  avgSlippage: number
  lastUpdated: string
}

export interface ReputationEvent {
  id: string
  agentId: string
  scoreBefore: number
  scoreAfter: number
  delta: number
  eventType: ReputationEventType
  executionId?: string
  recordedAt: string
}