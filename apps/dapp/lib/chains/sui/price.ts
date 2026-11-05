import type { ChainToken } from '../types'
import { STABLECOIN_SYMBOLS, SUI_TOKENS } from './tokens'

const PRICE_URL = 'https://coins.llama.fi/prices/current'
const TIMEOUT_MS = 5_000
const PEG_TOLERANCE = 0.005
const MIN_CONFIDENCE = 0.9
/** Stablecoin prices here update less often than SUI's, and matter less per minute. */
const MAX_AGE_STABLE_SECONDS = 3_600
const MAX_AGE_SECONDS = 300

interface LlamaCoin {
  price?: unknown
  timestamp?: unknown
  confidence?: unknown
}

/**
 * Dollars per unit from DefiLlama, keyed by the exact coin type rather than a symbol,
 * or nothing, in which case the trade is refused. Pyth's public Hermes endpoint
 * answered 401 when this was written, so it isn't used.
 */
export async function priceFromLlama(
  token: ChainToken,
  fetcher: typeof fetch = fetch,
  now: number = Date.now()
): Promise<number | undefined> {
  if (!SUI_TOKENS.some((t) => t.id === token.id)) return undefined
  const key = `sui:${token.id}`
  try {
    const response = await fetcher(`${PRICE_URL}/${key}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) return undefined
    const body = (await response.json()) as { coins?: Record<string, LlamaCoin> }
    const coin = body.coins?.[key]
    const price = Number(coin?.price)
    const timestamp = Number(coin?.timestamp)
    const confidence = Number(coin?.confidence)
    if (!Number.isFinite(price) || price <= 0) return undefined
    if (!Number.isFinite(confidence) || confidence < MIN_CONFIDENCE) return undefined

    const stable = STABLECOIN_SYMBOLS.has(token.symbol)
    const maxAge = stable ? MAX_AGE_STABLE_SECONDS : MAX_AGE_SECONDS
    if (!Number.isFinite(timestamp) || now / 1000 - timestamp > maxAge) return undefined

    return stable && Math.abs(price - 1) <= PEG_TOLERANCE ? 1 : price
  } catch {
    return undefined
  }
}
