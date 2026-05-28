import { z } from 'zod'

export const createIntentSchema = z.object({
  type: z.enum(['market_buy', 'market_sell', 'limit_buy', 'limit_sell', 'accumulate', 'hedge', 'rebalance', 'route_liquidity']),
  tokenIn: z.string().min(1, 'Token in is required'),
  tokenOut: z.string().min(1, 'Token out is required'),
  amountIn: z.string().regex(/^\d+(\.\d+)?$/, 'Must be a valid number'),
  minAmountOut: z.string().regex(/^\d+(\.\d+)?$/, 'Must be a valid number'),
  deadline: z.string().datetime('Must be a valid ISO datetime'),
})

export type CreateIntentInput = z.infer<typeof createIntentSchema>