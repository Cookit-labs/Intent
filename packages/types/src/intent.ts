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
  /**
   * The price the user will not trade through, in USD per unit of `tokenOut`.
   *
   * Present only on limit intents. Without it a limit order cannot be told
   * from a market order once created, which is how "buy below $0.19" came to
   * fill at $0.1972 seconds after being placed.
   */
  limitPriceUsd?: number
  status: IntentStatus
  escrowTxHash?: string
  settlementTxHash?: string
  /**
   * The order resting on Stellar's book for this intent.
   *
   * Present once a limit order has actually been placed, and the handle needed
   * to withdraw it. Its absence on a pending limit intent means the order was
   * recorded but never reached the network.
   */
  stellarOfferId?: string
  /**
   * The transaction that placed the resting order.
   *
   * Distinct from `settlementTxHash`, which records a trade. Placing an order
   * is a real, verifiable event that is *not* a fill, and conflating the two
   * would put an unfilled order in history as a completed trade.
   */
  placementTxHash?: string
  createdAt: string
  updatedAt: string
}

export interface CreateIntentInput {
  chain?: ChainSlug
  limitPriceUsd?: number
  type: IntentType
  tokenIn: string
  tokenOut: string
  amountIn: string
  minAmountOut: string
  deadline: string
}
