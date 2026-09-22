import { fromBaseUnits } from '../swap/assets'

/**
 * What a route is actually worth, measured rather than claimed.
 *
 * Agents used to report their own `projectedAvgPriceUsd` and
 * `projectedSlippagePct`, and scoring ranked on those. A model that claimed
 * 0.1% slippage beat one that claimed 0.2%, and nothing checked either — so
 * the winner was whichever agent was most confident, which is not a quality.
 *
 * The route an agent picked is a real quote against real liquidity, and the
 * oracle price is a real reference. Together they say exactly what the fill
 * is worth, and that number belongs to nobody's opinion.
 */

export interface MeasuredRoute {
  /** Dollars paid per unit of the asset received. */
  avgPriceUsd: number
  /**
   * How far the fill sits from the oracle's fair value, in percent.
   *
   * Positive means the user gets less than fair value; negative means more.
   * Negative is common on testnet, where synthetic liquidity is often
   * mispriced against the oracle — it is real, and it is shown as such.
   */
  vsOraclePct: number
  /** Value received over value sent, both at oracle prices. Above 1 is better than fair. */
  efficiency: number
}

interface MeasurableQuote {
  sendAmount: string
  destAmount: string
  from: { code: string }
  to: { code: string }
}

/**
 * Undefined when either side cannot be priced: an unpriced asset is not a
 * zero-value one, and treating it as such would make any route through it
 * look free.
 */
export function measureRoute(
  quote: MeasurableQuote,
  prices: Record<string, number>
): MeasuredRoute | undefined {
  const sendQty = Number(fromBaseUnits(quote.sendAmount))
  const receiveQty = Number(fromBaseUnits(quote.destAmount))
  const priceIn = prices[quote.from.code]
  const priceOut = prices[quote.to.code]

  if (
    !Number.isFinite(sendQty) ||
    !Number.isFinite(receiveQty) ||
    sendQty <= 0 ||
    receiveQty <= 0 ||
    priceIn === undefined ||
    priceOut === undefined ||
    priceIn <= 0 ||
    priceOut <= 0
  ) {
    return undefined
  }

  const sendUsd = sendQty * priceIn
  const receiveUsd = receiveQty * priceOut
  const efficiency = receiveUsd / sendUsd

  return {
    avgPriceUsd: sendUsd / receiveQty,
    vsOraclePct: (1 - efficiency) * 100,
    efficiency,
  }
}
