import { beforeEach, describe, expect, it } from 'vitest'

import { clearTokenCache, listTokens, oneClickPrice, requestQuote } from '../chains/near/oneclick'
import { USDC_NEAR, USDT_NEAR, WRAP_NEAR } from '../chains/near/tokens'
import { ChainActionRefused } from '../chains/types'

/**
 * The real 1Click API, read-only. Every quote here is `dry: true`, which creates no
 * deposit address. Nothing signs or sends, and no account or funds are touched.
 *
 * The fixtures in the unit tests are written from this module's own assumptions.
 * This is what catches an API that has moved away from them. `requestQuote` checks
 * each quote's signature against the real key.
 */

const SKIP = process.env['SKIP_LIVE'] === '1'
const ME = 'root.near'
const WNEAR = `nep141:${WRAP_NEAR}`
const USDC = `nep141:${USDC_NEAR}`
const USDT = `nep141:${USDT_NEAR}`
const VAULT = 'nep141:base-0x0bb69b79bc829e1cfcc34a740110886d98d2bd14.omft.near'

function dry(originAsset: string, destinationAsset: string, amount: string, intents = false) {
  return requestQuote({
    dry: true,
    originAsset,
    destinationAsset,
    amount,
    account: ME,
    recipientType: intents ? 'INTENTS' : 'DESTINATION_CHAIN',
    deadline: new Date(Date.now() + 5 * 60_000).toISOString(),
    slippageBps: 100,
  })
}

function lossOf(envelope: Awaited<ReturnType<typeof dry>>): number {
  return 1 - Number(envelope.quote.amountOutUsd) / Number(envelope.quote.amountInUsd)
}

beforeEach(() => clearTokenCache())

describe.skipIf(SKIP)('the 1Click token list', () => {
  it('has the exact tokens this app allows, at the decimals it assumes', async () => {
    const tokens = await listTokens()
    expect(tokens.find((t) => t.assetId === WNEAR)).toMatchObject({ symbol: 'wNEAR', decimals: 24 })
    expect(tokens.find((t) => t.assetId === USDC)).toMatchObject({ symbol: 'USDC', decimals: 6 })
    expect(tokens.find((t) => t.assetId === USDT)).toMatchObject({ symbol: 'USDT', decimals: 6 })
    expect(tokens.find((t) => t.assetId === VAULT)).toMatchObject({
      symbol: 'gtUSDCp',
      decimals: 18,
    })
  }, 30_000)

  it('carries fresh prices, and stablecoins near but not forced to $1', async () => {
    const near = await oneClickPrice(WNEAR, 24)
    const usdc = await oneClickPrice(USDC, 6)
    const usdt = await oneClickPrice(USDT, 6)
    expect(near).toBeGreaterThan(0)
    expect(usdc).toBeGreaterThan(0.95)
    expect(usdc).toBeLessThan(1.05)
    expect(usdt).toBeGreaterThan(0.95)
    expect(usdt).toBeLessThan(1.05)
  }, 30_000)
})

describe.skipIf(SKIP)('dry quotes', () => {
  const ONE_NEAR = '1000000000000000000000000'
  const pairs: [string, string, string, string][] = [
    ['USDC to NEAR', USDC, WNEAR, '1000000'],
    ['NEAR to USDC', WNEAR, USDC, ONE_NEAR],
    ['USDT to NEAR', USDT, WNEAR, '1000000'],
    ['NEAR to USDT', WNEAR, USDT, ONE_NEAR],
    ['USDC to USDT', USDC, USDT, '1000000'],
    ['USDT to USDC', USDT, USDC, '1000000'],
  ]

  for (const [name, origin, destination, amount] of pairs) {
    it(`${name} is signed, matches, and is within the value limit`, async () => {
      const envelope = await dry(origin, destination, amount)
      expect(envelope.quote.amountIn).toBe(amount)
      expect(envelope.quote.minAmountIn).toBe(amount)
      expect(BigInt(envelope.quote.amountOut)).toBeGreaterThan(BigInt(0))
      expect(envelope.quote.depositAddress).toBeUndefined()
      expect(envelope.quoteRequest).toMatchObject({
        dry: true,
        recipient: ME,
        refundTo: ME,
        originAsset: origin,
        destinationAsset: destination,
      })
      expect(lossOf(envelope)).toBeLessThan(0.05)
      expect(envelope.quoteRequest.appFees?.length ?? 0).toBeGreaterThan(0)
    }, 45_000)
  }

  it('reaches the vault receipt token from USDC and from USDT, into an Intents balance', async () => {
    for (const origin of [USDC, USDT]) {
      const envelope = await dry(origin, VAULT, '100000000', true)
      expect(envelope.quoteRequest.recipientType).toBe('INTENTS')
      expect(lossOf(envelope)).toBeLessThan(0.05)
    }
  }, 45_000)

  it('says "no liquidity" in a sentence for an impossible size', async () => {
    const error = await dry(USDC, WNEAR, '50000000000000').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ChainActionRefused)
    expect((error as Error).message).toMatch(/no price for this right now/)
  }, 45_000)
})
