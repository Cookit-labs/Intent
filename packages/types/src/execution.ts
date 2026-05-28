export type ExecutionStatus =
  | 'pending'
  | 'submitted'
  | 'confirmed'
  | 'failed'
  | 'settled'

export interface Execution {
  id: string
  competitionId: string
  agentId: string
  intentId: string
  status: ExecutionStatus
  actualAmountOut?: string
  actualSlippage?: number
  txHash?: string
  executedAt?: string
  settledAt?: string
}

export interface ExecutionResult {
  executionId: string
  success: boolean
  actualAmountOut: string
  actualSlippage: number
  txHash: string
  gasUsed: string
}