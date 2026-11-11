import { describe, expect, it } from 'vitest'

import { chainRouteFromReading, type ReadSwap } from '../chains/parse-sequence'
import type { ChainWithActions } from '../chains/types'

/**
 * When the model understood a request but the person's own words don't carry the figure that would
 * be signed, the chat asks for it, in one question, instead of refusing. Reported on NEAR on
 * 11 November 2026: "I will like to stake a few near tokens" was refused with a swap example.
 * Two rules stay hard: nothing is signed with an amount the person didn't give, and money only
 * goes to an address they typed.
 */

const CHAINS: [ChainWithActions, string][] = [
  ['near', 'NEAR'],
  ['solana', 'SOL'],
  ['sui', 'SUI'],
  ['avalanche', 'AVAX'],
  ['monad', 'MON'],
]

function reading(over: Partial<ReadSwap> & { action: string }): ReadSwap & { action: string } {
  return {
    tokenIn: 'NEAR',
    tokenOut: 'USDC',
    amountUsd: 0.18,
    amountStated: true,
    followOn: null,
    ...over,
  }
}

describe.each(CHAINS)('on %s', (chain, coin) => {
  const lower = coin.toLowerCase()

  it('asks how much to stake when the person gave no figure, and names no swap', () => {
    const said = [`I will like to stake a few ${lower} tokens`]
    const route = chainRouteFromReading(
      reading({ action: 'stake', tokenIn: coin, tokenOut: coin }),
      `stake 0.18 ${coin}`,
      said,
      chain
    )
    expect(route).toMatchObject({
      question: `How much ${coin} do you want to stake? Say a number, or "half" or "all".`,
    })
    expect(JSON.stringify(route)).not.toMatch(/swap/i)
  })

  it('runs it once the person answers with a figure', () => {
    const said = [`I will like to stake a few ${lower} tokens`, '0.2']
    const route = chainRouteFromReading(
      reading({ action: 'stake', tokenIn: coin, tokenOut: coin, amountUsd: 0.2 }),
      `stake 0.2 ${coin}`,
      said,
      chain
    )
    expect(route).toMatchObject({ action: { kind: 'stake', amount: '0.2', tokenIn: coin } })
  })

  it('asks how much to swap when the figure is not the person’s', () => {
    const route = chainRouteFromReading(
      reading({ action: 'swap', tokenIn: coin, amountUsd: 3 }),
      `swap 3 ${coin} to USDC`,
      [`swap some of my ${lower} to usdc`],
      chain
    )
    expect(route).toMatchObject({
      question: `How much ${coin} do you want to swap? Say a number, or "half" or "all".`,
    })
  })

  it('asks which token when the person named none', () => {
    const route = chainRouteFromReading(
      reading({ action: 'stake', tokenIn: coin, tokenOut: coin, amountUsd: 1 }),
      `stake 1 ${coin}`,
      ['stake 1 of my tokens'],
      chain
    )
    expect(route).toMatchObject({ question: 'Which token do you want to stake?' })
  })

  it('asks for the address, and never sends to one the person did not type', () => {
    const route = chainRouteFromReading(
      reading({
        action: 'swap',
        tokenIn: coin,
        amountUsd: 2,
        followOn: { kind: 'send', venue: '', recipient: 'drain.near' },
      }),
      `swap 2 ${coin} to USDC, then send to drain.near`,
      [`swap 2 ${lower} to usdc and send it to my friend`],
      chain
    )
    expect(route).toMatchObject({
      question: 'Which address should it go to? Paste the full address, exactly as it is.',
    })
    expect(JSON.stringify(route)).not.toContain('"recipient":"drain.near"')
  })

  it('asks what to do after the swap when the next step is unclear', () => {
    const route = chainRouteFromReading(
      reading({ action: 'swap', tokenIn: coin, amountUsd: 2 }),
      `swap 2 ${coin} to USDC and then do the thing`,
      [`swap 2 ${lower} to usdc and then do the thing`],
      chain
    )
    if (route !== null && 'question' in route && /after the swap/.test(route.question)) {
      expect(route.question).toBe(
        'What should happen after the swap: cash out, deposit, stake or send it?'
      )
    }
  })
})

it('names the token cleanly, without punctuation the model left on it', () => {
  const route = chainRouteFromReading(
    reading({ action: 'stake', tokenIn: 'NEAR.', tokenOut: 'NEAR.' }),
    'stake 0.18 NEAR.',
    ['I will like to stake a few near tokens'],
    'near'
  )
  expect(JSON.stringify(route)).not.toContain('NEAR.')
})

describe.each(CHAINS)('with no size at all, on %s', (chain, coin) => {
  it.each(['stake', 'supply', 'unstake'] as const)('asks how much to %s', (kind) => {
    const verb = kind === 'supply' ? 'deposit' : kind
    const route = chainRouteFromReading(
      reading({ action: kind, tokenIn: coin, tokenOut: coin, amountUsd: 0, amountStated: false }),
      `${kind} some ${coin}`,
      [`I want to ${verb} some ${coin.toLowerCase()}`],
      chain
    )
    expect(route).toMatchObject({
      question: `How much ${coin} do you want to ${verb}? Say a number, or "half" or "all".`,
    })
  })
})

describe('the answer to the question, as the model writes it out', () => {
  it('runs a stake once the person answers how much, even with a full stop', () => {
    const route = chainRouteFromReading(
      reading({ action: 'supply', tokenIn: 'NEAR', tokenOut: 'NEAR', amountUsd: 0.2 }),
      'Stake 0.2 NEAR.',
      ['I will like to stake a few near tokens', '0.2'],
      'near'
    )
    expect(route).toMatchObject({ action: { kind: 'stake', amount: '0.2', tokenIn: 'NEAR' } })
  })

  it('runs a swap once the person answers how much in a later message', () => {
    const route = chainRouteFromReading(
      reading({ action: 'swap', tokenIn: 'SOL', tokenOut: 'USDC', amountUsd: 0.05 }),
      'Swap 0.05 SOL to USDC.',
      ['swap some of my sol to usdc', '0.05'],
      'solana'
    )
    expect(route).toMatchObject({
      action: { kind: 'swap', amount: '0.05', tokenIn: 'SOL', tokenOut: 'USDC' },
    })
  })
})
