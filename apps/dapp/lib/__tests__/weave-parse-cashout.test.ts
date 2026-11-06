import { describe, expect, it } from 'vitest'

import { cashoutStarts } from '../chains/parse-sequence'
import { unsupportedTokenReply } from '../weave/cashout-view'
import { parseCashout, parseCurrencyAnswer, routeCashout } from '../weave/parse-cashout'
import { closedCashoutReply } from '../weave/types'

describe('parseCurrencyAnswer', () => {
  it.each([
    ['KES', 'KES'],
    ['kes', 'KES'],
    ['Kenya', 'KES'],
    ['Kenyan shillings', 'KES'],
    ['to kenya', 'KES'],
    ['in KES please', 'KES'],
    ['kenyan', 'KES'],
    ['naira', 'NGN'],
    ['Nigeria.', 'NGN'],
    ['nigerian', 'NGN'],
    ['uganda', 'UGX'],
    ['UGX', 'UGX'],
    ['tanzania', 'TZS'],
    ['tanzanian shilling', 'TZS'],
  ])('reads %s', (text, currency) => {
    expect(parseCurrencyAnswer(text)).toEqual({ currency })
  })

  it.each([
    ['ghana', 'GHS'],
    ['USD', 'USD'],
    ['euros', 'EUR'],
  ])('says %s is a currency it cannot pay', (text, unsupported) => {
    expect(parseCurrencyAnswer(text)).toEqual({ unsupported })
  })

  it.each(['shillings', 'swap 5 xlm to usdc', 'what can you do', 'yes', ''])(
    'does not read %j as an answer',
    (text) => {
      expect(parseCurrencyAnswer(text)).toBeNull()
    }
  )
})

describe('parseCashout', () => {
  it.each([
    ['cash out 25 usdc', { amount: '25', token: 'USDC' }],
    ['Cash out 25 USDC.', { amount: '25', token: 'USDC' }],
    ['please cash out 25 usdc', { amount: '25', token: 'USDC' }],
    ['cash out 25 usdc to kes', { amount: '25', token: 'USDC', currency: 'KES' }],
    ['cashout 25 usdc to kes', { amount: '25', token: 'USDC', currency: 'KES' }],
    ['cash-out 25 usdc to kes', { amount: '25', token: 'USDC', currency: 'KES' }],
    ['withdraw 25 usdc to kenya', { amount: '25', token: 'USDC', currency: 'KES' }],
    ['off-ramp 10 usdc to uganda', { amount: '10', token: 'USDC', currency: 'UGX' }],
    ['offramp 10 usdc to ugx', { amount: '10', token: 'USDC', currency: 'UGX' }],
    ['sell 25 usdc for naira', { amount: '25', token: 'USDC', currency: 'NGN' }],
    ['cash out 25 usdc to nigeria', { amount: '25', token: 'USDC', currency: 'NGN' }],
    ['cash out 25 usdc to tanzanian shillings', { amount: '25', token: 'USDC', currency: 'TZS' }],
    ['cash out to tanzania', { token: 'USDC', currency: 'TZS' }],
    ['cash out', { token: 'USDC' }],
    ['cash out my usdc to my kes', { token: 'USDC', currency: 'KES' }],
    ['cash out usdc', { token: 'USDC' }],
    ['cash out $25', { amount: '25', token: 'USDC' }],
    ['cash out $25 to kes', { amount: '25', token: 'USDC', currency: 'KES' }],
  ])('reads %s', (text, expected) => {
    expect(parseCashout(text)).toEqual(expected)
  })

  it.each([
    ['offramp4 usd', { amount: '4', token: 'USDC' }],
    ['offramp 4 usd', { amount: '4', token: 'USDC' }],
    ['off-ramp4 usdc', { amount: '4', token: 'USDC' }],
    ['cash out4 usdc to kes', { amount: '4', token: 'USDC', currency: 'KES' }],
    ['offramp$4', { amount: '4', token: 'USDC' }],
    ['cash out 25 dollars', { amount: '25', token: 'USDC' }],
    ['cash out 1 dollar', { amount: '1', token: 'USDC' }],
    ['cash out 25 usd to kes', { amount: '25', token: 'USDC', currency: 'KES' }],
  ])('reads %s, where a dollar amount means USDC', (text, expected) => {
    expect(parseCashout(text)).toEqual(expected)
  })

  it.each([
    ['cash out 3 usdc to my bank', { amount: '3', token: 'USDC' }],
    ['withdraw 3 usdc to my bank account', { amount: '3', token: 'USDC' }],
    ['off-ramp 3 usdc to fiat', { amount: '3', token: 'USDC' }],
    ['cash out usdc to my bank', { token: 'USDC' }],
  ])('reads %s as naming no currency', (text, expected) => {
    expect(parseCashout(text)).toEqual(expected)
  })

  it.each([
    ['cash out 1,000 usdc', '1000'],
    ['cash out 1,250,000.50 usdc', '1250000.50'],
    ['cash out .5 usdc', '0.5'],
    ['cash out 0.25 usdc', '0.25'],
  ])('reads the amount in %s', (text, amount) => {
    expect(parseCashout(text)).toEqual({ amount, token: 'USDC' })
  })

  it.each([
    ['cash out 5 sol', 'SOL'],
    ['withdraw 5 xlm to kenya', 'XLM'],
    ['cash out sol', 'SOL'],
    ['cash out 5 usdc.e', 'USDC.E'],
    ['cash out 5 usdt', 'USDT'],
  ])('names the other token in %s', (text, token) => {
    expect(parseCashout(text)).toMatchObject({ unsupportedToken: token })
  })

  it('keeps the currency beside an unsupported token', () => {
    expect(parseCashout('cash out 5 xlm to kes')).toEqual({
      unsupportedToken: 'XLM',
      amount: '5',
      currency: 'KES',
    })
    expect(parseCashout('cash out 5 sol')).toEqual({ unsupportedToken: 'SOL', amount: '5' })
    expect(parseCashout('cash out sol')).toEqual({ unsupportedToken: 'SOL' })
  })

  it.each([
    ['cash out 25 usdc to brl', 'BRL'],
    ['cash out to brazil', 'BRL'],
    ['withdraw 25 usdc to ghana', 'GHS'],
    ['sell 25 usdc for euros', 'EUR'],
    ['cash out 25 usdc to usd', 'USD'],
  ])('refuses the currency in %s rather than guessing', (text, currency) => {
    expect(parseCashout(text)).toEqual({ unsupportedCurrency: currency })
  })

  it.each([
    'swap 25 usdc to sol',
    'send 25 usdc to bob',
    'cash out 25 usdc to bob',
    'withdraw 25 usdc to bob',
    'sell 25 usdc for sol',
    'cash out 25 usdc to sol',
    'cash out 25 usdc to kes and swap the rest',
    'cash out 25 usdc to shillings',
    'how do i cash out',
    'what is a cash out',
    'cash outs',
    'cash out now',
    'cash out everything',
    'cash out all my usdc',
    'cash out 25',
    'cash out 25 to kes',
    'cash out 5000 naira',
    'cash out usd',
    'cash out dollars',
    'offramping 4 usdc',
    'cash outfit',
    'cash out kes',
    'cash out 0 usdc',
    'cash out 1,00 usdc',
    'cash out 1.2.3 usdc',
    'cash out -5 usdc',
    'withdraw',
    'withdraw 25 usdc',
    'sell',
    'sell 25 usdc',
    'sell 25 sol',
    '',
  ])('leaves %j alone', (text) => {
    expect(parseCashout(text)).toBeNull()
  })
})

describe('routeCashout', () => {
  const read = (text: string): ReturnType<typeof parseCashout> => parseCashout(text)

  it.each(['solana', 'sui', 'avalanche', 'stellar'])(
    'asks which currency on %s when none is named',
    (chain) => {
      expect(routeCashout(read('off-ramp 3 USDC'), chain)).toEqual({ kind: 'ask', amount: '3' })
      expect(routeCashout(read('cash out'), chain)).toEqual({ kind: 'ask' })
      expect(routeCashout(read('cash out 3 usdc to my bank'), chain)).toEqual({
        kind: 'ask',
        amount: '3',
      })
    }
  )

  it('keeps the test anchor flow on stellar testnet, where no real cash-out runs', () => {
    expect(routeCashout(read('off-ramp 3 USDC'), 'stellar', false)).toEqual({ kind: 'pass' })
  })

  it('still asks on other chains when the page is on stellar testnet', () => {
    expect(routeCashout(read('off-ramp 3 USDC'), 'sui', false)).toEqual({
      kind: 'ask',
      amount: '3',
    })
  })

  it.each(['solana', 'sui', 'avalanche'])('opens the card on %s', (chain) => {
    expect(routeCashout(read('cash out 25 usdc to kes'), chain)).toEqual({
      kind: 'open',
      amount: '25',
      currency: 'KES',
    })
    expect(routeCashout(read('sell 25 usdc for naira'), chain)).toEqual({
      kind: 'open',
      amount: '25',
      currency: 'NGN',
    })
  })

  it("runs the person's own sentence, reading the chain name as its token", () => {
    expect(routeCashout(parseCashout('Offramp 0.01477 solana'), 'solana')).toEqual({
      kind: 'sequence',
      token: 'SOL',
      amount: '0.01477',
    })
    expect(routeCashout(parseCashout('cash out 5 avalanche to kes'), 'avalanche')).toEqual({
      kind: 'sequence',
      token: 'AVAX',
      amount: '5',
      currency: 'KES',
    })
  })

  it('changes nothing on Stellar for a chain name', () => {
    expect(routeCashout(parseCashout('Offramp 0.01477 solana'), 'stellar')).toEqual({
      kind: 'pass',
    })
    expect(routeCashout(parseCashout('Offramp 0.01477 solana to kes'), 'stellar')).toEqual({
      kind: 'token',
      token: 'SOLANA',
    })
  })

  it('leaves what the parser reads, and a refusal elsewhere, as they were', () => {
    expect(parseCashout('Offramp 0.01477 solana')).toEqual({
      unsupportedToken: 'SOLANA',
      amount: '0.01477',
    })
    expect(routeCashout(parseCashout('cash out 5 solana'), 'near')).toEqual({
      kind: 'token',
      token: 'SOLANA',
    })
  })

  it.each(['solana', 'sui', 'avalanche'])('answers refusals on %s', (chain) => {
    expect(routeCashout(read('cash out sol'), chain)).toEqual({ kind: 'token', token: 'SOL' })
    expect(routeCashout(read('cash out 5 usdc to brl'), chain)).toEqual({
      kind: 'currency',
      currency: 'BRL',
    })
  })

  it.each(['KES', 'UGX', 'TZS'])('opens the card on stellar for %s', (currency) => {
    expect(routeCashout(read(`cash out 25 usdc to ${currency}`), 'stellar')).toEqual({
      kind: 'open',
      amount: '25',
      currency,
    })
  })

  it.each([
    'cash out 25 usdc to ngn',
    'sell 25 usdc for naira',
    'cash out 5 xlm',
    'cash out 5 xlm to naira',
    'cash out 25 usdc to brl',
  ])('leaves %s to the existing path on stellar', (text) => {
    expect(routeCashout(read(text), 'stellar')).toEqual({ kind: 'pass' })
  })

  it('tells stellar a Weave currency takes USDC', () => {
    expect(routeCashout(read('cash out 5 xlm to kes'), 'stellar')).toEqual({
      kind: 'token',
      token: 'XLM',
    })
  })

  it('changes nothing on a chain with no cash-out and nothing to say about it', () => {
    expect(routeCashout(read('cash out 25 usdc to kes'), 'arc')).toEqual({ kind: 'pass' })
    expect(routeCashout(read('cash out 5 sol'), 'arc')).toEqual({ kind: 'pass' })
  })

  describe.each(['near', 'monad'])('on %s, which is closed', (chain) => {
    it.each([
      'cash out',
      'off-ramp 3 USDC',
      'cash out 25 usdc to kes',
      'sell 25 usdc for naira',
      'withdraw 25 usdc to my bank',
    ])('opens no form for "%s"', (text) => {
      const route = routeCashout(read(text), chain)
      expect(route).toEqual({ kind: 'token', token: 'USDC' })
      expect(cashoutStarts(route)).toBe(false)
    })

    it('answers a token or a currency it would not pay the same way', () => {
      expect(routeCashout(read('cash out 5 sol'), chain)).toEqual({ kind: 'token', token: 'SOL' })
      expect(routeCashout(read('cash out 5 usdc to brl'), chain)).toEqual({
        kind: 'token',
        token: 'USDC',
      })
    })

    it('says plainly what to do, whatever was named', () => {
      for (const token of ['USDC', 'SOL']) {
        const reply = unsupportedTokenReply(token, chain)
        expect(reply).toBe(closedCashoutReply(chain))
        expect(reply).toMatch(/move your USDC to Solana, Avalanche or Sui/)
        expect(reply).toMatch(/has not paid out a real order/)
        expect(reply).toMatch(/ Nothing was signed or sent\.$/)
        expect(reply).not.toMatch(/Swap your/)
      }
    })

    it('leaves what was not a cash-out alone', () => {
      expect(routeCashout(read('swap 5 sol to usdc'), chain)).toEqual({ kind: 'pass' })
    })
  })

  it.each(['stellar', 'solana', 'sui', 'avalanche', 'arc'])('does not close %s', (chain) => {
    expect(closedCashoutReply(chain)).toBeUndefined()
  })

  it('passes what was not a cash-out', () => {
    expect(routeCashout(null, 'near')).toEqual({ kind: 'pass' })
  })
})
