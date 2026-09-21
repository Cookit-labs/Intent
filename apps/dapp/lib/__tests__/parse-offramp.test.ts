import { describe, expect, it } from 'vitest'

import { parseCompoundIntent, parseOfframpOnlyIntent } from '../parse-compound'

/**
 * Reading "to my bank" out of free text.
 *
 * Narrow on purpose, like the lending parser beside it. "Send XLM to my
 * friend" names no fiat and no anchor and is not an offramp; a marker that
 * matched anything with "send" in it would turn ordinary payments into
 * withdrawals.
 */

const PRICES = { XLM: 0.18, USDC: 1 }

describe('parseCompoundIntent with an offramp follow-on', () => {
  it.each([
    'Sell 60 XLM and send the dollars to my bank',
    'Swap 60 XLM to USDC then cash out',
    'Sell 60 XLM for USDC and withdraw it to my bank account',
    'Sell 60 XLM, then off-ramp it',
    'Sell 60 XLM and offramp to fiat',
  ])('reads %j as swap then offramp', (text) => {
    const c = parseCompoundIntent(text, PRICES)
    expect(c?.followOn).toEqual({ kind: 'offramp', venue: 'testanchor' })
    expect(c?.head.input.tokenIn).toBe('XLM')
  })

  it('names the anchor when the text does', () => {
    const c = parseCompoundIntent('Sell 60 XLM and cash out through MoneyGram', PRICES)
    expect(c?.followOn).toEqual({ kind: 'offramp', venue: 'moneygram' })
  })

  it('refuses an offramp through somewhere the app does not integrate', () => {
    expect(parseCompoundIntent('Sell 60 XLM and cash out via Coinbase', PRICES)).toBeNull()
  })

  it('prefers offramp over lending when the bank is named', () => {
    // "put it in" is lending phrasing; "my bank" decides.
    const c = parseCompoundIntent('Sell 60 XLM and put it in my bank', PRICES)
    expect(c?.followOn.kind).toBe('offramp')
  })

  it('still reads a lend follow-on as a lend', () => {
    const c = parseCompoundIntent('Buy XLM with 20 USDC then supply it to Blend', PRICES)
    expect(c?.followOn.kind).toBe('lend')
  })

  it('does not read a payment to a person as an offramp', () => {
    expect(parseCompoundIntent('Sell 60 XLM and send it to my friend', PRICES)).toBeNull()
  })
})

describe('parseOfframpOnlyIntent', () => {
  it.each([
    ['Withdraw 5 USDC to my bank', '5'],
    ['Cash out 5 USDC', '5'],
    ['Offramp 5 USDC to fiat', '5'],
    ['Send $5 of USDC to my bank account', '5'],
  ])('reads %j as an offramp of %s USDC', (text, amount) => {
    expect(parseOfframpOnlyIntent(text)).toEqual({
      kind: 'offramp-only',
      asset: 'USDC',
      amount,
      venue: 'testanchor',
    })
  })

  it('reads the whole balance', () => {
    expect(parseOfframpOnlyIntent('Withdraw all my USDC to my bank')).toEqual({
      kind: 'offramp-only',
      asset: 'USDC',
      venue: 'testanchor',
    })
  })

  it('names the anchor', () => {
    expect(parseOfframpOnlyIntent('Cash out 5 USDC through MoneyGram')?.venue).toBe('moneygram')
  })

  it('refuses an asset the anchors do not withdraw', () => {
    expect(parseOfframpOnlyIntent('Withdraw 5 XLM to my bank')).toBeNull()
  })

  it('refuses when a trade is asked for', () => {
    // That is a compound intent, and the other parser's job.
    expect(parseOfframpOnlyIntent('Sell 60 XLM and send the dollars to my bank')).toBeNull()
  })

  it('refuses a Blend withdrawal', () => {
    // "withdraw" alone is ambiguous with taking a supply back out of Blend.
    expect(parseOfframpOnlyIntent('Withdraw my USDC from Blend')).toBeNull()
  })

  it('refuses text with no offramp phrasing', () => {
    expect(parseOfframpOnlyIntent('Buy 5 USDC')).toBeNull()
  })
})
