export type IntentStatus =
  | 'pending'
  | 'competition'
  | 'executing'
  | 'settled'
  | 'failed'
  | 'cancelled'

export type IntentType =
  | 'market_buy'
  | 'market_sell'
  | 'limit_buy'
  | 'limit_sell'
  | 'accumulate'
  | 'hedge'
  | 'rebalance'
  | 'route_liquidity'

export interface Intent {
  id: string
  userId: string
  type: IntentType
  tokenIn: string
  tokenOut: string
  amountIn: string
  minAmountOut: string
  deadline: string
  status: IntentStatus
  escrowTxHash?: string
  settlementTxHash?: string
  createdAt: string
  updatedAt: string
}

export interface CreateIntentInput {
  type: IntentType
  tokenIn: string
  tokenOut: string
  amountIn: string
  minAmountOut: string
  deadline: string
}