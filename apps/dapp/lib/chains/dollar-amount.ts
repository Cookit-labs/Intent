import type { ChainActionRequest } from './types'

/** More places than any display needs, and few enough to fit most tokens. */
const MOST_PLACES = 8
const READ_TIMEOUT_MS = 8_000

/** Tokens for a sum in dollars, rounded down so it never spends more than was said. */
export function unitsForDollars(
  dollars: string,
  priceUsd: number,
  decimals: number
): string | undefined {
  const sum = Number(dollars)
  if (!Number.isFinite(sum) || sum <= 0 || !Number.isFinite(priceUsd) || priceUsd <= 0) {
    return undefined
  }
  const places = Math.min(decimals, MOST_PLACES)
  const scale = 10 ** places
  const units = Math.floor((sum / priceUsd) * scale) / scale
  if (units <= 0) return undefined
  const text = units.toFixed(places)
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text
}

/** The sum as the person said it, the price used, and what that came to. */
export function sizedLine(
  dollars: string,
  symbol: string,
  priceUsd: number,
  units: string
): string {
  const price = priceUsd >= 1 ? priceUsd.toFixed(2) : priceUsd.toPrecision(4)
  return `$${dollars} of ${symbol.toUpperCase()} at $${price} is ${units} ${symbol.toUpperCase()}.`
}

type PriceRead = (url: string) => Promise<{ status: number; json: () => Promise<unknown> }>

const fromServer: PriceRead = (url) => fetch(url, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) })

function noPrice(symbol: string): { refusal: string } {
  return {
    refusal: `I have no live price for ${symbol.toUpperCase()}, so I can't work out a dollar amount of it. Say how much ${symbol.toUpperCase()} instead. Nothing was signed or sent.`,
  }
}

/**
 * A request in dollars as one in tokens, at the chain's own price read now, or why it can't be.
 * This is the only way out of a dollar amount: with no price there is no guess, and no request.
 */
export async function sizeInUnits(
  chain: string,
  request: ChainActionRequest,
  read: PriceRead = fromServer
): Promise<{ request: ChainActionRequest; line?: string } | { refusal: string }> {
  const { amountIsUsd: _dollars, ...inTokens } = request
  if (request.tokenIn.toUpperCase() === 'USDC') return { request: inTokens }
  try {
    const params = new URLSearchParams({ token: request.tokenIn })
    const response = await read(`/api/chain/${encodeURIComponent(chain)}/price?${params}`)
    if (response.status !== 200) return noPrice(request.tokenIn)
    const body = (await response.json()) as { priceUsd?: unknown; decimals?: unknown }
    if (typeof body.priceUsd !== 'number' || typeof body.decimals !== 'number') {
      return noPrice(request.tokenIn)
    }
    const units = unitsForDollars(request.amount, body.priceUsd, body.decimals)
    if (units === undefined) return noPrice(request.tokenIn)
    return {
      request: { ...inTokens, amount: units },
      line: sizedLine(request.amount, request.tokenIn, body.priceUsd, units),
    }
  } catch {
    return noPrice(request.tokenIn)
  }
}
