import { isValidSuiAddress } from '@mysten/sui/utils'

import { ChainActionRefused, type ChainToken } from '../types'

export const MAX_PRICE_IMPACT = 0.03
export const MAX_VALUE_LOSS = 0.05
export const SLIPPAGE_BPS = 50
export const MAX_SLIPPAGE_BPS = 100

const MAX_OVERLAY_BPS = 100

export interface CetusOverlay {
  receiver: string
  bps: number
}

/**
 * The fee Intent takes on a swap. Both settings are required, so that no rate is
 * ever assumed on someone's behalf, and a malformed one means no fee at all.
 */
export function cetusOverlay(
  env: Record<string, string | undefined> = process.env
): CetusOverlay | undefined {
  const receiver = env['CETUS_OVERLAY_FEE_RECEIVER']?.trim()
  const bps = Number(env['CETUS_OVERLAY_FEE_BPS']?.trim())
  if (receiver === undefined || !isValidSuiAddress(receiver)) return undefined
  if (!Number.isInteger(bps) || bps <= 0 || bps > MAX_OVERLAY_BPS) return undefined
  return { receiver, bps }
}

export interface RouteToJudge {
  requestedIn: string
  amountIn: string
  amountOut: string
  deviationRatio: string | number | undefined
  tokenIn: ChainToken
  tokenOut: ChainToken
  priceIn: number | undefined
  priceOut: number | undefined
}

function dollars(value: number): string {
  return `$${value.toFixed(2)}`
}

/**
 * Whether a route is fit to show anyone. The router's own numbers aren't trusted to
 * flag a thin token: FDUSD on Sui reported $43M of supply while a $100K route paid
 * back $28.5K. So the output is also valued independently against the input.
 */
export function judgeRoute(route: RouteToJudge): void {
  const { tokenIn, tokenOut, priceIn, priceOut } = route
  if (route.amountIn !== route.requestedIn) {
    throw new ChainActionRefused(
      'The route found only covers part of that amount, so I stopped here. Try a smaller amount.'
    )
  }
  if (!/^\d+$/.test(route.amountOut) || BigInt(route.amountOut) === BigInt(0)) {
    throw new ChainActionRefused(
      `I couldn't find a route from ${tokenIn.symbol} to ${tokenOut.symbol} right now. Try again shortly.`
    )
  }

  const impact = route.deviationRatio === undefined ? Number.NaN : Number(route.deviationRatio)
  if (!Number.isFinite(impact)) {
    throw new ChainActionRefused(
      "I couldn't read the price impact of this route, so I won't offer it. Try again shortly."
    )
  }
  if (Math.abs(impact) > MAX_PRICE_IMPACT) {
    throw new ChainActionRefused(
      `This swap would move the price by ${(Math.abs(impact) * 100).toFixed(2)}%, over the ${MAX_PRICE_IMPACT * 100}% I allow. Try a smaller amount.`
    )
  }

  if (priceIn === undefined || priceOut === undefined) {
    const missing = priceIn === undefined ? tokenIn.symbol : tokenOut.symbol
    throw new ChainActionRefused(
      `I can't get a live price for ${missing} right now, so I can't check this swap is fair. Try again shortly.`
    )
  }
  const valueIn = (Number(route.amountIn) / 10 ** tokenIn.decimals) * priceIn
  const valueOut = (Number(route.amountOut) / 10 ** tokenOut.decimals) * priceOut
  if (valueOut < valueIn * (1 - MAX_VALUE_LOSS)) {
    throw new ChainActionRefused(
      `This swap would return about ${dollars(valueOut)} for your ${dollars(valueIn)}, more than ${MAX_VALUE_LOSS * 100}% worse than the market price. There isn't enough liquidity, so try a smaller amount or a different token.`
    )
  }
}
