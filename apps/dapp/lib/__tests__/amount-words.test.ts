import { describe, expect, it } from 'vitest'

import { chainBalanceReply } from '../chains/balance-reply'
import { parseChainAction } from '../chains/parse-action'
import { chainRouteFromReading } from '../chains/parse-sequence'
import { findShare, sizeShare } from '../chat/share-amount'

/**
 * What a person types around an amount, on every chain. Reported on NEAR on 11 November 2026:
 * "swap 30% of what i have in near to usdc" read "what" as the coin, "swap 0.36… NEAR token to
 * usdc" was not read at all, and the model then turned 23 decimals into a float that no longer
 * matched what was typed, so the request was refused.
 */

const COINS = ['NEAR', 'SOL', 'SUI', 'AVAX', 'MON', 'XLM'] as const

describe.each(COINS)('with %s', (coin) => {
  const lower = coin.toLowerCase()

  it('reads a share of what the wallet holds, however it is said', () => {
    for (const text of [
      `swap 30% of what i have in ${lower} to usdc`,
      `swap 30% of what I hold in my ${lower} to usdc`,
      `swap 30% of my ${lower} to usdc`,
    ]) {
      expect(findShare(text), text).toMatchObject({ percent: 30, word: lower })
    }
    expect(findShare(`swap half of what i have in ${lower} to usdc`)).toMatchObject({
      percent: 50,
      word: lower,
    })
  })

  it('sizes the share into a sentence the parser reads', () => {
    const sized = sizeShare(`swap 30% of what i have in ${lower} to usdc`, {
      [coin]: '1.21044109440815889',
    })
    expect(sized).toEqual({
      text: `swap 0.36313232 ${coin} to usdc`,
      line: `30% of your ${coin} is 0.36313232 ${coin}.`,
    })
    expect(parseChainAction((sized as { text: string }).text)).toMatchObject({
      kind: 'swap',
      amount: '0.36313232',
      tokenIn: coin,
    })
  })

  it('reads a swap with words between the token and where it goes', () => {
    for (const filler of [
      'token',
      'tokens',
      'in my wallet',
      'inmy wallet',
      'from my wallet',
      'token in my wallet',
    ]) {
      const text = `swap 0.5 ${coin} ${filler} to usdc`
      expect(parseChainAction(text), text).toMatchObject({
        kind: 'swap',
        amount: '0.5',
        tokenIn: coin,
        tokenOut: 'usdc',
      })
    }
  })

  it('keeps the digits the person typed when a model read them as a float', () => {
    const typed = '0.36313232832244766999999'
    const said = [`swap ${typed} ${coin} to usdc`]
    const read = {
      action: 'swap',
      tokenIn: coin,
      tokenOut: 'USDC',
      amountUsd: Number(typed),
      amountStated: true,
      followOn: null,
    }
    const route = chainRouteFromReading(read, `swap ${Number(typed)} ${coin} to USDC`, said, 'near')
    expect(route).toMatchObject({ action: { amount: typed, tokenIn: coin } })
  })
})

describe('a share and a balance, in figures a person can read', () => {
  it('rounds a part share down to 8 places, and keeps all of it exact', () => {
    expect(
      sizeShare('swap 50% of my avax to usdc', { AVAX: '0.086874181223044652' })
    ).toMatchObject({
      text: 'swap 0.04343709 AVAX to usdc',
    })
    expect(
      sizeShare('swap all my near to usdc', { NEAR: '1.210441094408158899999998' })
    ).toMatchObject({
      text: 'swap 1.210441094408158899999998 NEAR to usdc',
    })
  })

  it('never reads "what" or "my" as a coin', () => {
    expect(sizeShare('swap 30% of what to usdc', { NEAR: '1' })).toBeUndefined()
  })

  it('lists a balance to 6 places, rounded down, and says when it is below that', () => {
    const reply = chainBalanceReply(
      {
        complete: true,
        tokens: [
          {
            symbol: 'NEAR',
            id: 'near',
            amount: '1.210441094408158899999998',
            decimals: 24,
            native: true,
            listed: true,
          },
          { symbol: 'USDC', id: 'u', amount: '5.115078', decimals: 6, native: false, listed: true },
          {
            symbol: 'wNEAR',
            id: 'w',
            amount: '0.0000000001',
            decimals: 24,
            native: false,
            listed: true,
          },
        ],
      } as never,
      'NEAR'
    )
    expect(reply).toContain('• 1.210441 NEAR')
    expect(reply).toContain('• 5.115078 USDC')
    expect(reply).toContain('• <0.000001 wNEAR')
  })
})
