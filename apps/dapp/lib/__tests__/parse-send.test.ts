import { readFileSync } from 'fs'
import { join } from 'path'

import { describe, expect, it } from 'vitest'

import { describeFollowOn, parseCompoundIntent } from '../parse-compound'
import { parseSendIntent } from '../parse-send'

/**
 * Reading a payment out of free text.
 *
 * "Send 50 USDC to deon.xlm" is not a trade, and the trade parser would read
 * it as one — a buy of USDC, spending something the user never offered. The
 * rule that keeps this narrow: a payment verb, an amount of an asset the app
 * trades, and a recipient in one of the three forms the resolver reads. A
 * sentence missing any of those is left to the other parsers.
 */

const SYMBOLS = ['XLM', 'USDC', 'USDT', 'WBTC']
const G = 'GBGFEZ5QZFLQJTTCQUYWTJBGZN6QEVFF57F3LVD2MF7MRYWUNKFBJWIV'
const C = 'CC75Z72OCE667WVPQOROIWDAGBOXFNJ4VQONQEURL74EYIDLWA4F7FEN'
const PRICES = { XLM: 0.16, USDC: 1 }

describe('parseSendIntent', () => {
  it('reads an amount of an asset to a .xlm name', () => {
    expect(parseSendIntent('send 50 USDC to deon.xlm', SYMBOLS)).toEqual({
      kind: 'send-only',
      amount: '50',
      amountIsUsd: false,
      asset: 'USDC',
      recipient: 'deon.xlm',
    })
  })

  it('reads a dollar amount of an asset to a federation address', () => {
    expect(parseSendIntent('pay $20 of XLM to alice*lobstr.co', SYMBOLS)).toEqual({
      kind: 'send-only',
      amount: '20',
      amountIsUsd: true,
      asset: 'XLM',
      recipient: 'alice*lobstr.co',
    })
  })

  it('reads a raw address and a trailing memo', () => {
    expect(parseSendIntent(`transfer 10 XLM to ${G} memo rent`, SYMBOLS)).toEqual({
      kind: 'send-only',
      amount: '10',
      amountIsUsd: false,
      asset: 'XLM',
      recipient: G,
      memo: 'rent',
    })
  })

  it('keeps a multi-word memo whole', () => {
    expect(parseSendIntent('send 2 XLM to deon.xlm memo invoice 42', SYMBOLS)?.memo).toBe(
      'invoice 42'
    )
  })

  it('normalises the ticker, the thousands separator and trailing punctuation', () => {
    const parsed = parseSendIntent('Send 1,000 usdc to Deon.xlm.', SYMBOLS)
    expect(parsed?.amount).toBe('1000')
    expect(parsed?.asset).toBe('USDC')
    // As typed, so the card and the address book see what the user wrote.
    expect(parsed?.recipient).toBe('Deon.xlm')
  })

  it('reads "$50 USDC" as dollars, which for USDC is the same figure', () => {
    expect(parseSendIntent('send $50 USDC to deon.xlm', SYMBOLS)?.amountIsUsd).toBe(true)
  })

  it('reads a contract address, leaving the refusal to the resolver', () => {
    // The refusal names why; a null here would send the sentence to the trade
    // parser, which names nothing.
    expect(parseSendIntent(`send 5 XLM to ${C}`, SYMBOLS)?.recipient).toBe(C)
  })

  it('reads the three verbs', () => {
    for (const verb of ['Send', 'Pay', 'Transfer']) {
      expect(parseSendIntent(`${verb} 5 XLM to deon.xlm`, SYMBOLS), verb).not.toBeNull()
    }
  })

  it('declines a recipient that is not an address or a name', () => {
    expect(parseSendIntent('send it to my friend', SYMBOLS)).toBeNull()
    expect(parseSendIntent('send 50 USDC to my friend', SYMBOLS)).toBeNull()
    expect(parseSendIntent('send 50 USDC to deon.eth', SYMBOLS)).toBeNull()
  })

  it('declines a withdrawal to a bank, which the offramp parser owns', () => {
    expect(parseSendIntent('send 50 USDC to my bank', SYMBOLS)).toBeNull()
    expect(parseSendIntent('withdraw 5 usdc to my bank', SYMBOLS)).toBeNull()
  })

  it('declines an asset the app cannot trade', () => {
    expect(parseSendIntent('send 50 DOGE to deon.xlm', SYMBOLS)).toBeNull()
  })

  it('declines a trade, which the compound parser owns', () => {
    expect(parseSendIntent('swap 50 USDC to XLM then send it to bob.xlm', SYMBOLS)).toBeNull()
    expect(parseSendIntent('buy 50 USDC to deon.xlm', SYMBOLS)).toBeNull()
  })

  it('declines a sentence with no amount or no recipient', () => {
    expect(parseSendIntent('send 50 USDC', SYMBOLS)).toBeNull()
    expect(parseSendIntent('send USDC to deon.xlm', SYMBOLS)).toBeNull()
  })
})

describe('a send as the second half of a swap', () => {
  it('reads "then send it to <name>" as a send follow-on', () => {
    const compound = parseCompoundIntent('Swap $50 USDC to XLM, then send it to bob.xlm', PRICES)
    expect(compound?.followOn).toEqual({ kind: 'send', venue: '', recipient: 'bob.xlm' })
    expect(compound?.head.input.tokenOut).toBe('XLM')
  })

  it('reads "and pay it to <federation address>"', () => {
    const compound = parseCompoundIntent(
      'swap 50 USDC to XLM and pay it to alice*lobstr.co',
      PRICES
    )
    expect(compound?.followOn.kind).toBe('send')
    expect(compound?.followOn.recipient).toBe('alice*lobstr.co')
  })

  it('reads a raw address', () => {
    const compound = parseCompoundIntent(`swap 50 USDC to XLM then transfer it to ${G}`, PRICES)
    expect(compound?.followOn.recipient).toBe(G)
  })

  it('still declines "send it to my friend"', () => {
    expect(parseCompoundIntent('swap 50 USDC to XLM then send it to my friend', PRICES)).toBeNull()
  })

  it('still reads "send the dollars to my bank" as an offramp', () => {
    const compound = parseCompoundIntent(
      'sell XLM for USDC and send the dollars to my bank',
      PRICES
    )
    expect(compound?.followOn.kind).toBe('offramp')
  })
})

describe('describeFollowOn for a send', () => {
  it('names the asset and the recipient', () => {
    expect(describeFollowOn({ kind: 'send', venue: '', recipient: 'bob.xlm' }, 'XLM')).toBe(
      'then send the XLM to bob.xlm'
    )
  })

  it('says "it" when the asset is not known', () => {
    expect(describeFollowOn({ kind: 'send', venue: '', recipient: 'bob.xlm' })).toBe(
      'then send it to bob.xlm'
    )
  })
})

describe('the source survives the tooling that edits it', () => {
  it('contains no literal backspace characters', () => {
    // Same guard as parse-compound: a shell heredoc once turned every `\b`
    // into a 0x08 byte and the parser silently refused every sentence.
    const source = readFileSync(join(process.cwd(), 'lib', 'parse-send.ts'), 'utf8')
    expect(source).not.toContain(String.fromCharCode(8))
  })
})
