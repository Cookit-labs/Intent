import { describe, expect, it } from 'vitest'

/**
 * Why cash-outs stay closed on Monad, and what keeps NEAR and Avalanche open, as far as can be read
 * without Weave's key. Every quote here is `dry: true`, which makes no deposit address and moves
 * nothing. A failure means a reason in `closedCashoutReply` may have gone, or come back.
 *
 * What only a key can settle: on 12 November 2026 an unfunded POST /orders from `crypto:NEAR:USDC`
 * came back with a deposit address and no memo, which is what opened NEAR.
 */

const SKIP = process.env['SKIP_LIVE'] === '1'

const QUOTE_URL = 'https://1click.chaindefuser.com/v0/quote'
const ASSETS_URL = 'https://api.paywithweave.com/api/v1/assets'

const EVM_ACCOUNT = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
const NEAR_USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'
const BASE_USDC = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near'
const MONAD_USDC = 'nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx'
const AVALANCHE_USDC = 'nep245:v2_1.omni.hot.tg:43114_3atVJH3r5c4GqiSYmg9fECvjc47o'

async function dryQuote(
  over: Record<string, unknown>
): Promise<{ status: number; message: unknown }> {
  const response = await fetch(QUOTE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dry: true,
      swapType: 'EXACT_INPUT',
      slippageTolerance: 100,
      depositType: 'ORIGIN_CHAIN',
      refundType: 'ORIGIN_CHAIN',
      recipientType: 'DESTINATION_CHAIN',
      amount: '50000000',
      recipient: EVM_ACCOUNT,
      deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
      ...over,
    }),
    signal: AbortSignal.timeout(25_000),
  })
  const body = (await response.json()) as { message?: unknown }
  return { status: response.status, message: body.message }
}

describe.skipIf(SKIP)('what keeps NEAR open', () => {
  // Weave asked 1Click for memo mode until 12 November 2026, which NEAR refuses. It now asks for
  // plain mode. If this fails, close NEAR in `closedCashoutReply` again.
  it('has NEAR Intents quoting NEAR USDC in plain mode, the first leg of every Weave route from it', async () => {
    const plain = await dryQuote({
      originAsset: NEAR_USDC,
      destinationAsset: BASE_USDC,
      refundTo: 'root.near',
      depositMode: 'SIMPLE',
    })
    expect(plain.status).toBe(201)
  }, 30_000)
})

describe.skipIf(SKIP)('what keeps Avalanche open', () => {
  // NEAR Intents refused Avalanche USDC for part of 2026-11-10, and every Weave route from
  // Avalanche starts there. If this fails, close Avalanche in `closedCashoutReply` again.
  it('has NEAR Intents quoting Avalanche USDC, the first leg of every Weave route from it', async () => {
    const quote = await dryQuote({
      originAsset: AVALANCHE_USDC,
      destinationAsset: BASE_USDC,
      refundTo: EVM_ACCOUNT,
    })
    expect(quote.status).toBe(201)
  }, 30_000)
})

describe.skipIf(SKIP)('what keeps Monad closed', () => {
  it('is not on the list Weave publishes', async () => {
    const response = await fetch(ASSETS_URL, { signal: AbortSignal.timeout(25_000) })
    const { data } = (await response.json()) as { data: { crypto: { key: string }[] } }
    const keys = data.crypto.map((asset) => asset.key)
    expect(keys).toContain('crypto:AVALANCHE:USDC')
    expect(keys.filter((key) => key.includes('MONAD'))).toEqual([])
  }, 30_000)

  it('has no 1Click quote out of Monad, which any route to Weave would need', async () => {
    const quote = await dryQuote({
      swapType: 'EXACT_OUTPUT',
      originAsset: MONAD_USDC,
      destinationAsset: AVALANCHE_USDC,
      refundTo: EVM_ACCOUNT,
    })
    expect(quote.status).toBe(400)
  }, 30_000)
})
