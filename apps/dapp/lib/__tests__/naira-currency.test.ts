import { describe, expect, it } from 'vitest'

import {
  detectPayout,
  preselectPayoutPath,
  readPayoutSource,
  unsupportedCurrencyMessage,
} from '../naira/currency'

describe('detectPayout', () => {
  it.each([
    'Swap $5 worth of XLM to naira',
    'cash out 10 XLM to NGN',
    'withdraw 20 XLM to my Nigerian bank',
    'convert euros to naira',
    'send 5 XLM into naira',
  ])('reads %j as a naira payout', (text) => {
    expect(detectPayout(text)).toEqual({ kind: 'ngn' })
  })

  it.each([
    ['swap $5 of XLM to euros', 'Euros'],
    ['withdraw my XLM to my bank in euros', 'Euros'],
    ['cash out 10 XLM to pounds', 'British pounds'],
    ['send 5 XLM to cedis', 'Ghanaian cedis'],
    ['withdraw to dollars in my bank', 'US dollars'],
    ['cash out my XLM to USD', 'US dollars'],
  ])('refuses %j and names the currency', (text, currency) => {
    expect(detectPayout(text)).toEqual({ kind: 'unsupported', currency })
  })

  it.each([
    'Swap 20 USDC to XLM',
    'swap XLM to USDC',
    'swap XLM to USD',
    'withdraw 2 USDC to my bank',
    'supply my XLM to Blend',
  ])('leaves %j to the normal flow', (text) => {
    expect(detectPayout(text)).toEqual({ kind: 'none' })
  })
})

describe('unsupportedCurrencyMessage', () => {
  it('says what is not supported and lists what is', () => {
    expect(unsupportedCurrencyMessage('Euros')).toBe(
      'Payouts to Euros are not supported. Supported currency: Nigerian naira (NGN).'
    )
  })
})

describe('readPayoutSource', () => {
  it('sizes a dollar figure at the live XLM price', () => {
    expect(readPayoutSource('Swap $5 worth of XLM to naira', 0.1)).toEqual({
      kind: 'xlm',
      amountXlm: 50,
    })
  })

  it('takes a stated XLM amount as is', () => {
    expect(readPayoutSource('cash out 12.5 XLM to naira', 0.1)).toEqual({
      kind: 'xlm',
      amountXlm: 12.5,
    })
  })

  it('leaves the amount for the form when none was given or no price is known', () => {
    expect(readPayoutSource('cash out my XLM to naira', 0.1)).toEqual({ kind: 'xlm' })
    expect(readPayoutSource('swap $5 of XLM to naira', undefined)).toEqual({ kind: 'xlm' })
  })

  it('refuses another asset by name', () => {
    expect(readPayoutSource('cash out 10 USDC to naira', 0.1)).toEqual({
      kind: 'other',
      asset: 'USDC',
    })
  })
})

describe('preselectPayoutPath', () => {
  it.each(['swap $30 worth of XLM to naira', 'convert 100 XLM to naira', 'Exchange my XLM to NGN'])(
    'opens %j on convert-first',
    (text) => {
      expect(preselectPayoutPath(text)).toBe('usdc')
    }
  )

  it.each([
    'cash out 100 XLM to naira',
    'withdraw $30 of XLM to my Nigerian bank',
    'offramp 50 XLM to naira',
    'send 50 XLM to naira',
  ])('opens %j on the direct route', (text) => {
    expect(preselectPayoutPath(text)).toBe('xlm')
  })

  it('lets a cash-out cue win over a swap word', () => {
    expect(preselectPayoutPath('swap my XLM and withdraw to my bank in naira')).toBe('xlm')
  })
})
