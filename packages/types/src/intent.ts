import type { ChainSlug } from './chain'

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
  /**
   * Which chain this intent belongs to.
   *
   * Optional because intents recorded before chains were distinguished carry
   * no slug, and dropping them from history would be worse than showing them.
   * Everything created from here on sets it.
   */
  chain?: ChainSlug
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
  chain?: ChainSlug
  type: IntentType
  tokenIn: string
  tokenOut: string
  amountIn: string
  minAmountOut: string
  deadline: string
}
