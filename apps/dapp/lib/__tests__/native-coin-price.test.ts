import { CHAIN_DESCRIPTORS, CHAIN_ORDER } from '@intent/config'
import { describe, expect, it } from 'vitest'

import { fetchNativeCoinPrice, formatCoinUsd } from '../prices/native-coin'

const NOW = 1_800_000_000_000
const FRESH = NOW / 1000 - 30

/** Answers like DefiLlama: under the key asked for, or nothing for a key it doesn't know. */
function llama(
  coins: Record<string, { price: unknown; symbol: string; timestamp: number; confidence: number }>
): { fetcher: typeof fetch; urls: string[] } {
  const urls: string[] = []
  const fetcher = (async (input: RequestInfo | URL) => {
    urls.push(String(input))
    return new Response(JSON.stringify({ coins }))
  }) as typeof fetch
  return { fetcher, urls }
}

function coin(key: string, symbol: string, price: unknown = 12.5) {
  return { [key]: { price, symbol, timestamp: FRESH, confidence: 0.99 } }
}

const IDS = {
  arc: 'usd-coin',
  stellar: 'stellar',
  solana: 'solana',
  avalanche: 'avalanche-2',
  sui: 'sui',
  monad: 'monad',
  near: 'near',
} as const

describe('fetchNativeCoinPrice', () => {
  it.each(CHAIN_ORDER)("prices %s's own coin", async (slug) => {
    const symbol = CHAIN_DESCRIPTORS[slug].nativeCurrency.symbol
    const key = `coingecko:${IDS[slug]}`
    const { fetcher, urls } = llama(coin(key, symbol))

    const got = await fetchNativeCoinPrice(slug, fetcher, NOW)

    expect(got).toEqual({ symbol, usd: 12.5, asOf: new Date(FRESH * 1000).toISOString() })
    expect(urls[0]).toBe(`https://coins.llama.fi/prices/current/${key}`)
  })

  it('refuses another coin answered under the id it asked for', async () => {
    const { fetcher } = llama(coin('coingecko:sui', 'WRONG'))
    expect(await fetchNativeCoinPrice('sui', fetcher, NOW)).toBeUndefined()
  })

  it('refuses a price more than five minutes old', async () => {
    const { fetcher } = llama({
      'coingecko:sui': { price: 1, symbol: 'SUI', timestamp: NOW / 1000 - 301, confidence: 0.99 },
    })
    expect(await fetchNativeCoinPrice('sui', fetcher, NOW)).toBeUndefined()
  })

  it('refuses a low-confidence price', async () => {
    const { fetcher } = llama({
      'coingecko:sui': { price: 1, symbol: 'SUI', timestamp: FRESH, confidence: 0.5 },
    })
    expect(await fetchNativeCoinPrice('sui', fetcher, NOW)).toBeUndefined()
  })

  it.each([0, -1, 'nope', null])('refuses a price of %s', async (price) => {
    const { fetcher } = llama(coin('coingecko:sui', 'SUI', price))
    expect(await fetchNativeCoinPrice('sui', fetcher, NOW)).toBeUndefined()
  })

  it('answers nothing when the coin is missing, the call fails or the network is down', async () => {
    expect(await fetchNativeCoinPrice('sui', llama({}).fetcher, NOW)).toBeUndefined()

    const failing = (async () => new Response('', { status: 500 })) as typeof fetch
    expect(await fetchNativeCoinPrice('sui', failing, NOW)).toBeUndefined()

    const down = (async () => {
      throw new Error('offline')
    }) as typeof fetch
    expect(await fetchNativeCoinPrice('sui', down, NOW)).toBeUndefined()
  })
})

describe('formatCoinUsd', () => {
  it('shows cents from a dollar up', () => {
    expect(formatCoinUsd(93.31975)).toBe('$93.32')
    expect(formatCoinUsd(1)).toBe('$1.00')
    expect(formatCoinUsd(64250.5)).toBe('$64,250.50')
  })

  it('keeps enough places to read a coin under a dollar', () => {
    expect(formatCoinUsd(0.898238)).toBe('$0.8982')
    expect(formatCoinUsd(0.0181207)).toBe('$0.0181')
  })
})
