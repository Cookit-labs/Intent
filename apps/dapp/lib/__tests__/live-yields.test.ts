import { describe, expect, it, vi } from 'vitest'

import { liveYields } from '../server/live-yields'

describe('liveYields', () => {
  it('reads Stellar from the lending rates, for the asset asked about', async () => {
    const rates = await liveYields('stellar', 'usdc', undefined, {
      lendingRates: async () => [
        { venue: 'blend', asset: 'XLM', supplyApy: 0.7 },
        { venue: 'defindex', asset: 'USDC', supplyApy: 8.4 },
      ],
      chainModule: () => undefined,
      quoteRoutes: vi.fn(),
    })
    expect(rates).toEqual([{ venueName: 'DeFindex', apyPercent: 8.4 }])
  })

  it('asks every supply venue on another chain for its live rate', async () => {
    const quoteRoutes = vi.fn(async () => [
      { quote: { kind: 'chain', venueName: 'Kamino Lend', apyPercent: 6.1 } },
      { quote: { kind: 'chain', venueName: 'Jupiter Lend', apyPercent: 5.4 } },
      { quote: { kind: 'chain', venueName: 'No rate' } },
    ])
    const solana = { chain: 'solana' }
    const rates = await liveYields('solana', 'USDC', 'Acct111', {
      lendingRates: async () => [],
      chainModule: () => solana as never,
      quoteRoutes: quoteRoutes as never,
    })
    expect(quoteRoutes).toHaveBeenCalledWith(
      solana,
      { kind: 'supply', amount: '1', tokenIn: 'USDC' },
      'Acct111'
    )
    expect(rates).toEqual([
      { venueName: 'Kamino Lend', apyPercent: 6.1 },
      { venueName: 'Jupiter Lend', apyPercent: 5.4 },
    ])
  })

  it('keeps the best figure when one venue answers twice', async () => {
    const rates = await liveYields('sui', 'USDC', '0xabc', {
      lendingRates: async () => [],
      chainModule: () => ({ chain: 'sui' }) as never,
      quoteRoutes: (async () => [
        { quote: { kind: 'chain', venueName: 'Scallop', apyPercent: 3 } },
        { quote: { kind: 'chain', venueName: 'Scallop', apyPercent: 4 } },
      ]) as never,
    })
    expect(rates).toEqual([{ venueName: 'Scallop', apyPercent: 4 }])
  })

  it('reads nothing off Stellar without a wallet, and nothing on an unknown chain', async () => {
    const quoteRoutes = vi.fn()
    const deps = {
      lendingRates: async () => [],
      chainModule: (c: string) => (c === 'solana' ? ({ chain: 'solana' } as never) : undefined),
      quoteRoutes: quoteRoutes as never,
    }
    expect(await liveYields('solana', 'USDC', undefined, deps)).toEqual([])
    expect(await liveYields('arc', 'USDC', '0x1', deps)).toEqual([])
    expect(quoteRoutes).not.toHaveBeenCalled()
  })
})
