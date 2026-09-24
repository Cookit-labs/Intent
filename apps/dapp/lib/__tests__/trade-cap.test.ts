import { describe, expect, it } from 'vitest'

import {
  DEFAULT_MAINNET_MAX_TRADE_USD,
  TradeCapExceeded,
  assertPlanWithinCap,
  assertTradeWithinCap,
  assertWithinCap,
  tradeCapUsd,
  usdValue,
} from '../server/trade-cap'
import type { MarketPrice } from '../swap/price-types'

/**
 * A small per-trade cap on mainnet, and none on testnet.
 *
 * Real money, new rails: until the app has been watched keeping its promises
 * with real volume, no single trade may be worth more than a few tens of
 * dollars. The cap is dollars rather than units so it means the same thing
 * for XLM and for USDC, which is why a trade that cannot be valued in
 * dollars is refused rather than waved through — a cap that cannot be
 * checked is no cap.
 */

const asOf = '2026-09-24T00:00:00.000Z'
const table: Record<string, MarketPrice> = {
  XLM: { symbol: 'XLM', usd: 0.2, source: 'reflector', asOf },
  USDC: { symbol: 'USDC', usd: 1, source: 'stellar-mainnet', asOf },
  CETES: { symbol: 'CETES', usd: 0.05, source: 'fallback', asOf },
}

describe('the cap itself', () => {
  it('does not exist on testnet', () => {
    expect(tradeCapUsd({}, 'testnet')).toBeUndefined()
    expect(tradeCapUsd({ MAINNET_MAX_TRADE_USD: '5' }, 'testnet')).toBeUndefined()
  })

  it('is fifty dollars on mainnet unless configured', () => {
    expect(DEFAULT_MAINNET_MAX_TRADE_USD).toBe(50)
    expect(tradeCapUsd({}, 'mainnet')).toBe(50)
    expect(tradeCapUsd({ MAINNET_MAX_TRADE_USD: '' }, 'mainnet')).toBe(50)
    expect(tradeCapUsd({ MAINNET_MAX_TRADE_USD: '200' }, 'mainnet')).toBe(200)
  })

  it('refuses a cap that is not a positive number, naming the variable', () => {
    expect(() => tradeCapUsd({ MAINNET_MAX_TRADE_USD: 'lots' }, 'mainnet')).toThrow(
      /MAINNET_MAX_TRADE_USD/
    )
    expect(() => tradeCapUsd({ MAINNET_MAX_TRADE_USD: '0' }, 'mainnet')).toThrow(
      /MAINNET_MAX_TRADE_USD/
    )
  })
})

describe('checking a dollar value against it', () => {
  it('is a no-op on testnet, whatever the value', () => {
    expect(() => assertWithinCap(1_000_000, {}, 'testnet')).not.toThrow()
    expect(() => assertWithinCap(Number.NaN, {}, 'testnet')).not.toThrow()
  })

  it('passes at or under the cap on mainnet', () => {
    expect(() => assertWithinCap(49.99, {}, 'mainnet')).not.toThrow()
    expect(() => assertWithinCap(50, {}, 'mainnet')).not.toThrow()
  })

  it('refuses over the cap, saying the cap and how to change it', () => {
    let caught: unknown
    try {
      assertWithinCap(50.01, {}, 'mainnet')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(TradeCapExceeded)
    expect((caught as Error).message).toMatch(/\$50/)
    expect((caught as Error).message).toMatch(/MAINNET_MAX_TRADE_USD/)
    expect((caught as Error).message).toMatch(/\$50\.01/)
  })

  it('refuses a trade it cannot value, because an unchecked cap is no cap', () => {
    expect(() => assertWithinCap(Number.NaN, {}, 'mainnet')).toThrow(/could not be valued/)
    expect(() => assertWithinCap(Number.NaN, {}, 'mainnet')).toThrow(TradeCapExceeded)
  })
})

describe('valuing a trade', () => {
  it('multiplies display units by a real price', () => {
    expect(usdValue('XLM', '100', table)).toBeCloseTo(20)
    expect(usdValue('USDC', '12.5', table)).toBe(12.5)
  })

  it('has no value for a fallback price or an unknown asset', () => {
    expect(usdValue('CETES', '100', table)).toBeNaN()
    expect(usdValue('DOGE', '1', table)).toBeNaN()
  })
})

describe('checking a trade end to end', () => {
  it('prices nothing on testnet', async () => {
    await expect(
      assertTradeWithinCap('XLM', '1000000', {
        network: 'testnet',
        prices: () => Promise.reject(new Error('must not be asked')),
      })
    ).resolves.toBeUndefined()
  })

  it('passes a small mainnet trade and refuses a large one', async () => {
    const prices = () => Promise.resolve(table)
    await expect(
      assertTradeWithinCap('XLM', '200', { env: {}, network: 'mainnet', prices })
    ).resolves.toBeUndefined()
    await expect(
      assertTradeWithinCap('XLM', '300', { env: {}, network: 'mainnet', prices })
    ).rejects.toThrow(/caps each trade at \$50/)
    await expect(
      assertTradeWithinCap('USDC', '51', { env: {}, network: 'mainnet', prices })
    ).rejects.toThrow(TradeCapExceeded)
  })

  it('honours a configured cap', async () => {
    const prices = () => Promise.resolve(table)
    await expect(
      assertTradeWithinCap('USDC', '150', {
        env: { MAINNET_MAX_TRADE_USD: '200' },
        network: 'mainnet',
        prices,
      })
    ).resolves.toBeUndefined()
  })
})

describe('checking a plan, step by step', () => {
  const XLM = { kind: 'classic' as const, code: 'XLM' }
  const USDC = { kind: 'classic' as const, code: 'USDC', issuer: 'G' }
  const prices = () => Promise.resolve(table)
  const pools = () =>
    Promise.resolve([
      {
        id: 'pool-1',
        assets: [
          { code: 'XLM', amount: '1000' },
          { code: 'USDC', issuer: 'G', amount: '200' },
        ],
        feePct: 0.3,
        totalShares: '1',
        isEmpty: false,
      },
    ])

  it('passes a plan whose every step is under the cap', async () => {
    await expect(
      assertPlanWithinCap(
        [
          { kind: 'trust', asset: USDC },
          { kind: 'swap', from: USDC, to: XLM, sendAmount: '400000000', minReceive: '1' },
          { kind: 'rest', selling: XLM, buying: USDC, amount: '100', price: { n: 1, d: 5 } },
        ],
        { env: {}, network: 'mainnet', prices, pools }
      )
    ).resolves.toBeUndefined()
  })

  it('refuses the step that is over, whichever it is', async () => {
    await expect(
      assertPlanWithinCap(
        [
          { kind: 'swap', from: USDC, to: XLM, sendAmount: '100000000', minReceive: '1' },
          { kind: 'rest', selling: XLM, buying: USDC, amount: '300', price: { n: 1, d: 5 } },
        ],
        { env: {}, network: 'mainnet', prices, pools }
      )
    ).rejects.toThrow(/caps each trade at \$50/)
  })

  it('values a pool deposit as both sides together', async () => {
    const deposit = (a: string, b: string) => ({
      kind: 'pool' as const,
      poolId: 'pool-1',
      maxAmountA: a,
      maxAmountB: b,
      minPrice: { n: 1, d: 10 },
      maxPrice: { n: 1, d: 1 },
    })
    await expect(
      assertPlanWithinCap([deposit('100', '20')], { env: {}, network: 'mainnet', prices, pools })
    ).resolves.toBeUndefined()
    await expect(
      assertPlanWithinCap([deposit('200', '30')], { env: {}, network: 'mainnet', prices, pools })
    ).rejects.toThrow(/caps each trade at \$50/)
    // A pool it cannot find cannot be valued, and is refused for that.
    await expect(
      assertPlanWithinCap([{ ...deposit('1', '1'), poolId: 'pool-9' }], {
        env: {},
        network: 'mainnet',
        prices,
        pools,
      })
    ).rejects.toThrow(/could not be valued/)
  })

  it('reads neither prices nor pools on testnet', async () => {
    const never = () => Promise.reject(new Error('must not be asked'))
    await expect(
      assertPlanWithinCap(
        [{ kind: 'swap', from: USDC, to: XLM, sendAmount: '1', minReceive: '1' }],
        { network: 'testnet', prices: never, pools: never }
      )
    ).resolves.toBeUndefined()
  })
})

describe('a plan cannot move more than the cap in one asset across its steps', () => {
  const XLM = { kind: 'classic' as const, code: 'XLM' }
  const USDC = { kind: 'classic' as const, code: 'USDC', issuer: 'G' }
  const prices = () => Promise.resolve(table)
  const swap = (usdc: string) => ({
    kind: 'swap' as const,
    from: USDC,
    to: XLM,
    sendAmount: usdc,
    minReceive: '1',
  })

  it('refuses two steps that together spend over the cap of one asset', async () => {
    // Ten steps of $30 would be $300 out of one account on one signature.
    await expect(
      assertPlanWithinCap([swap('300000000'), swap('300000000')], {
        env: {},
        network: 'mainnet',
        prices,
      })
    ).rejects.toThrow(/USDC across this plan/)
  })

  it('passes steps that spend different assets, each under the cap', async () => {
    await expect(
      assertPlanWithinCap(
        [
          swap('300000000'),
          { kind: 'rest', selling: XLM, buying: USDC, amount: '150', price: { n: 1, d: 5 } },
        ],
        { env: {}, network: 'mainnet', prices }
      )
    ).resolves.toBeUndefined()
  })
})
