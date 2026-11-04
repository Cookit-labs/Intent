import { describe, expect, it } from 'vitest'

import { verifyQuoteSignature, type SignedQuoteFields } from '../chains/near/quote-signature'

/**
 * Real responses from 1Click, captured 2026-11-03: one dry quote and one quote
 * with a deposit address that was never paid. They exercise the real manager key
 * with no network, so a mistake in the hashing or the encoding shows up here.
 */

const DRY: SignedQuoteFields = {
  quote: {
    amountIn: '1000000',
    amountInFormatted: '1.0',
    amountInUsd: '0.999387000000',
    minAmountIn: '1000000',
    amountOut: '260088790550469068128425',
    amountOutFormatted: '0.260088790550469068128425',
    amountOutUsd: '0.998740955714',
    minAmountOut: '257487902644964377447140',
    timeEstimate: 22,
    refundFee: '0',
    withdrawFee: '0',
  },
  quoteRequest: {
    dry: true,
    depositMode: 'SIMPLE',
    swapType: 'EXACT_INPUT',
    slippageTolerance: 100,
    originAsset: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: 'nep141:wrap.near',
    amount: '1000000',
    refundTo: 'root.near',
    refundType: 'ORIGIN_CHAIN',
    recipient: 'root.near',
    recipientType: 'DESTINATION_CHAIN',
    deadline: '2026-11-03T15:46:32.596Z',
    confidentiality: 'public',
    quoteWaitingTimeMs: 0,
    insured: false,
    appFees: [
      { recipient: '5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd', fee: 20 },
    ],
  },
  signature:
    'ed25519:2FydMpooD6GNzdzXUgnijmFKYyEwbmmR3DRtWNwtuwCieN1RWp3wziSVYwW33n8Q2WjkogQJv93BAp651NKfsaSJ',
  timestamp: '2026-11-03T15:36:33.085Z',
}

const LIVE: SignedQuoteFields = {
  quote: {
    amountIn: '1000000',
    amountInFormatted: '1.0',
    amountInUsd: '0.999460000000',
    minAmountIn: '1000000',
    amountOut: '259276647566704918032786',
    amountOutFormatted: '0.259276647566704918032786',
    amountOutUsd: '0.993029560180',
    minAmountOut: '256683881091037868852458',
    timeEstimate: 22,
    refundFee: '0',
    withdrawFee: '0',
    deadline: '2026-11-06T15:45:35.601Z',
    timeWhenInactive: '2026-11-06T15:45:35.601Z',
    depositAddress: '570846f7a07a97b9640a437e306a2a26d2524ca9d4f9a9016a434bc1c47d6f74',
  },
  quoteRequest: {
    dry: false,
    depositMode: 'SIMPLE',
    swapType: 'EXACT_INPUT',
    slippageTolerance: 100,
    originAsset: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: 'nep141:wrap.near',
    amount: '1000000',
    refundTo: 'root.near',
    refundType: 'ORIGIN_CHAIN',
    recipient: 'root.near',
    recipientType: 'DESTINATION_CHAIN',
    deadline: '2026-11-03T15:45:35.601Z',
    confidentiality: 'public',
    quoteWaitingTimeMs: 0,
    insured: false,
    appFees: [
      {
        recipient: '5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd',
        fee: 20,
        limitOrderId: null,
      },
    ],
  },
  signature:
    'ed25519:3dT8WCUbD8dhCfzWoyMsySRp45eofsujSxipDHvxkSrGxmYj6gVX4Nvsvy2twg9xzHmWRQNf1goNkyqFywycXvQ1',
  timestamp: '2026-11-03T15:40:36.238Z',
}

function tamperedQuote(base: SignedQuoteFields, field: string, value: unknown): SignedQuoteFields {
  return { ...base, quote: { ...base.quote, [field]: value } }
}

function tamperedRequest(
  base: SignedQuoteFields,
  field: string,
  value: unknown
): SignedQuoteFields {
  return { ...base, quoteRequest: { ...base.quoteRequest, [field]: value } }
}

describe('verifyQuoteSignature', () => {
  it('accepts real quotes from 1Click', () => {
    expect(verifyQuoteSignature(DRY)).toBe(true)
    expect(verifyQuoteSignature(LIVE)).toBe(true)
  })

  it('refuses a swapped deposit address', () => {
    const other = '30ea8641492a90c05b53a337b51d66ed05118eaa9065bb7bb032bb2cea75e034'
    expect(verifyQuoteSignature(tamperedQuote(LIVE, 'depositAddress', other))).toBe(false)
  })

  it('refuses changed amounts', () => {
    expect(verifyQuoteSignature(tamperedQuote(DRY, 'amountOut', '999'))).toBe(false)
    expect(verifyQuoteSignature(tamperedRequest(LIVE, 'amount', '999'))).toBe(false)
  })

  it('refuses a changed recipient or refund address', () => {
    expect(verifyQuoteSignature(tamperedRequest(LIVE, 'recipient', 'evil.near'))).toBe(false)
    expect(verifyQuoteSignature(tamperedRequest(LIVE, 'refundTo', 'evil.near'))).toBe(false)
  })

  it('refuses a changed timestamp, a bad signature and another key', () => {
    expect(verifyQuoteSignature({ ...DRY, timestamp: '2026-11-03T15:36:34.085Z' })).toBe(false)
    expect(verifyQuoteSignature({ ...DRY, signature: 'ed25519:notasignature0OIl' })).toBe(false)
    expect(verifyQuoteSignature({ ...DRY, signature: LIVE.signature })).toBe(false)
    expect(verifyQuoteSignature(DRY, 'CuoEPFoaHBWRnhxtmKZEHxkXhFJSTKyrPTgCFUgRmPfQ')).toBe(false)
  })
})
