import { STELLAR_USDC, isMainnet, stellarNetwork } from '@intent/config'

import { fetchReflectorPrices } from '../prices/reflector'
import type { MarketPrice } from './price-types'

/**
 * Real market prices, taken from Stellar's own mainnet order book.
 *
 * Pyth would be the obvious choice and is not usable here: since the August
 * 2026 Core upgrade every Hermes and Benchmarks price endpoint returns 401
 * without an API key, and the paid tiers start at $500/mo. The metadata
 * endpoints stay open, which makes it look free until a price is requested.
 *
 * The mainnet order book is a better fit than a third-party API anyway. It
 * needs no key, has no rate limit worth worrying about, and is the same venue a
 * swap would execute against — so the reference price and the execution price
 * come from one source rather than two that can disagree.
 *
 * Prices come from **mainnet** even though execution is on testnet. Testnet
 * liquidity is synthetic and currently values XLM near $1.71 against a real
 * market around $0.19. Agents reasoning about whether a price is good need the
 * real number; the testnet quote is still what gets signed, and the gap is
 * stated in the prompt rather than hidden.
 */

/** Mainnet Horizon. Deliberately not the testnet instance. */
const MAINNET_HORIZON = 'https://horizon.stellar.org'

/** Circle's *mainnet* USDC issuer, which differs from the testnet one. */
const MAINNET_USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

/**
 * THE PRICE HIERARCHY
 *
 * This app holds five XLM prices, and each is right about something. The
 * mistake to avoid is not "using the wrong one" so much as assuming one of
 * them should win everywhere. They answer different questions:
 *
 *   What is this worth?          Reflector → mainnet book → hardcoded fallback
 *     — agent reasoning, sizing "$20 of XLM", the ticker's worth figure.
 *       Reflector aggregates CEX and DEX venues; the mainnet book is one
 *       venue; the fallback is a guess and is labelled as one.
 *
 *   What will this swap fill at? Testnet liquidity — Horizon, Soroswap,
 *     Aquarius, whichever the trade routes through.
 *     — quotes, the minReceive floor, the ticker's "fills near" figure.
 *       Only the pool being traded against determines the fill. An oracle
 *       cannot fill a trade, however accurate it is.
 *
 *   When would Blend liquidate me? Blend's own oracle, read from the pool's
 *     get_config(). See lib/lend/oracle.ts and lib/lend/position.ts.
 *     — health factor, liquidation price. The pool seizes collateral against
 *       ITS feed whatever Reflector says. Substituting a better price there
 *       would make the liquidation figure confidently wrong, which is worse
 *       than the present inconsistency. This module is never consulted for
 *       it, and a test pins that.
 *
 * The gap between testnet's book (~$0.11) and Reflector (~$0.18) is a
 * property of testnet's synthetic liquidity, not staleness. Both are shown
 * where both are relevant, because averaging them would describe no market.
 */

export type { MarketPrice, PriceSource } from './price-types'
export { toPriceTable } from './price-types'

/**
 * Last-resort values, used only when the order book cannot be read.
 *
 * Marked as `fallback` so callers can tell a real quote from a guess rather
 * than silently trusting a hardcoded number — the exact failure that had agents
 * reasoning against a stale $0.58 XLM.
 */
const FALLBACK_USD: Record<string, number> = {
  XLM: 0.19,
  USDC: 1,
}

interface OrderBookResponse {
  bids?: { price: string }[]
  asks?: { price: string }[]
}

/**
 * Mid price of XLM in USDC from the mainnet book.
 *
 * The mid rather than the last trade: a thin book's last trade can sit far from
 * where either side is actually willing to deal.
 */
async function fetchXlmUsd(
  fetchImpl: typeof fetch,
  horizon: string = MAINNET_HORIZON,
  issuer: string = MAINNET_USDC_ISSUER
): Promise<number | undefined> {
  const params = new URLSearchParams({
    selling_asset_type: 'native',
    buying_asset_type: 'credit_alphanum4',
    buying_asset_code: 'USDC',
    buying_asset_issuer: issuer,
    limit: '1',
  })

  const res = await fetchImpl(`${horizon}/order_book?${params.toString()}`, {
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) return undefined

  const book = (await res.json()) as OrderBookResponse
  const bid = Number.parseFloat(book.bids?.[0]?.price ?? '')
  const ask = Number.parseFloat(book.asks?.[0]?.price ?? '')

  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return undefined
  if (bid <= 0 || ask <= 0) return undefined

  return (bid + ask) / 2
}

export interface PriceOptions {
  fetchImpl?: typeof fetch
  /** Set false to skip the oracle, so the book-only path stays testable. */
  reflector?: boolean
  reflectorOptions?: Parameters<typeof fetchReflectorPrices>[1]
}

/**
 * Current USD prices for the assets the app can swap.
 *
 * Never throws: a competition should still run when pricing is unavailable, so
 * a failed lookup degrades to the fallback table and says so.
 */
export async function fetchMarketPrices(
  options: PriceOptions = {}
): Promise<Record<string, MarketPrice>> {
  const fetchImpl = options.fetchImpl ?? fetch
  const asOf = new Date().toISOString()

  // Reflector first: an oracle aggregating many venues is a better answer to
  // "what is this worth" than any single order book. It is asked and then
  // fallen through, never awaited on pain of failure — a reset testnet or an
  // unreachable RPC leaves the answer to the sources below, exactly as before
  // this source existed.
  const reflector =
    options.reflector === false ? {} : await fetchReflectorPrices(['XLM'], options.reflectorOptions)
  const fromReflector = reflector['XLM']

  let xlm: number | undefined
  if (fromReflector === undefined) {
    try {
      xlm = await fetchXlmUsd(fetchImpl)
    } catch {
      xlm = undefined
    }
  }

  return {
    XLM: fromReflector ?? {
      symbol: 'XLM',
      usd: xlm ?? (FALLBACK_USD['XLM'] as number),
      source: xlm !== undefined ? 'stellar-mainnet' : 'fallback',
      asOf,
    },
    // USDC is the quote asset and is a dollar by construction. Pricing it
    // against itself would add a lookup that can only introduce error.
    [STELLAR_USDC.code]: {
      symbol: STELLAR_USDC.code,
      usd: 1,
      source: 'stellar-mainnet',
      asOf,
    },
  }
}

/**
 * What XLM trades for **on testnet**, from testnet's own order book.
 *
 * A different number from the mainnet one and deliberately so. Testnet
 * liquidity is synthetic, so this says what a swap signed here will actually
 * fill near — which is the rate that describes this app's own trades, whatever
 * the real market is doing elsewhere.
 *
 * Kept apart from `fetchMarketPrices` rather than replacing it: agents reason
 * about whether a price is *good*, which needs the real market, while someone
 * watching their own fills needs the venue they are filling on. Both are true
 * at once and neither substitutes for the other.
 *
 * Returns undefined when the book cannot be read or has no offers — a common
 * state on testnet, where a pair can genuinely have an empty book. Undefined
 * rather than a fallback constant: inventing a testnet price would defeat the
 * point of asking testnet.
 */
export async function fetchTestnetXlmUsd(
  options: PriceOptions = {}
): Promise<MarketPrice | undefined> {
  const fetchImpl = options.fetchImpl ?? fetch

  let usd: number | undefined
  try {
    usd = await fetchXlmUsd(fetchImpl, stellarNetwork.horizonUrl, STELLAR_USDC.issuer)
  } catch {
    usd = undefined
  }

  if (usd === undefined) return undefined

  return {
    symbol: 'XLM',
    usd,
    // The book this deployment fills on. On mainnet that is the same venue
    // `fetchMarketPrices` reads, and it is labelled as such.
    source: isMainnet() ? 'stellar-mainnet' : 'stellar-testnet',
    asOf: new Date().toISOString(),
  }
}
