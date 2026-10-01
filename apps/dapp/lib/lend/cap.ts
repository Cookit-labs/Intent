import { assertTradeWithinCap, type TradeCapOptions } from '../server/trade-cap'
import { fromBaseUnits } from '../swap/assets'
import { BLEND_XLM } from './reserves'

/**
 * The mainnet trade cap for an amount of a Blend reserve.
 *
 * A reserve is named by contract id and the cap prices by symbol. XLM is the
 * one reserve this app can price; any other is passed through by id, finds no
 * price, and is refused on mainnet rather than estimated.
 */
export async function assertReserveWithinCap(
  asset: string,
  baseAmount: string,
  options: TradeCapOptions = {}
): Promise<void> {
  await assertTradeWithinCap(
    asset === BLEND_XLM ? 'XLM' : asset,
    fromBaseUnits(baseAmount),
    options
  )
}
