import { describe, expect, it } from 'vitest'

import { readingFromArguments } from '../parse-intent-llm'

const onChain = {
  allowedSymbols: ['AVAX', 'USDC'],
  allowedAnchors: ['weave'],
  reportRefusedFollowOn: true,
}

const base = {
  action: 'swap',
  tokenIn: 'USDC',
  tokenOut: 'NGN',
  amountUsd: 0,
  amountStated: false,
  followOn: 'none',
  followOnVenue: '',
}

describe('a currency named as what to swap into', () => {
  it('reads USDC into a currency as a cash-out of USDC, not a reading to throw away', () => {
    expect(readingFromArguments(base, onChain)).toMatchObject({
      action: 'offramp',
      tokenIn: 'USDC',
      tokenOut: 'USDC',
      followOn: null,
    })
  })

  it('reads any other coin into a currency as a swap to USDC, then a cash-out', () => {
    for (const tokenOut of ['naira', 'NGN', 'Naira', 'kes']) {
      expect(readingFromArguments({ ...base, tokenIn: 'AVAX', tokenOut }, onChain)).toMatchObject({
        action: 'swap',
        tokenIn: 'AVAX',
        tokenOut: 'USDC',
        followOn: { kind: 'offramp', venue: 'weave' },
      })
    }
  })

  it('keeps a stated amount', () => {
    expect(
      readingFromArguments({ ...base, tokenIn: 'AVAX', amountUsd: 2, amountStated: true }, onChain)
    ).toMatchObject({ amountUsd: 2, amountStated: true })
  })

  it('reads a swap of USDC to itself, then a cash-out, as a cash-out of the USDC held', () => {
    // What the model sent for "Swap to NGN" after "Swap 5.115078 USDC to naira".
    expect(
      readingFromArguments(
        {
          ...base,
          tokenOut: 'USDC',
          amountUsd: 5.115078,
          amountStated: true,
          followOn: 'offramp',
        },
        onChain
      )
    ).toMatchObject({
      action: 'offramp',
      tokenIn: 'USDC',
      tokenOut: 'USDC',
      amountUsd: 5.115078,
      amountStated: true,
      followOn: null,
    })
  })

  it('still refuses a swap of a coin to itself with nothing after it', () => {
    expect(readingFromArguments({ ...base, tokenOut: 'USDC' }, onChain)).toBeNull()
  })

  it('still refuses a token nobody can trade', () => {
    expect(readingFromArguments({ ...base, tokenIn: 'DOGE' }, onChain)).toBeNull()
  })
})
