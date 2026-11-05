import { describe, expect, it } from 'vitest'

import { looksLikeChainAction, parseChainAction } from '../chains/parse-action'
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
