import type { rpc } from '@stellar/stellar-sdk'

import {
  isStale,
  readOracleMeta,
  readPriceFor,
  type OracleMeta,
  type OracleOptions,
} from '../lend/oracle'
import type { MarketPrice } from '../swap/price-types'

/**
 * What an asset is worth, according to Reflector.
 *
 * Reflector is Stellar's oracle network. Its CEX/DEX feed aggregates
 * centralised and decentralised venues into one USD price per asset, updated
 * every five minutes, which makes it the right answer to "what is this worth"
 * — the question agents ask when judging a route and the app asks when sizing
 * "$20 of XLM".
 *
 * It is deliberately **not** the answer to two other questions. What a swap
 * will fill at is decided by the testnet pool being traded against, and no
 * oracle can fill a trade. When Blend would liquidate a position is decided
 * by Blend's own oracle, and substituting this one there would produce a
 * confidently wrong liquidation price. See the hierarchy in `swap/prices.ts`.
 *
 * Verified live before this was written: `decimals()` is 14, `resolution()`
 * is 300 seconds, and assets are named `Other("XLM")` — the `Stellar(address)`
 * form returns `null` for the very same asset.
 */

/**
 * Reflector's CEX/DEX feed on testnet. Base currency USD.
 *
 * Confirmed live by reading its contract instance on 2026-09-17. A testnet
 * reset can remove it, and three other officially documented oracle addresses
 * were found already gone that way — so a failure here is an ordinary
 * outcome the callers fall through, not an exception.
 */
export const REFLECTOR_CEX_DEX = 'CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63'

export interface ReflectorOptions {
  oracleId?: string
  rpcUrl?: string
  /** Injected in tests, so the reading is checkable without a network. */
  serverImpl?: Pick<rpc.Server, 'simulateTransaction'>
  /** Injected in tests, so staleness is checkable against a fixed clock. */
  nowSeconds?: number
}

/**
 * A fixed-point price as a JavaScript number, without going through a double
 * on the way.
 *
 * Reflector quotes BTC as 7563593977758267486 at 14 decimals. That integer is
 * above 2^53, so `Number(price) / 1e14` would round the numerator before
 * dividing. Splitting into whole and fractional parts first keeps every
 * digit that a double can then hold.
 */
function toUsd(price: bigint, decimals: number): number {
  const scale = BigInt(10) ** BigInt(decimals)
  const whole = price / scale
  const fraction = price % scale
  return Number(whole) + Number(fraction) / Number(scale)
}

/**
 * Prices for the given tickers, keyed by ticker.
 *
 * Skips rather than guesses. A ticker Reflector does not list (CETES, say)
 * is absent from the result; a price older than two update periods is absent
 * too, because a feed that stopped updating looks exactly like one that did
 * not. The caller decides what absence means — usually "ask the next source".
 *
 * Never throws. A dead oracle, a reset testnet, or an unreachable RPC all
 * produce an empty result, and the price hierarchy has answers below this
 * one.
 */
export async function fetchReflectorPrices(
  symbols: string[],
  options: ReflectorOptions = {}
): Promise<Record<string, MarketPrice>> {
  const oracleId = options.oracleId ?? REFLECTOR_CEX_DEX
  const oracleOptions: OracleOptions = {
    oracleId,
    ...(options.rpcUrl !== undefined ? { rpcUrl: options.rpcUrl } : {}),
    ...(options.serverImpl !== undefined ? { serverImpl: options.serverImpl } : {}),
  }

  let meta: OracleMeta
  try {
    meta = await readOracleMeta(oracleId, oracleOptions)
  } catch {
    return {}
  }

  const found: Record<string, MarketPrice> = {}

  for (const symbol of symbols) {
    const ticker = symbol.toUpperCase()

    let price
    try {
      price = await readPriceFor({ kind: 'other', symbol: ticker }, oracleOptions)
    } catch {
      continue
    }
    if (price === undefined) continue
    if (isStale(price, meta, options.nowSeconds)) continue

    const usd = toUsd(price.price, price.decimals)
    if (!Number.isFinite(usd) || usd <= 0) continue

    found[symbol] = {
      symbol,
      usd,
      source: 'reflector',
      // The oracle's own timestamp, not the wall clock: "as of" means when
      // the price was true, not when this app happened to ask.
      asOf: new Date(price.timestamp * 1000).toISOString(),
    }
  }

  return found
}
