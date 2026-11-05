import { chainTokenWord } from './parse-action'
import { ChainActionRefused, type PreparedAction } from './types'

const STABLES = ['USDC', 'USDT']

export interface RestingOrder {
  id: string
  venueId: string
  tokenIn: string
  tokenOut: string
  amountIn: string
  remainingIn: string
  receivedOut: string
  collectable?: { amount: string; symbol: string }[]
  limitPrice?: string
  status: 'open' | 'partly' | 'filled' | 'done'
  expiresAt?: number
  note?: string
}

export interface LimitBook {
  openOrders(account: string, signal?: AbortSignal): Promise<RestingOrder[]>
  prepareExit(
    account: string,
    orderId: string,
    action: 'cancel' | 'collect'
  ): Promise<PreparedAction>
}

/** The token traded against a stablecoin, which side is given up, and nothing for any other pair. */
export function limitPair(
  tokenIn: string,
  tokenOut: string
): { base: string; quote: string; selling: boolean } | undefined {
  const given = chainTokenWord(tokenIn).toUpperCase()
  const got = chainTokenWord(tokenOut).toUpperCase()
  const inStable = STABLES.includes(given)
  const outStable = STABLES.includes(got)
  if (inStable === outStable) return undefined
  return inStable
    ? { base: got, quote: given, selling: false }
    : { base: given, quote: got, selling: true }
}

function scaled(text: string, what: string): { digits: bigint; places: number } {
  if (!/^\d+(\.\d+)?$/.test(text.trim())) {
    throw new ChainActionRefused(`"${text}" is not a ${what}. Nothing was signed or sent.`)
  }
  const [whole = '0', fraction = ''] = text.trim().split('.')
  return { digits: BigInt(`${whole}${fraction}`), places: fraction.length }
}

function ceilDiv(top: bigint, bottom: bigint): bigint {
  return (top + bottom - BigInt(1)) / bottom
}

/**
 * What the order must deliver, in the output token's base units, so it never accepts less than the
 * stated price. Exact arithmetic, rounded up.
 */
export function limitOutput(
  amountIn: string,
  price: string,
  selling: boolean,
  _decimalsIn: number,
  decimalsOut: number
): bigint {
  const amount = scaled(amountIn, 'amount')
  const rate = scaled(price, 'price')
  if (rate.digits === BigInt(0)) {
    throw new ChainActionRefused('The price must be more than zero. Nothing was signed or sent.')
  }
  const ten = (n: number): bigint => BigInt(10) ** BigInt(n)
  const amountScale = ten(amount.places)
  const priceScale = ten(rate.places)
  return selling
    ? ceilDiv(amount.digits * rate.digits * ten(decimalsOut), amountScale * priceScale)
    : ceilDiv(amount.digits * priceScale * ten(decimalsOut), amountScale * rate.digits)
}

function shown(market: number): string {
  return String(Number(market.toPrecision(4)))
}

/**
 * Refuses a price that would fill at once at a worse price than the market, or that is so far from
 * it that it is likely a typo.
 */
export function assertRestingPrice(
  price: string,
  marketUsd: number,
  selling: boolean,
  symbol: string
): void {
  const m = shown(marketUsd)
  if (!/^\d+(\.\d+)?$/.test(price.trim()) || !(Number(price) > 0)) {
    throw new ChainActionRefused(
      `"${price}" is not a price. Use a plain figure such as 110 or 110.50. Nothing was signed or sent.`
    )
  }
  const figure = Number(price)
  if (selling && figure < marketUsd) {
    throw new ChainActionRefused(
      `That would sell below today's ${symbol} price of about $${m}, so it would fill at once. Name a price above it. Nothing was signed or sent.`
    )
  }
  if (!selling && figure > marketUsd) {
    throw new ChainActionRefused(
      `That would buy above today's ${symbol} price of about $${m}, so it would fill at once. Name a price below it. Nothing was signed or sent.`
    )
  }
  if (figure > marketUsd * 1.5 || figure < marketUsd * 0.5) {
    throw new ChainActionRefused(
      `$${price} is far from today's ${symbol} price of about $${m}. Check the figure and send it again. Nothing was signed or sent.`
    )
  }
}
