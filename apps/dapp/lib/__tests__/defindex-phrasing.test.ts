import { describe, expect, it } from 'vitest'

import { describeFollowOn, parseCompoundIntent, parseSupplyOnlyIntent } from '../parse-compound'
import { readIntentWithLlm } from '../parse-intent-llm'

/**
 * Naming DeFindex in a sentence.
 *
 * Two readings are pinned. A sentence that names a venue carries
 * `venueNamed`, so the execution path can tell "the user chose Blend" from
 * "Blend is the default" — and honour the chosen agent's pool only in the
 * second case. And a venue this app does not integrate is still refused
 * rather than substituted; adding a second venue must not have loosened
 * that.
 */

const PRICES = { XLM: 0.16, USDC: 1 }
const SYMBOLS = ['XLM', 'USDC']

describe('a follow-on naming DeFindex', () => {
  it('reads "supply it on DeFindex"', () => {
    const parsed = parseCompoundIntent(
      'Swap 50 USDC to XLM then supply it for yield on DeFindex',
      PRICES
    )
    expect(parsed?.followOn.kind).toBe('lend')
    expect(parsed?.followOn.venue).toBe('defindex')
    expect(parsed?.followOn.venueNamed).toBe(true)
  })

  it('reads "the defindex vault"', () => {
    const parsed = parseCompoundIntent(
      'Buy $50 of XLM then deposit it into the defindex vault',
      PRICES
    )
    expect(parsed?.followOn.venue).toBe('defindex')
  })

  it('tolerates a typo, as it does for Blend', () => {
    const parsed = parseCompoundIntent('Buy $50 of XLM then supply it to Defindx', PRICES)
    expect(parsed?.followOn.venue).toBe('defindex')
  })

  it('marks Blend as named when it was', () => {
    const parsed = parseCompoundIntent('Buy $50 of XLM then supply it to Blend', PRICES)
    expect(parsed?.followOn.venue).toBe('blend')
    expect(parsed?.followOn.venueNamed).toBe(true)
  })

  it('does not mark the default as named', () => {
    const parsed = parseCompoundIntent('Buy $50 of XLM then lend it', PRICES)
    expect(parsed?.followOn.venue).toBe('blend')
    expect(parsed?.followOn.venueNamed).toBeUndefined()
  })

  it('still refuses a venue it does not integrate', () => {
    expect(parseCompoundIntent('Buy $50 of XLM then supply it on Aave', PRICES)).toBeNull()
  })
})

describe('a supply-only instruction naming DeFindex', () => {
  it('reads the venue, so the caller can decline it by name rather than supply elsewhere', () => {
    const parsed = parseSupplyOnlyIntent('Supply my XLM to DeFindex', SYMBOLS)
    expect(parsed?.venue).toBe('defindex')
    expect(parsed?.asset).toBe('XLM')
  })
})

describe('describing the follow-on', () => {
  it('names DeFindex', () => {
    expect(describeFollowOn({ kind: 'lend', venue: 'defindex' }, 'XLM')).toBe(
      'then supply the XLM to DeFindex'
    )
  })
})

function reply(args: unknown): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              tool_calls: [{ function: { name: 'read_intent', arguments: JSON.stringify(args) } }],
            },
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )) as unknown as typeof fetch
}

const SWAP_THEN_LEND = {
  tokenIn: 'USDC',
  tokenOut: 'XLM',
  amountUsd: 500,
  amountStated: true,
  followOn: 'lend',
  followOnVenue: 'defindex',
}

describe('the model naming DeFindex', () => {
  it('is read as a named venue when the deployment offers it', async () => {
    const got = await readIntentWithLlm('Swap $500 of USDC to XLM and supply it to DeFindex', {
      apiKey: 'test-key',
      fetchImpl: reply(SWAP_THEN_LEND),
      allowedSymbols: SYMBOLS,
      allowedVenues: ['blend', 'defindex'],
    })

    expect(got?.followOn).toEqual({ kind: 'lend', venue: 'defindex', venueNamed: true })
  })

  it('is refused, not redirected to Blend, when the deployment does not', async () => {
    const got = await readIntentWithLlm('Swap $500 of USDC to XLM and supply it to DeFindex', {
      apiKey: 'test-key',
      fetchImpl: reply(SWAP_THEN_LEND),
      allowedSymbols: SYMBOLS,
      allowedVenues: ['blend'],
    })

    expect(got?.followOn).toBeNull()
  })
})
