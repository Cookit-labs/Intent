import { describe, expect, it } from 'vitest'

import { isLlmParseConfigured, readIntentWithLlm } from '../parse-intent-llm'

/**
 * Reading an instruction by meaning rather than by wording.
 *
 * Two things are being pinned here, and the second matters more than the first.
 *
 * The obvious one is that a well-formed reply is read correctly. The load-
 * bearing one is that **every** failure returns null rather than throwing or
 * inventing an answer: no key, a timeout, an HTTP error, a reply with no tool
 * call, malformed arguments, an asset the app cannot trade, a venue it does not
 * integrate. Each of those leaves the caller free to fall back to the regex
 * parser, which is the entire safety argument for putting a model in front of
 * parsing at all. A parser that can fail closed is worse than a narrow one.
 */

const KEY = { apiKey: 'test-key' }
const SYMBOLS = ['XLM', 'USDC', 'USDT', 'WBTC']

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

function rawReply(body: string, status = 200): typeof fetch {
  return (async () =>
    new Response(body, { status, headers: { 'Content-Type': 'application/json' } })) as never
}

const SWAP_THEN_LEND = {
  tokenIn: 'USDC',
  tokenOut: 'XLM',
  amountUsd: 500,
  amountStated: true,
  followOn: 'lend',
  followOnVenue: 'blend',
}

describe('a well-formed reply is read', () => {
  it('reads the assets, the size, and the follow-on', async () => {
    const got = await readIntentWithLlm('Swap $500 worth of USDC to XLM and supply it to Blend', {
      ...KEY,
      fetchImpl: reply(SWAP_THEN_LEND),
      allowedSymbols: SYMBOLS,
    })

    expect(got?.tokenIn).toBe('USDC')
    expect(got?.tokenOut).toBe('XLM')
    expect(got?.amountUsd).toBe(500)
    // Named in the sentence, so marked as such: that is what lets the
    // execution path tell the user's choice of pool from the default.
    expect(got?.followOn).toEqual({ kind: 'lend', venue: 'blend', venueNamed: true })
  })

  it('reports no follow-on for an ordinary swap', async () => {
    const got = await readIntentWithLlm('Swap $50 of USDC to XLM', {
      ...KEY,
      fetchImpl: reply({ ...SWAP_THEN_LEND, amountUsd: 50, followOn: 'none', followOnVenue: '' }),
      allowedSymbols: SYMBOLS,
    })

    expect(got).not.toBeNull()
    expect(got?.followOn).toBeNull()
  })

  it('normalises a lowercase ticker', async () => {
    const got = await readIntentWithLlm('swap usdc for xlm', {
      ...KEY,
      fetchImpl: reply({ ...SWAP_THEN_LEND, tokenIn: 'usdc', tokenOut: 'xlm' }),
      allowedSymbols: SYMBOLS,
    })
    expect(got?.tokenIn).toBe('USDC')
    expect(got?.tokenOut).toBe('XLM')
  })

  it('defaults an unnamed venue to the only one integrated', async () => {
    // "supply it" with no venue has always meant the one lending venue there
    // is, and that reading does not change here.
    const got = await readIntentWithLlm('buy xlm and supply it', {
      ...KEY,
      fetchImpl: reply({ ...SWAP_THEN_LEND, followOnVenue: '' }),
      allowedSymbols: SYMBOLS,
      allowedVenues: ['blend'],
    })
    expect(got?.followOn).toEqual({ kind: 'lend', venue: 'blend' })
  })

  it('carries a size of zero when none was stated', async () => {
    const got = await readIntentWithLlm('buy some XLM with my USDC and stake it on Blend', {
      ...KEY,
      fetchImpl: reply({ ...SWAP_THEN_LEND, amountUsd: 0, amountStated: false }),
      allowedSymbols: SYMBOLS,
    })
    expect(got?.amountStated).toBe(false)
    expect(got?.amountUsd).toBe(0)
  })
})

describe('every failure falls back rather than guessing', () => {
  it('returns nothing without a key', async () => {
    const got = await readIntentWithLlm('buy xlm', { apiKey: '', fetchImpl: reply(SWAP_THEN_LEND) })
    expect(got).toBeNull()
  })

  it('returns nothing on an HTTP error', async () => {
    const got = await readIntentWithLlm('buy xlm', {
      ...KEY,
      fetchImpl: rawReply('{"error":"rate limited"}', 429),
    })
    expect(got).toBeNull()
  })

  it('returns nothing when the model replies without calling the tool', async () => {
    // The observed wobble: one run in three dropped the tool call. The regex
    // answers in that case rather than the user seeing a failure.
    const got = await readIntentWithLlm('buy xlm', {
      ...KEY,
      fetchImpl: rawReply(JSON.stringify({ choices: [{ message: { content: 'Sure!' } }] })),
    })
    expect(got).toBeNull()
  })

  it('returns nothing on malformed tool arguments', async () => {
    const got = await readIntentWithLlm('buy xlm', {
      ...KEY,
      fetchImpl: rawReply(
        JSON.stringify({
          choices: [{ message: { tool_calls: [{ function: { arguments: '{"tokenIn":' } }] } }],
        })
      ),
    })
    expect(got).toBeNull()
  })

  it('returns nothing when the request throws', async () => {
    const got = await readIntentWithLlm('buy xlm', {
      ...KEY,
      fetchImpl: (async () => {
        throw new Error('network down')
      }) as never,
    })
    expect(got).toBeNull()
  })

  it('does not throw on any of these', async () => {
    // The caller runs this on the submit path, so an exception here would take
    // the whole intent down rather than degrading to the regex.
    await expect(
      readIntentWithLlm('buy xlm', { ...KEY, fetchImpl: rawReply('not json at all') })
    ).resolves.toBeNull()
  })
})

describe('the model does not get to invent assets or venues', () => {
  it('refuses a ticker the app cannot trade', async () => {
    // A hallucinated asset reaching the quoter as a real instruction is the
    // ticker-impersonation trap this codebase has hit before.
    const got = await readIntentWithLlm('buy DOGE with USDC', {
      ...KEY,
      fetchImpl: reply({ ...SWAP_THEN_LEND, tokenOut: 'DOGE' }),
      allowedSymbols: SYMBOLS,
    })
    expect(got).toBeNull()
  })

  it('refuses a swap of an asset for itself', async () => {
    const got = await readIntentWithLlm('swap xlm for xlm', {
      ...KEY,
      fetchImpl: reply({ ...SWAP_THEN_LEND, tokenIn: 'XLM', tokenOut: 'XLM' }),
      allowedSymbols: SYMBOLS,
    })
    expect(got).toBeNull()
  })

  it('drops a lending venue it does not integrate rather than substituting one', async () => {
    // The trade is still readable; only the follow-on is not. Substituting
    // Blend for Aave would supply somewhere the user never named.
    const got = await readIntentWithLlm('buy xlm and supply it on Aave', {
      ...KEY,
      fetchImpl: reply({ ...SWAP_THEN_LEND, followOnVenue: 'aave' }),
      allowedSymbols: SYMBOLS,
      allowedVenues: ['blend'],
    })
    expect(got).not.toBeNull()
    expect(got?.followOn).toBeNull()
  })

  it('drops a lend on a chain with no lending venues at all', async () => {
    const got = await readIntentWithLlm('buy xlm and supply it', {
      ...KEY,
      fetchImpl: reply(SWAP_THEN_LEND),
      allowedSymbols: SYMBOLS,
      allowedVenues: [],
    })
    expect(got?.followOn).toBeNull()
  })

  it('refuses a stated size that is not a usable number', async () => {
    // Claiming a size and giving nothing usable is a contradiction, and trading
    // on it would size the trade wrong rather than not at all.
    const got = await readIntentWithLlm('buy $20 of xlm', {
      ...KEY,
      fetchImpl: reply({ ...SWAP_THEN_LEND, amountUsd: 0, amountStated: true }),
      allowedSymbols: SYMBOLS,
    })
    expect(got).toBeNull()
  })
})

describe('knowing whether a parse can be attempted', () => {
  it('is false without a key', () => {
    expect(isLlmParseConfigured({ apiKey: '' })).toBe(false)
  })

  it('is true with one', () => {
    expect(isLlmParseConfigured(KEY)).toBe(true)
  })
})

describe('the model can say "supply what I already hold"', () => {
  const SUPPLY = {
    action: 'supply',
    tokenIn: 'XLM',
    tokenOut: 'XLM',
    amountUsd: 20,
    amountIsUsd: true,
    amountStated: true,
    followOn: 'none',
    followOnVenue: '',
  }

  it('reads a supply as a supply, not a trade', async () => {
    // The gap this closes. Every field in the schema presumed a trade, so the
    // model had no way to report "supply my XLM" however well it read the
    // sentence — and the app executed it as a swap of USDC for XLM.
    const got = await readIntentWithLlm('Supply $20 worth of XLM to Blende protocol', {
      ...KEY,
      fetchImpl: reply(SUPPLY),
      allowedSymbols: SYMBOLS,
    })

    expect(got?.action).toBe('supply')
    expect(got?.tokenIn).toBe('XLM')
  })

  it('allows a supply to name one asset twice', async () => {
    // A swap of an asset for itself is meaningless and still refused. A supply
    // names the same asset on both sides by design, so the check must not
    // apply to it — it did, and every supply was discarded.
    const got = await readIntentWithLlm('Supply my XLM to Blend', {
      ...KEY,
      fetchImpl: reply({ ...SUPPLY, amountUsd: 0, amountIsUsd: false, amountStated: false }),
      allowedSymbols: SYMBOLS,
    })

    expect(got).not.toBeNull()
    expect(got?.action).toBe('supply')
  })

  it('still refuses a swap of an asset for itself', async () => {
    const got = await readIntentWithLlm('swap XLM for XLM', {
      ...KEY,
      fetchImpl: reply({ ...SUPPLY, action: 'swap' }),
      allowedSymbols: SYMBOLS,
    })

    expect(got).toBeNull()
  })

  it('carries whether the size was dollars or units', async () => {
    // "$20 worth of XLM" is roughly 125 XLM. Losing the unit moves about a
    // sixth of what was asked.
    const got = await readIntentWithLlm('Supply $20 worth of XLM to Blend', {
      ...KEY,
      fetchImpl: reply(SUPPLY),
      allowedSymbols: SYMBOLS,
    })

    expect(got?.amountIsUsd).toBe(true)
    expect(got?.amountUsd).toBe(20)
  })

  it('reads a borrow as a borrow', async () => {
    const got = await readIntentWithLlm('borrow wBTC against my Blend position', {
      ...KEY,
      fetchImpl: reply({ ...SUPPLY, action: 'borrow', tokenIn: 'WBTC', tokenOut: 'WBTC' }),
      allowedSymbols: SYMBOLS,
    })

    expect(got?.action).toBe('borrow')
  })

  it('reads a repay as a repay', async () => {
    const got = await readIntentWithLlm('repay my wBTC loan', {
      ...KEY,
      fetchImpl: reply({
        ...SUPPLY,
        action: 'repay',
        tokenIn: 'WBTC',
        tokenOut: 'WBTC',
        amountStated: false,
        amountUsd: 0,
      }),
      allowedSymbols: SYMBOLS,
    })

    expect(got?.action).toBe('repay')
  })

  it('lets a borrow name one asset twice', async () => {
    // Like a supply, and unlike a swap: there is no second asset involved.
    const got = await readIntentWithLlm('borrow 0.01 wBTC', {
      ...KEY,
      fetchImpl: reply({ ...SUPPLY, action: 'borrow', tokenIn: 'WBTC', tokenOut: 'WBTC' }),
      allowedSymbols: SYMBOLS,
    })

    expect(got).not.toBeNull()
  })

  it('never turns an unrecognised action into a lending one', async () => {
    // The direction of this fallback matters. A malformed reply becoming a
    // swap is a misread; becoming a borrow would open a liability nobody
    // asked for.
    const got = await readIntentWithLlm('do something', {
      ...KEY,
      fetchImpl: reply({ ...SUPPLY, action: 'liquidate', tokenIn: 'USDC', tokenOut: 'XLM' }),
      allowedSymbols: SYMBOLS,
    })

    expect(got?.action).toBe('swap')
  })

  it('defaults to a swap when the action is missing or unknown', async () => {
    // An older model, or a malformed reply, must not silently become a supply.
    const got = await readIntentWithLlm('buy XLM', {
      ...KEY,
      fetchImpl: reply({ ...SUPPLY, action: undefined, tokenIn: 'USDC', tokenOut: 'XLM' }),
      allowedSymbols: SYMBOLS,
    })

    expect(got?.action).toBe('swap')
  })
})
