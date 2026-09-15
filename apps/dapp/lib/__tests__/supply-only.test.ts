import { readFileSync } from 'fs'
import { join } from 'path'

import { describe, expect, it } from 'vitest'

import { parseCompoundIntent, parseSupplyOnlyIntent } from '../parse-compound'

/**
 * Supplying an asset the account already holds.
 *
 * "Supply my XLM to Blend" used to parse as a market *buy* of XLM: the
 * single-action parser assumes every intent is a trade, and nothing in its
 * vocabulary expressed "use what I have". That is worse than refusing the
 * sentence, because it would spend USDC the user never offered.
 *
 * The rule that keeps this safe is narrow: a supply-only intent names a lending
 * action and *no* trade. Anything mentioning a swap or a buy is a trade whose
 * proceeds may then be supplied, which the compound parser already handles.
 */

const SYMBOLS = ['XLM', 'USDC', 'USDT', 'WBTC']

describe('an instruction to supply what the account holds', () => {
  it('reads the asset and takes the whole balance when none is named', () => {
    // "my XLM" is every XLM, and saying so explicitly matters: supplying all
    // of a balance and supplying some of it are different instructions.
    const parsed = parseSupplyOnlyIntent('Supply my XLM to Blend', SYMBOLS)

    expect(parsed?.asset).toBe('XLM')
    expect(parsed?.amount).toBeUndefined()
    expect(parsed?.venue).toBe('blend')
  })

  it('reads a stated amount', () => {
    const parsed = parseSupplyOnlyIntent('Deposit 500 XLM into Blend', SYMBOLS)

    expect(parsed?.asset).toBe('XLM')
    expect(parsed?.amount).toBe('500')
  })

  it('reads "all my" as the whole balance', () => {
    const parsed = parseSupplyOnlyIntent('supply all my xlm to blend', SYMBOLS)

    expect(parsed?.asset).toBe('XLM')
    expect(parsed?.amount).toBeUndefined()
  })

  it('reads the verbs people use', () => {
    for (const verb of ['Supply', 'Lend', 'Deposit']) {
      const phrase = `${verb} my XLM on Blend`
      expect(parseSupplyOnlyIntent(phrase, SYMBOLS), phrase).not.toBeNull()
    }
  })

  it('normalises a lowercase ticker', () => {
    expect(parseSupplyOnlyIntent('lend my xlm to blend', SYMBOLS)?.asset).toBe('XLM')
  })
})

describe('a trade is never read as a supply', () => {
  it('declines a sequence that swaps first', () => {
    // The compound parser owns this. Reading it here would supply an existing
    // balance and skip the trade the user actually asked for.
    expect(
      parseSupplyOnlyIntent('Swap $500 USDC to XLM and supply it to Blend', SYMBOLS)
    ).toBeNull()
  })

  it('declines a buy followed by a supply', () => {
    expect(
      parseSupplyOnlyIntent('Buy $20 of XLM with USDC, then supply it to Blend', SYMBOLS)
    ).toBeNull()
  })

  it('leaves that sentence to the compound parser, which still reads it', () => {
    // Both must be true: supply-only declines it *and* the sequence path still
    // recognises it. Otherwise the instruction falls through both.
    const compound = parseCompoundIntent('Swap $500 worth of USDC to XLM and supply it to Blend', {
      XLM: 0.16,
      USDC: 1,
    })
    expect(compound?.followOn.venue).toBe('blend')
  })

  it('declines an ordinary trade with no lending at all', () => {
    expect(parseSupplyOnlyIntent('Buy $50 of XLM', SYMBOLS)).toBeNull()
  })
})

describe('it refuses rather than substitutes', () => {
  it('declines a venue the app does not integrate', () => {
    // Supplying somewhere the user did not name is the worst possible reading
    // of an explicit instruction.
    expect(parseSupplyOnlyIntent('Supply my XLM to Aave', SYMBOLS)).toBeNull()
  })

  it('declines an asset the app cannot trade', () => {
    // A typo becomes a refusal rather than an instruction naming something
    // that does not exist.
    expect(parseSupplyOnlyIntent('Supply my DOGE to Blend', SYMBOLS)).toBeNull()
  })

  it('declines a sentence naming no asset', () => {
    expect(parseSupplyOnlyIntent('Supply everything to Blend', SYMBOLS)).toBeNull()
  })
})

describe('the source survives the tooling that edits it', () => {
  it('contains no literal backspace characters', () => {
    // Not paranoia. Writing this file through a shell heredoc turned every
    // `\b` word-boundary escape into a literal 0x08 byte, so the regex matched
    // nothing inside the module while matching perfectly every time it was
    // retyped in a test. The parser silently refused every valid sentence and
    // the cause was invisible in ordinary reading — `cat -A` was what finally
    // showed it.
    const source = readFileSync(join(process.cwd(), 'lib', 'parse-compound.ts'), 'utf8')
    expect(source).not.toContain(String.fromCharCode(8))
  })

  it('keeps the word boundaries the patterns depend on', () => {
    const source = readFileSync(join(process.cwd(), 'lib', 'parse-compound.ts'), 'utf8')
    // A boundary-less trade guard would match "lend" inside "Blend".
    expect(source).toMatch(/\\b\(\?:swap\|buy\|purchase/)
  })
})

describe('a dollar figure is not a token count', () => {
  it('marks a dollar amount as dollars', () => {
    // "$20 worth of XLM" is roughly 125 XLM. Supplying 20 would be a sixth of
    // what was asked, and nothing in the sentence would say so.
    const parsed = parseSupplyOnlyIntent('supply $20 worth of XLM to blend protocol', SYMBOLS)

    expect(parsed?.amount).toBe('20')
    expect(parsed?.amountIsUsd).toBe(true)
  })

  it('reads the same sentence without "worth"', () => {
    const parsed = parseSupplyOnlyIntent('supply $20 of XLM to blend', SYMBOLS)

    expect(parsed?.amount).toBe('20')
    expect(parsed?.amountIsUsd).toBe(true)
  })

  it('does not mark a bare token count as dollars', () => {
    const parsed = parseSupplyOnlyIntent('supply 20 XLM to blend protocol', SYMBOLS)

    expect(parsed?.amount).toBe('20')
    expect(parsed?.amountIsUsd).toBeUndefined()
  })

  it('does not mistake the filler words for the asset', () => {
    // Before the dollar branch existed, "supply $20 worth of XLM" matched the
    // bare-number rule and read the ticker as "worth" — twenty units of an
    // asset that does not exist.
    expect(parseSupplyOnlyIntent('supply $20 worth of XLM to blend', SYMBOLS)?.asset).toBe('XLM')
  })

  it('still names the whole balance when no figure is given', () => {
    const parsed = parseSupplyOnlyIntent('Supply my XLM to Blend', SYMBOLS)

    expect(parsed?.amount).toBeUndefined()
    expect(parsed?.amountIsUsd).toBeUndefined()
  })

  it('reads a venue named as "blend protocol"', () => {
    // People name the protocol, not the contract.
    expect(parseSupplyOnlyIntent('supply 20 XLM to blend protocol', SYMBOLS)?.venue).toBe('blend')
  })
})

describe('the dollar branch survives its own regex', () => {
  it('matches despite the leading dollar sign', () => {
    // A leading word boundary cannot match before "$" — a boundary needs a word
    // character on one side, and "$" is not one. The dollar alternative
    // therefore never fired, and the bare-number rule swallowed the sentence
    // instead, which is how "$20" came to read as 20 XLM.
    const source = readFileSync(join(process.cwd(), 'lib', 'parse-compound.ts'), 'utf8')
    expect(source).not.toMatch(/\b\(\?:\(all\s\+\(\?:of/)
  })
})
