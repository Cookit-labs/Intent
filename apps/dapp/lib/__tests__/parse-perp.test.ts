import { describe, expect, it } from 'vitest'

import { parsePerpIntent } from '../parse-perp'

/**
 * Reading "long XLM 10x with 50 USDC" out of free text.
 *
 * Narrow like the other direct-flow parsers. A perp is a different instrument
 * from a swap, and the trade parser would read "long XLM with 50 USDC" as a
 * purchase of XLM — a spot position where a leveraged one was asked for. So
 * this fires only when a side word is followed closely by a market the venue
 * actually lists, and declines everything else.
 */

const MARKETS = ['BTC', 'ETH', 'XLM', 'SOL']

describe('parsePerpIntent', () => {
  it('reads side, asset, leverage and collateral', () => {
    expect(parsePerpIntent('long XLM 10x with 50 USDC', MARKETS)).toEqual({
      kind: 'perp',
      side: 'long',
      asset: 'XLM',
      leverage: 10,
      collateral: '50',
    })
  })

  it.each([
    ['Short BTC 3x using 100 USDC', 'short', 'BTC', 3, '100'],
    ['go long on XLM at 5x with $20', 'long', 'XLM', 5, '20'],
    ['open a 5x long on ETH with 25 USDC', 'long', 'ETH', 5, '25'],
    ['Long XLM 10x leverage, 50 USDC collateral', 'long', 'XLM', 10, '50'],
    ['long 100 USDC of XLM 5x', 'long', 'XLM', 5, '100'],
    ['short sol with 1,000 usdc at 2x', 'short', 'SOL', 2, '1000'],
    ['long xlm with leverage 4 and 30 usdc', 'long', 'XLM', 4, '30'],
  ])('reads %j', (text, side, asset, leverage, collateral) => {
    expect(parsePerpIntent(text, MARKETS)).toEqual({
      kind: 'perp',
      side,
      asset,
      leverage,
      collateral,
    })
  })

  it('leaves leverage and collateral absent when the text names neither', () => {
    expect(parsePerpIntent('long xlm', MARKETS)).toEqual({
      kind: 'perp',
      side: 'long',
      asset: 'XLM',
    })
  })

  it('leaves leverage absent when only collateral is named', () => {
    expect(parsePerpIntent('short XLM with 50 usdc', MARKETS)).toEqual({
      kind: 'perp',
      side: 'short',
      asset: 'XLM',
      collateral: '50',
    })
  })

  it('records the leverage as stated, even past what the venue allows', () => {
    // The parser reads; the prepare route refuses. A silent cap here would
    // open a 10x position for someone who asked for 25x.
    expect(parsePerpIntent('long XLM 25x with 50 USDC', MARKETS)?.leverage).toBe(25)
  })

  it('accepts lumens as XLM', () => {
    expect(parsePerpIntent('long lumens 3x with 10 usdc', MARKETS)?.asset).toBe('XLM')
  })

  it.each([
    // "long term" is not a market.
    'buy XLM for the long term',
    'a short-term hold of XLM',
    // No side word at all.
    'Sell 60 XLM and send the dollars to my bank',
    'swap 50 USDC to XLM',
    // A market the venue does not list.
    'long DOGE 5x with 10 USDC',
    // Closing is not this slice.
    'close my XLM long',
    '',
  ])('declines %j', (text) => {
    expect(parsePerpIntent(text, MARKETS)).toBeNull()
  })

  it('declines everything when no markets are known', () => {
    // No market list means the venue could not be read, and a perp on an
    // unknown market is a request the app cannot honour.
    expect(parsePerpIntent('long XLM 10x with 50 USDC', [])).toBeNull()
  })
})
