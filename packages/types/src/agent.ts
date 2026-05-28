export type AgentStrategyType = 'twap' | 'momentum' | 'shadow' | 'arbitrage' | 'custom'

export type AgentCapability =
  | 'market_execution'
  | 'limit_execution'
  | 'twap_execution'
  | 'liquidity_routing'
  | 'hedging'

export interface Agent {
  id: string
  address: string
  name: string
  strategyType: AgentStrategyType
  capabilities: AgentCapability[]
  isActive: boolean
  registeredAt: string
  registryTxHash?: string
}

export interface AgentProposal {
  id: string
  competitionId: string
  agentId: string
  projectedAmountOut: string
  projectedSlippage: number
  qualityScore: number
  totalScore: number
  submittedAt: string
}

export interface AgentStats {
  agentId: string
  totalExecutions: number
  winRate: number
  avgSlippage: number
  reputationScore: number
  rank: number
}