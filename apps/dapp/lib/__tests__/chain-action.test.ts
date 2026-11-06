import { describe, expect, it } from 'vitest'

import { chainTokenWord, looksLikeChainAction, parseChainAction } from '../chains/parse-action'
import { prepareChainAction } from '../chains/prepare'
import { chainModule } from '../chains/registry'
import {
  ChainActionRefused,
  toBaseUnits,
  type ChainModule,
  type PreparedAction,
} from '../chains/types'

describe('parseChainAction', () => {
  it('reads a swap', () => {
    expect(parseChainAction('Swap 50 USDC to SOL')).toMatchObject({
      kind: 'swap',
      amount: '50',
      tokenIn: 'USDC',
      tokenOut: 'SOL',
    })
  })

  it('reads a named venue and thousands separators', () => {
    expect(parseChainAction('please convert 1,000.5 usdc into usdt on cetus.')).toMatchObject({
      amount: '1000.5',
      tokenOut: 'usdt',
      venue: 'cetus',
    })
  })

  it('writes a bare decimal the way the build route and base units accept it', () => {
    const amount = parseChainAction('swap .5 USDC to SOL')?.amount as string
    expect(amount).toBe('0.5')
    expect(toBaseUnits(amount, 6)).toBe('500000')
    expect(parseChainAction('supply $.25 USDC')?.amount).toBe('0.25')
    expect(parseChainAction('stake .1 NEAR')?.amount).toBe('0.1')
  })

  it.each([
    ['5', '5'],
    ['0.5', '0.5'],
    ['1,000', '1000'],
    ['1,000.5', '1000.5'],
    ['$20', '20'],
  ])('keeps %s as it read before', (typed, amount) => {
    expect(parseChainAction(`swap ${typed} USDC to SOL`)?.amount).toBe(amount)
  })

  it('reads a supply and a stake', () => {
    expect(parseChainAction('supply 100 USDC on Kamino')).toMatchObject({
      kind: 'supply',
      tokenIn: 'USDC',
      venue: 'Kamino',
    })
    expect(parseChainAction('stake 2 NEAR with rNEAR')).toMatchObject({
      kind: 'stake',
      tokenIn: 'NEAR',
      venue: 'rNEAR',
    })
  })

  it.each([
    '1,5',
    '0,5',
    '1,50',
    '10,00',
    '1,0000',
    ',5',
    '1,,000',
    '1000,000',
    '0,500',
    '0,050',
    '0,005',
    '00,500',
    '01,000',
  ])('reads no amount from %s, on any kind', (amount) => {
    expect(parseChainAction(`send ${amount} USDC to bob.near`)).toBeNull()
    expect(parseChainAction(`swap ${amount} USDC to SOL`)).toBeNull()
    expect(parseChainAction(`supply ${amount} USDC`)).toBeNull()
    expect(parseChainAction(`stake ${amount} SUI`)).toBeNull()
  })

  it.each([
    ['1,000', '1000'],
    ['1,000.5', '1000.5'],
    ['1,500', '1500'],
    ['12,345,678', '12345678'],
    ['.5', '0.5'],
    ['05', '5'],
    ['007.5', '7.5'],
    ['0.5', '0.5'],
    ['0', '0'],
  ])('reads %s as %s', (typed, amount) => {
    expect(parseChainAction(`send ${typed} USDC to bob.near`)?.amount).toBe(amount)
    expect(parseChainAction(`stake ${typed} SUI`)?.amount).toBe(amount)
  })

  it('does not guess at anything looser', () => {
    expect(parseChainAction('what is my balance?')).toBeNull()
    expect(parseChainAction('swap all my USDC')).toBeNull()
    expect(parseChainAction('swap 50 USDC to SOL and send it to bob')).toBeNull()
    expect(parseChainAction('I will not swap 50 USDC to SOL')).toBeNull()
  })

  it('tells action sentences from questions', () => {
    expect(looksLikeChainAction('swap all my USDC')).toBe(true)
    expect(looksLikeChainAction('what is Solana?')).toBe(false)
  })
})

describe('toBaseUnits', () => {
  it('scales without floating point', () => {
    expect(toBaseUnits('1.5', 6)).toBe('1500000')
    expect(toBaseUnits('0.000001', 6)).toBe('1')
    expect(toBaseUnits('100000000000.1', 24)).toBe('100000000000100000000000000000000000')
  })

  it('refuses what it cannot represent', () => {
    expect(() => toBaseUnits('1.1234567', 6)).toThrow(ChainActionRefused)
    expect(() => toBaseUnits('0', 6)).toThrow(ChainActionRefused)
    expect(() => toBaseUnits('abc', 6)).toThrow(ChainActionRefused)
  })
})

describe('chainModule', () => {
  it('finds only chains that use this path', () => {
    expect(chainModule('solana')?.chain).toBe('solana')
    expect(chainModule('stellar')).toBeUndefined()
    expect(chainModule('constructor')).toBeUndefined()
  })
})

describe('prepareChainAction', () => {
  const prepared: PreparedAction = {
    venueId: 'a',
    venueName: 'A',
    kind: 'swap',
    summary: 's',
    pay: { amount: '1', symbol: 'USDC' },
    notes: [],
    signing: { family: 'solana', transaction: 'x' },
  }
  const usdc = { symbol: 'USDC', id: 'u', decimals: 6 }
  const sol = { symbol: 'SOL', id: 's', decimals: 9 }

  function moduleWith(
    overrides: Partial<ChainModule> = {},
    assertSafe: () => void = () => undefined
  ) {
    return {
      chain: 'solana',
      tokens: [usdc, sol],
      venues: [
        {
          id: 'a',
          name: 'Alpha',
          kinds: ['swap'],
          prepare: async () => prepared,
          assertSafe,
        },
      ],
      defaultVenue: { swap: 'a' },
      priceUsd: async () => 1,
      submit: async () => ({ ok: false, error: 'no' }),
      ...overrides,
    } as ChainModule
  }

  const swap = { kind: 'swap', amount: '10', tokenIn: 'usdc', tokenOut: 'SOL' } as const

  it('prepares a valid action', async () => {
    await expect(prepareChainAction(moduleWith(), swap, 'acct', {})).resolves.toBe(prepared)
  })

  it('refuses a token it does not know', async () => {
    await expect(
      prepareChainAction(moduleWith(), { ...swap, tokenOut: 'SCAM' }, 'acct', {})
    ).rejects.toThrow(/verified token/)
  })

  it('refuses a trade it cannot price, even when the Stellar default is testnet', async () => {
    await expect(
      prepareChainAction(moduleWith({ priceUsd: async () => undefined }), swap, 'acct', {})
    ).rejects.toThrow(/could not be valued/)
  })

  it('refuses a trade over the cap', async () => {
    await expect(
      prepareChainAction(moduleWith(), { ...swap, amount: '501' }, 'acct', {})
    ).rejects.toThrow(/caps each trade/)
  })

  it('refuses a venue that cannot do this', async () => {
    await expect(
      prepareChainAction(moduleWith(), { ...swap, venue: 'nope' }, 'acct', {})
    ).rejects.toThrow(/can't swap here/)
  })

  it('never hands over a payload that fails the safety check', async () => {
    const unsafe = (): void => {
      throw new ChainActionRefused('unexpected program')
    }
    await expect(prepareChainAction(moduleWith({}, unsafe), swap, 'acct', {})).rejects.toThrow(
      /unexpected program/
    )
  })
})

describe('chainTokenWord', () => {
  it.each([
    ['solana', 'SOL'],
    ['Solana', 'SOL'],
    ['SOLANA', 'SOL'],
    ['avalanche', 'AVAX'],
    ['AVALANCHE', 'AVAX'],
    ['monad', 'MON'],
    ['Monad', 'MON'],
  ])('reads %s as %s', (word, token) => {
    expect(chainTokenWord(word)).toBe(token)
  })

  it.each(['solanax', 'xsolana', 'solana ', 'sol', 'SOL', 'sui', 'near', 'usdc', 'USDC', ''])(
    'leaves %j as it is',
    (word) => {
      expect(chainTokenWord(word)).toBe(word)
    }
  )

  it.each(['constructor', 'toString', '__proto__'])('finds nothing inherited in %s', (word) => {
    expect(chainTokenWord(word)).toBe(word)
  })
})

describe('parseChainAction on a chain name', () => {
  it('reads it as the token on every kind, in or out', () => {
    expect(parseChainAction('swap 1 avalanche to usdc')).toMatchObject({
      tokenIn: 'AVAX',
      tokenOut: 'usdc',
    })
    expect(parseChainAction('swap 1 monad to usdc')).toMatchObject({ tokenIn: 'MON' })
    expect(parseChainAction('swap 1 usdc to Solana')).toMatchObject({ tokenOut: 'SOL' })
    expect(parseChainAction('supply 1 solana')).toMatchObject({ kind: 'supply', tokenIn: 'SOL' })
    expect(parseChainAction('stake 1 solana')).toMatchObject({ kind: 'stake', tokenIn: 'SOL' })
  })

  it('leaves a venue that names a chain as it is', () => {
    expect(parseChainAction('swap 1 sol to usdc on solana')).toMatchObject({
      tokenIn: 'sol',
      venue: 'solana',
    })
  })
})
