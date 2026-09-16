import { describe, expect, it } from 'vitest'

import { parseCompoundIntent } from '../parse-compound'
import { parseIntent } from '../parse-intent'

/**
 * Reading an intent that asks for two things in order.
 *
 * Two failures are being fixed here, and the second is the nastier one. The
 * obvious failure is that a second clause was dropped. The hidden one is that
 * `detectType` matches keywords anywhere in the string, so the dropped clause
 * was still *reclassifying* the first — "buy XLM then lend it" became a
 * liquidity action that bought nothing.
 *
 * The other half of the job is declining. Most intents are one action, and a
 * parser eager to find sequences would invent trades nobody asked for.
 */

const PRICES = { XLM: 0.16, USDC: 1 }

describe('a sequence is read as two ordered actions', () => {
  it('reads a buy followed by a supply', () => {
    const parsed = parseCompoundIntent('Buy $50 of XLM with USDC, then supply it to Blend', PRICES)

    expect(parsed).not.toBeNull()
    expect(parsed?.followOn.kind).toBe('lend')
    expect(parsed?.followOn.venue).toBe('blend')
  })

  it('keeps the first clause a buy rather than letting the second reclassify it', () => {
    // The bug this file exists for. "Lending" in clause two used to make the
    // whole intent a liquidity action, silently discarding the purchase.
    const parsed = parseCompoundIntent('Buy $50 of XLM then deposit it into Blend', PRICES)

    expect(parsed?.head.input.type).not.toBe('route_liquidity')
    expect(parsed?.head.input.type).toBe('market_buy')
  })

  it('parses the first clause exactly as it would alone', () => {
    // A clause in a sequence and the same clause by itself must agree.
    // Anything else means the split is changing the trade.
    const alone = parseIntent('Buy $50 of XLM with USDC', PRICES)
    const compound = parseCompoundIntent(
      'Buy $50 of XLM with USDC, then supply it to Blend',
      PRICES
    )

    expect(compound?.head.input.type).toBe(alone.input.type)
    expect(compound?.head.input.tokenIn).toBe(alone.input.tokenIn)
    expect(compound?.head.input.tokenOut).toBe(alone.input.tokenOut)
    expect(compound?.head.input.amountIn).toBe(alone.input.amountIn)
  })

  it('keeps both clauses so the user can see what was understood', () => {
    const parsed = parseCompoundIntent('Buy $50 of XLM then lend it on Blend', PRICES)
    expect(parsed?.clauses[0]).toBe('Buy $50 of XLM')
    expect(parsed?.clauses[1]).toBe('lend it on Blend')
  })

  it('reads the markers people actually use', () => {
    for (const phrase of [
      'Buy $50 of XLM then supply it to Blend',
      'Buy $50 of XLM and then supply it to Blend',
      'Buy $50 of XLM, after that supply it to Blend',
      'Buy $50 of XLM, followed by supplying it to Blend',
      // Bare "and" joining a trade to a lending verb. Declining this told the
      // user the app had not understood an instruction whose near-identical
      // "then" wording worked.
      'Buy $50 of XLM and supply it to Blend',
      'Swap $500 worth of USDC to XLM and supply it to Blend',
    ]) {
      expect(parseCompoundIntent(phrase, PRICES), phrase).not.toBeNull()
    }
  })

  it('reads the words people use for lending', () => {
    for (const verb of ['supply', 'deposit', 'lend']) {
      const phrase = `Buy $50 of XLM then ${verb} it on Blend`
      expect(parseCompoundIntent(phrase, PRICES), phrase).not.toBeNull()
    }
  })

  it('defaults to the only integrated venue when none is named', () => {
    const parsed = parseCompoundIntent('Buy $50 of XLM then lend it', PRICES)
    expect(parsed?.followOn.venue).toBe('blend')
  })
})

describe('declining is the common answer', () => {
  it('returns nothing for an ordinary swap', () => {
    expect(parseCompoundIntent('Buy $50 of XLM with USDC', PRICES)).toBeNull()
  })

  it('does not read "and" joining two assets as a sequence', () => {
    // "Buy XLM and USDC" is one purchase of two things. What keeps this safe
    // is not the marker but the clause after it: "USDC" names no lending
    // action, so the single-purchase reading survives.
    expect(parseCompoundIntent('Buy $50 of XLM and USDC', PRICES)).toBeNull()
    expect(parseCompoundIntent('Buy $50 of XLM and WBTC', PRICES)).toBeNull()
    expect(parseCompoundIntent('Buy $50 of XLM and USDT and WBTC', PRICES)).toBeNull()
  })

  it('declines a second clause that is not an action it can perform', () => {
    expect(parseCompoundIntent('Buy $50 of XLM then tell me the price', PRICES)).toBeNull()
  })

  it('declines a trailing marker with nothing after it', () => {
    expect(parseCompoundIntent('Buy $50 of XLM then', PRICES)).toBeNull()
  })

  it('declines a marker with nothing before it', () => {
    expect(parseCompoundIntent('then supply it to Blend', PRICES)).toBeNull()
  })

  it('refuses a venue it does not integrate rather than substituting one', () => {
    // Silently supplying somewhere the user did not name is the worst possible
    // reading of an explicit instruction.
    expect(parseCompoundIntent('Buy $50 of XLM then supply it on Aave', PRICES)).toBeNull()
  })

  it('still accepts "supply it" where the pronoun is not a venue', () => {
    expect(parseCompoundIntent('Buy $50 of XLM then supply it', PRICES)).not.toBeNull()
  })
})

describe('the single-action parser is untouched', () => {
  it('still classifies a plain liquidity intent as one', () => {
    // The fix must not have broken the case the keyword was there for.
    expect(parseIntent('Route liquidity into the XLM pool', PRICES).input.type).toBe(
      'route_liquidity'
    )
  })

  it('still reads a plain swap', () => {
    const parsed = parseIntent('Swap $300 of XLM to USDC', PRICES)
    expect(parsed.input.tokenIn).toBe('XLM')
    expect(parsed.input.tokenOut).toBe('USDC')
  })
})
