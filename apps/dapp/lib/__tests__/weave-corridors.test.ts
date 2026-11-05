import { describe, expect, it } from 'vitest'

import { cashOutPrompt, CORRIDORS, isCurrencyAllowed, liveCurrencies } from '../weave/corridors'

describe('cashOutPrompt', () => {
  const live = { WEAVE_SECRET_KEY: 'sk', WEAVE_CASHOUT_CURRENCIES: 'NGN,KES,UGX,TZS' }

  it('tells the model to ask and lists each currency', () => {
    const prompt = cashOutPrompt('sui', live)
    expect(prompt).toMatch(/never assume/i)
    expect(prompt).toMatch(/ask which/i)
    for (const name of ['NGN', 'KES', 'UGX', 'TZS']) expect(prompt).toContain(name)
  })

  it('lists naira on stellar, which Linq pays, even when Weave only has the others', () => {
    const prompt = cashOutPrompt('stellar', { ...live, WEAVE_CASHOUT_CURRENCIES: 'KES' })
    expect(prompt).toContain('NGN')
    expect(prompt).toContain('KES')
  })

  it('says stellar pays only naira when Weave is not set up', () => {
    const prompt = cashOutPrompt('stellar', {})
    expect(prompt).toMatch(/only to Nigerian naira/)
    expect(prompt).not.toContain('KES')
  })

  it('names nothing where no cash-out exists', () => {
    expect(cashOutPrompt('sui', {})).toBe('')
    expect(cashOutPrompt('arc', live)).toBe('')
    expect(cashOutPrompt('monad', live)).toBe('')
  })
})

describe('liveCurrencies', () => {
  it('is naira only when nothing is set, since no other payout has been tested', () => {
    expect(liveCurrencies({})).toEqual(['NGN'])
    expect(liveCurrencies({ WEAVE_CASHOUT_CURRENCIES: '  ' })).toEqual(['NGN'])
  })

  it('reads a comma list and tolerates spaces and case', () => {
    expect(liveCurrencies({ WEAVE_CASHOUT_CURRENCIES: 'kes, ugx ,TZS' })).toEqual([
      'KES',
      'UGX',
      'TZS',
    ])
  })

  it('ignores anything outside the four known and lists each once', () => {
    expect(liveCurrencies({ WEAVE_CASHOUT_CURRENCIES: 'BRL,KES,KES,<x>' })).toEqual(['KES'])
  })

  it('opens nothing when the list names nothing known, rather than falling back', () => {
    expect(liveCurrencies({ WEAVE_CASHOUT_CURRENCIES: 'BRL' })).toEqual([])
  })
})

describe('isCurrencyAllowed', () => {
  const all = { WEAVE_CASHOUT_CURRENCIES: 'NGN,KES,UGX,TZS' }

  it('keeps Stellar naira on the existing Linq flow', () => {
    expect(isCurrencyAllowed('stellar', 'NGN', all)).toBe(false)
    expect(isCurrencyAllowed('stellar', 'KES', all)).toBe(true)
    expect(isCurrencyAllowed('solana', 'NGN', all)).toBe(true)
  })

  it('refuses a currency that is known but not live', () => {
    expect(isCurrencyAllowed('near', 'KES', {})).toBe(false)
    expect(isCurrencyAllowed('near', 'NGN', {})).toBe(true)
  })

  it('refuses a currency it does not know', () => {
    expect(isCurrencyAllowed('near', 'BRL', { WEAVE_CASHOUT_CURRENCIES: 'BRL' })).toBe(false)
  })

  it('leaves Stellar with nothing by default', () => {
    expect(isCurrencyAllowed('stellar', 'NGN', {})).toBe(false)
    expect(isCurrencyAllowed('stellar', 'KES', {})).toBe(false)
  })
})

describe('CORRIDORS', () => {
  it('names each country and symbol', () => {
    expect(CORRIDORS.NGN).toEqual({
      code: 'NGN',
      name: 'Nigerian naira',
      country: 'Nigeria',
      symbol: '₦',
    })
    expect(CORRIDORS.KES.country).toBe('Kenya')
    expect(CORRIDORS.UGX.country).toBe('Uganda')
    expect(CORRIDORS.TZS.country).toBe('Tanzania')
  })
})
