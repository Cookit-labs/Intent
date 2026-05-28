export type SettlementStatus = 'pending' | 'processing' | 'completed' | 'failed'

export interface Settlement {
  id: string
  executionId: string
  usdcAmount: string
  protocolFee: string
  netAmount: string
  txHash?: string
  status: SettlementStatus
  settledAt?: string
}