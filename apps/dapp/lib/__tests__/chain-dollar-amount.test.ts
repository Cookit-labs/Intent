import { describe, expect, it } from 'vitest'

import { sizedLine, sizeInUnits, unitsForDollars } from '../chains/dollar-amount'
import { dollarsOn, parseChainAction } from '../chains/parse-action'
import { chainRouteFromReading, readChainMessage, requestSaid } from '../chains/parse-sequence'
import { cashoutSequence, dollarsSaid } from '../chains/sequence-flow'
import { parseCashout, routeCashout } from '../weave/parse-cashout'

const reading = (over: object = {}) => ({
  action: 'swap',
  tokenIn: 'SOL',
  tokenOut: 'USDC',
  amountUsd: 1,
  amountStated: true,
  amountIsUsd: true,
  amountOf: 'sent' as const,
  followOn: { kind: 'offramp', venue: 'weave' },
  ...over,
})

describe('a figure in dollars never reads as that many tokens', () => {
  it.each([
    ['swap $5 SOL to USDC', 'swap'],
    ['supply $5 SOL', 'supply'],
    ['stake $5 SOL', 'stake'],
    ['send $5 SOL to abc.near', 'send'],
  ])('%s', (typed, kind) => {
    expect(parseChainAction(typed)).toMatchObject({ kind, amount: '5', amountIsUsd: true })
  })

  it('reads the same in a sequence', () => {
    const read = readChainMessage('swap $5 sol to usdc then cash out', 'solana', 'Solana')
    expect(read).toMatchObject({
      kind: 'sequence',
      request: { swap: { amount: '5', amountIsUsd: true } },
    })
  })

  it('takes dollars of USDC at face value', () => {
    expect(parseChainAction('swap $5 USDC to SOL')).toEqual({
      kind: 'swap',
      amount: '5',
      tokenIn: 'USDC',
      tokenOut: 'SOL',
      venue: undefined,
    })
  })

  it('does not mark a count of tokens as dollars', () => {
    expect(parseChainAction('swap 5 SOL to USDC')).not.toHaveProperty('amountIsUsd')
    expect(dollarsOn('deposit 5 SOL on $foo', 'SOL')).toEqual({})
  })

  it('reads a cash-out of dollars of a token as a sequence on a chain that can finish it', () => {
    expect(routeCashout(parseCashout('cash out $5 sol to kes'), 'solana')).toEqual({
      kind: 'sequence',
      token: 'SOL',
      amount: '5',
      amountIsUsd: true,
      currency: 'KES',
    })
    expect(
      cashoutSequence({ kind: 'sequence', token: 'SOL', amount: '5', amountIsUsd: true }).swap
    ).toMatchObject({ amount: '5', amountIsUsd: true })
  })

  it('leaves Stellar and chains that cannot finish it as they were', () => {
    expect(routeCashout(parseCashout('cash out $5 xlm'), 'stellar')).toEqual({ kind: 'pass' })
    expect(routeCashout(parseCashout('cash out $5 near'), 'monad')).toEqual({
      kind: 'token',
      token: 'NEAR',
    })
  })

  it('swaps $5 of NEAR to USDC first on NEAR, then off-ramps it', () => {
    expect(routeCashout(parseCashout('cash out $5 near'), 'near')).toEqual({
      kind: 'sequence',
      token: 'NEAR',
      amount: '5',
      amountIsUsd: true,
    })
  })
})

describe('dollarsSaid', () => {
  const said = (typed: string[], amount = '1', out?: string) =>
    dollarsSaid(amount, 'SOL', out, typed)

  it.each([
    'offramp $1 worth of solana',
    'offramp $1 of sol',
    'offramp $ 1 of my sol',
    'cash out 1 dollar of sol',
    '1 usd worth of solana to my bank',
    'cash out $1.00 sol',
    'sell sol worth $1',
  ])('finds %s', (typed) => {
    expect(said([typed])).toBe(true)
  })

  it.each([
    ['offramp 1 sol'],
    ['offramp $15 of sol'],
    ['offramp $0.1 of sol'],
    ['offramp $1,5 of sol'],
    ['offramp ₦1 of sol'],
    ['offramp 1000 naira worth of sol'],
    ['offramp $1 of usdt'],
    ['swap $1 usdc to sol'],
  ])('refuses %s', (typed) => {
    expect(said([typed])).toBe(false)
  })

  it('goes by the last figure said', () => {
    expect(said(['swap $5 of sol to usdc', 'actually $1'], '1', 'USDC')).toBe(true)
    expect(said(['swap $5 of sol to usdc', 'actually $1'], '5', 'USDC')).toBe(false)
    expect(said(['swap $1 of sol to usdc', 'no make it 2'], '1', 'USDC')).toBe(false)
  })

  it('wants the token received named after the token given up', () => {
    expect(said(['swap $1 of sol to usdc'], '1', 'USDC')).toBe(true)
    expect(said(['swap $1 of usdc to sol'], '1', 'USDC')).toBe(false)
    expect(said(['swap $1 to sol from usdc'], '1', 'USDC')).toBe(false)
  })

  it('is what requestSaid goes by for dollars', () => {
    const swap = {
      kind: 'swap' as const,
      amount: '1',
      tokenIn: 'SOL',
      tokenOut: 'USDC',
      venue: undefined,
      amountIsUsd: true as const,
    }
    expect(requestSaid(swap, ['offramp $1 worth of solana'], true)).toBe(true)
    expect(requestSaid(swap, ['offramp $1 worth of solana'])).toBe(false)
    expect(requestSaid(swap, ['offramp 1 solana'], true)).toBe(false)
  })
})

describe('chainRouteFromReading with dollars', () => {
  it('runs the sentence that was refused', () => {
    const route = chainRouteFromReading(reading(), 'Swap $1 of SOL to USDC, then cash out.', [
      'offramp $1 worth of solana',
    ])
    expect(route).toMatchObject({
      sequence: {
        swap: { amount: '1', tokenIn: 'SOL', amountIsUsd: true },
        followOn: { kind: 'cashout' },
      },
    })
  })

  it('refuses a dollar figure the person never typed', () => {
    const route = chainRouteFromReading(reading({ amountUsd: 500 }), 'Swap $500 of SOL to USDC.', [
      'offramp $1 worth of solana',
    ])
    expect(route).toHaveProperty('refusal')
  })

  it('refuses dollars the person said in tokens', () => {
    const route = chainRouteFromReading(reading(), 'Swap $1 of SOL to USDC.', ['offramp 1 sol'])
    expect(route).toHaveProperty('refusal')
  })

  it('runs a plain swap in dollars', () => {
    const five = chainRouteFromReading(
      reading({ followOn: null, amountUsd: 5 }),
      'Swap $5 of SOL to USDC.',
      ['swap $5 of sol to usdc']
    )
    expect(five).toMatchObject({ action: { amount: '5', amountIsUsd: true } })
  })
})

describe('unitsForDollars', () => {
  it('divides by the price and rounds down, so it never spends more than was said', () => {
    expect(unitsForDollars('1', 96.66, 9)).toBe('0.01034554')
    expect(unitsForDollars('5', 2, 9)).toBe('2.5')
  })

  it('keeps to what the token can hold', () => {
    expect(unitsForDollars('1', 3, 6)).toBe('0.333333')
  })

  it('gives nothing for a sum too small to hold, or a bad price', () => {
    expect(unitsForDollars('0.000001', 100000, 6)).toBeUndefined()
    expect(unitsForDollars('1', 0, 9)).toBeUndefined()
    expect(unitsForDollars('0', 5, 9)).toBeUndefined()
  })
})

describe('sizeInUnits', () => {
  const swap = {
    kind: 'swap' as const,
    amount: '1',
    tokenIn: 'SOL',
    tokenOut: 'USDC',
    venue: undefined,
    amountIsUsd: true as const,
  }
  const answers = (status: number, body: unknown) => async () => ({
    status,
    json: async () => body,
  })

  it('swaps the dollars for a count of tokens, with no mark left on it', async () => {
    const out = await sizeInUnits('solana', swap, answers(200, { priceUsd: 96.66, decimals: 9 }))
    expect(out).toEqual({
      request: {
        kind: 'swap',
        amount: '0.01034554',
        tokenIn: 'SOL',
        tokenOut: 'USDC',
        venue: undefined,
      },
      line: sizedLine('1', 'SOL', 96.66, '0.01034554'),
    })
  })

  it('takes USDC at a dollar, asking nothing', async () => {
    const asked = () => {
      throw new Error('should not read a price')
    }
    await expect(sizeInUnits('solana', { ...swap, tokenIn: 'USDC' }, asked)).resolves.toMatchObject(
      {
        request: { amount: '1' },
      }
    )
  })

  it.each([
    ['no price', answers(503, { error: 'price_unavailable' })],
    ['an unknown token', answers(404, { error: 'unknown_token' })],
    ['a nonsense price', answers(200, { priceUsd: -1, decimals: 9 })],
    ['a missing decimals', answers(200, { priceUsd: 5 })],
    [
      'a failed read',
      async () => {
        throw new Error('down')
      },
    ],
  ])('refuses on %s, and never guesses', async (_, reader) => {
    const out = await sizeInUnits('solana', swap, reader)
    expect(out).toHaveProperty('refusal')
    expect((out as { refusal: string }).refusal).toContain('Nothing was signed or sent.')
  })
})
