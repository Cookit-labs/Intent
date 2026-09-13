import type { ClassicAsset } from './assets'
import { STROOP_DECIMALS } from './assets'

/**
 * Turning a USD limit price into a price the ledger understands.
 *
 * Two things make this more than a unit conversion.
 *
 * The first is that the app reads USD prices from **mainnet**, because testnet
 * liquidity is synthetic, while it executes on **testnet**, where the same
 * asset trades somewhere else entirely. Measured while this was written:
 * mainnet XLM near $0.19, the testnet book near 0.11 USDC/XLM. A target taken
 * from one world and placed in the other is not the order the user asked for.
 *
 * The second is that a Stellar offer is priced as a **ratio between two
 * assets, fixed at placement** — not a USD figure that tracks. For a
 * USDC-quoted pair the difference is small, since USDC is a dollar by
 * construction, but it is real and it is not hidden here.
 *
 * So this module is the one place the two price worlds meet, and it refuses
 * rather than guesses: an offer that would cross the spread is rejected before
 * it can be placed, because an order that fills the instant it is submitted is
 * a market order wearing a limit order's label.
 */

/** Best bid and ask from the venue the offer will actually rest on. */
export interface OrderBookTop {
  /** Highest price a buyer is bidding, in counter units per base unit. */
  bid: number | undefined
  /** Lowest price a seller is asking. */
  ask: number | undefined
}

/**
 * A price as Stellar stores it: an exact rational.
 *
 * The ledger takes a numerator and denominator rather than a decimal, which is
 * a feature — the price recorded is the price meant, with no float rounding
 * between the two.
 */
export interface PriceFraction {
  n: number
  d: number
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b)
}

/**
 * Exact fraction for a decimal price, in lowest terms.
 *
 * Goes through the digits rather than the double: `0.1 + 0.2` is famously not
 * `0.3`, and this number is money. Capped at the ledger's seven decimal places,
 * because anything finer cannot be represented and silently rounding it would
 * place an order at a price nobody chose.
 */
export function toPriceFraction(price: string): PriceFraction {
  const trimmed = price.trim()
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`price "${price}" is not a positive decimal`)
  }

  const [whole = '0', fraction = ''] = trimmed.split('.')
  if (fraction.length > STROOP_DECIMALS) {
    throw new Error(`price "${price}" has more than ${STROOP_DECIMALS} decimal places`)
  }

  const scale = 10 ** fraction.length
  const numerator = Number(whole) * scale + (fraction === '' ? 0 : Number(fraction))
  if (numerator <= 0) throw new Error(`price "${price}" is not a positive decimal`)

  const divisor = gcd(numerator, scale)
  return { n: numerator / divisor, d: scale / divisor }
}

export interface CrossCheck {
  /** The asset being given up. Which side of the book matters depends on it. */
  selling: ClassicAsset
  /** Offer price in USDC per XLM, the orientation the book is quoted in. */
  price: number
  book: OrderBookTop
}

/**
 * Whether an offer at this price would fill the moment it was submitted.
 *
 * Direction is the whole subtlety and is easy to invert. Selling the base asset
 * means meeting buyers, so anything at or below the **bid** trades at once.
 * Selling the counter asset is buying the base, so anything at or above the
 * **ask** trades at once.
 *
 * Touching counts as crossing: equal prices match on Stellar, and reporting
 * that as resting would promise a wait that never happens.
 */
export function wouldCrossSpread({ selling, price, book }: CrossCheck): boolean {
  const sellingBase = selling.issuer === undefined

  if (sellingBase) {
    return book.bid !== undefined && price <= book.bid
  }
  return book.ask !== undefined && price >= book.ask
}

export interface OfferPriceRequest {
  /** What the user actually typed, in USD per unit of the asset being bought. */
  limitPriceUsd: number
  selling: ClassicAsset
  buying: ClassicAsset
  book: OrderBookTop
}

export type OfferPriceResult =
  | {
      ok: true
      /** The exact ratio to place. */
      price: PriceFraction
      /** Decimal form, for display. */
      priceDecimal: number
      /**
       * What the venue is quoting right now, so the UI can show the gap
       * between the user's target and the market rather than hiding it.
       */
      marketPriceUsd: number
    }
  | {
      ok: false
      reason: 'would_fill_now' | 'no_market' | 'invalid_price'
      detail?: string
      /** Present when a market price was readable but the target was refused. */
      marketPriceUsd?: number
    }

/**
 * The price to place, or a reason not to place one.
 *
 * Refusing is a real outcome rather than an error path: "this would fill
 * immediately" is useful information about the user's target, and the UI can
 * offer a market swap instead of quietly performing one.
 */
export function offerPriceFromUsd(req: OfferPriceRequest): OfferPriceResult {
  const { limitPriceUsd, selling, book } = req

  if (!Number.isFinite(limitPriceUsd) || limitPriceUsd <= 0) {
    return { ok: false, reason: 'invalid_price', detail: 'A limit price must be above zero.' }
  }

  // Which side of the book this order will have to beat.
  const sellingBase = selling.issuer === undefined
  const reference = sellingBase ? book.bid : book.ask

  if (reference === undefined) {
    // Nothing is quoted, so there is no way to tell a resting price from a
    // crossing one. Placing blind could rest anywhere.
    return {
      ok: false,
      reason: 'no_market',
      detail: 'No counterparty is quoting this pair, so a limit price cannot be checked.',
    }
  }

  if (wouldCrossSpread({ selling, price: limitPriceUsd, book })) {
    return {
      ok: false,
      reason: 'would_fill_now',
      detail: sellingBase
        ? `Buyers are already bidding ${reference}, so an offer at ${limitPriceUsd} would sell immediately.`
        : `Sellers are already asking ${reference}, so an offer at ${limitPriceUsd} would buy immediately.`,
      marketPriceUsd: reference,
    }
  }

  let price: PriceFraction
  try {
    price = toPriceFraction(String(limitPriceUsd))
  } catch (e) {
    return {
      ok: false,
      reason: 'invalid_price',
      ...(e instanceof Error ? { detail: e.message } : {}),
      marketPriceUsd: reference,
    }
  }

  return { ok: true, price, priceDecimal: limitPriceUsd, marketPriceUsd: reference }
}

/**
 * The top of the book for a pair, from the venue the offer will rest on.
 *
 * Testnet, deliberately, unlike `prices.ts` which reads mainnet for USD. An
 * offer competes against the orders actually sitting on this network, and
 * checking it against a different market's prices is what would let a "limit"
 * order cross on contact.
 */
export async function fetchOrderBookTop(
  base: ClassicAsset,
  counter: ClassicAsset,
  options: { horizonUrl?: string; fetchImpl?: typeof fetch } = {}
): Promise<OrderBookTop> {
  const { stellarTestnet } = await import('@intent/config')
  const { toHorizonParams } = await import('./assets')

  const horizonUrl = options.horizonUrl ?? stellarTestnet.horizonUrl
  const doFetch = options.fetchImpl ?? fetch

  const params = new URLSearchParams({
    ...toHorizonParams(base, 'selling'),
    ...toHorizonParams(counter, 'buying'),
    limit: '1',
  })

  const res = await doFetch(`${horizonUrl}/order_book?${params.toString()}`, {
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`Horizon ${res.status}`)

  const book = (await res.json()) as {
    bids?: { price: string }[]
    asks?: { price: string }[]
  }

  const bid = Number.parseFloat(book.bids?.[0]?.price ?? '')
  const ask = Number.parseFloat(book.asks?.[0]?.price ?? '')

  return {
    bid: Number.isFinite(bid) && bid > 0 ? bid : undefined,
    ask: Number.isFinite(ask) && ask > 0 ? ask : undefined,
  }
}
