import { CHAIN_DESCRIPTORS } from '@intent/config'
import type { ChainSlug } from '@intent/types'

const PRICE_URL = 'https://coins.llama.fi/prices/current'
const TIMEOUT_MS = 5_000
const MIN_CONFIDENCE = 0.9
const MAX_AGE_SECONDS = 300

/** DefiLlama's id for each chain's own coin. */
const COIN_IDS: Record<ChainSlug, string> = {
  arc: 'usd-coin',
  stellar: 'stellar',
  solana: 'solana',
  avalanche: 'avalanche-2',
  sui: 'sui',
  monad: 'monad',
  near: 'near',
}

export interface NativeCoinPrice {
  symbol: string
  usd: number
  asOf: string
}

interface LlamaCoin {
  price?: unknown
  symbol?: unknown
  timestamp?: unknown
  confidence?: unknown
}

/** What a chain's own coin is worth now, or nothing rather than a stale or doubtful figure. */
export async function fetchNativeCoinPrice(
  slug: ChainSlug,
  fetcher: typeof fetch = fetch,
  now: number = Date.now()
): Promise<NativeCoinPrice | undefined> {
  const { symbol } = CHAIN_DESCRIPTORS[slug].nativeCurrency
  const key = `coingecko:${COIN_IDS[slug]}`
  try {
    const response = await fetcher(`${PRICE_URL}/${key}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) return undefined
    const body = (await response.json()) as { coins?: Record<string, LlamaCoin> }
    const coin = body.coins?.[key]
    const usd = typeof coin?.price === 'number' ? coin.price : NaN
    const timestamp = Number(coin?.timestamp)
    if (coin?.symbol !== symbol || !Number.isFinite(usd) || usd <= 0) return undefined
    if (!(Number(coin?.confidence) >= MIN_CONFIDENCE)) return undefined
    if (!Number.isFinite(timestamp) || now / 1000 - timestamp > MAX_AGE_SECONDS) return undefined
    return { symbol, usd, asOf: new Date(timestamp * 1000).toISOString() }
  } catch {
    return undefined
  }
}

/** `$93.32` from a dollar up, `$0.8982` below, where cents would hide the price. */
export function formatCoinUsd(usd: number): string {
  const places = usd >= 1 ? 2 : 4
  return `$${usd.toLocaleString('en-US', {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  })}`
}
