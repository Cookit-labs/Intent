import { STELLAR_USDC } from '@intent/config'

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

export interface MarketPrice {
  symbol: string
  usd: number
  /** Where the figure came from, so a stale or missing price is attributable. */
  source: 'stellar-mainnet' | 'fallback'
  asOf: string
}

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
async function fetchXlmUsd(fetchImpl: typeof fetch): Promise<number | undefined> {
  const params = new URLSearchParams({
    selling_asset_type: 'native',
    buying_asset_type: 'credit_alphanum4',
    buying_asset_code: 'USDC',
    buying_asset_issuer: MAINNET_USDC_ISSUER,
    limit: '1',
  })

  const res = await fetchImpl(`${MAINNET_HORIZON}/order_book?${params.toString()}`, {
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

  let xlm: number | undefined
  try {
    xlm = await fetchXlmUsd(fetchImpl)
  } catch {
    xlm = undefined
  }

  return {
    XLM: {
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

/** Flattens to the `symbol -> usd` shape `MarketContext.prices` expects. */
export function toPriceTable(prices: Record<string, MarketPrice>): Record<string, number> {
  return Object.fromEntries(Object.entries(prices).map(([sym, p]) => [sym, p.usd]))
}
