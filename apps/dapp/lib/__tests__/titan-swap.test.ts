import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildSolanaVenues } from '../chains/solana/module'
import { decodeSolanaTransaction } from '../chains/solana/assert-safe'
import { TITAN_SWAP_PROGRAM } from '../chains/solana/programs'
import { createTitanSwapVenue, TITAN_API } from '../chains/solana/titan-swap'
import { ChainActionRefused, type ChainVenue } from '../chains/types'

const ME = 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg'
const SOMEONE = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const SOL = 'So11111111111111111111111111111111111111112'
const POOL = 'HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ'
const TABLE = '2immgwYNHBbyVQKVGCEkgWpi53bLwWNRMB5G2nbgYV17'
const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N'

function route(over: Record<string, unknown> = {}) {
  return {
    inAmount: '5000000',
    outAmount: '57800000',
    slippageBps: 100,
    computeUnitsSafe: 300000,
    addressLookupTables: [TABLE],
    instructions: [
      {
        p: TITAN_SWAP_PROGRAM,
        a: [
          { p: ME, s: true, w: true },
          { p: POOL, s: false, w: true },
        ],
        d: Buffer.from([1, 2, 3]).toString('base64'),
      },
    ],
    ...over,
  }
}

function reply(over: Record<string, unknown> = {}, routeOver: Record<string, unknown> = {}) {
  return {
    id: 'q1',
    inputMint: USDC,
    outputMint: SOL,
    amount: '5000000',
    quotes: { titan: route(routeOver) },
    metadata: { ExpectedWinner: 'titan' },
    alts: [{ p: TABLE, a: [POOL] }],
    ...over,
  }
}

const rpc = vi.fn(async () => ({ value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100 } }))
const prices = async (t: { symbol: string }) => (t.symbol === 'SOL' ? 86 : 1)

function answer(body: unknown, status = 200) {
  const calls: { url: string; headers: Record<string, string> }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: init?.headers as Record<string, string> })
      return new Response(JSON.stringify(body), { status })
    })
  )
  return calls
}

function venue() {
  return createTitanSwapVenue({ apiKey: 'test-key', priceUsd: prices, rpc, retryDelayMs: 0 })
}

const ASK = { kind: 'swap' as const, amount: '5', tokenIn: 'USDC', tokenOut: 'SOL' }

function quoteOf(v: ChainVenue): NonNullable<ChainVenue['quote']> {
  if (v.quote === undefined) throw new Error('no quote')
  return v.quote
}

afterEach(() => vi.unstubAllGlobals())

describe('Titan on Solana', () => {
  it('runs only once a key is set', () => {
    expect(buildSolanaVenues({}).some((v) => v.id === 'titan')).toBe(false)
    expect(buildSolanaVenues({ TITAN_API_KEY: 'k' }).some((v) => v.id === 'titan')).toBe(true)
  })

  it('asks for a route with the key, for this wallet, at 1% slippage', async () => {
    const calls = answer(reply())
    await quoteOf(venue())(ASK, ME)
    const [call] = calls
    expect(call?.url.startsWith(`${TITAN_API}/api/v1/quote/swap?`)).toBe(true)
    const query = new URL(call?.url as string).searchParams
    expect(Object.fromEntries(query)).toMatchObject({
      inputMint: USDC,
      outputMint: SOL,
      amount: '5000000',
      userPublicKey: ME,
      slippageBps: '100',
      includeAltContents: 'true',
    })
    expect(call?.headers).toMatchObject({ 'x-api-key': 'test-key', accept: 'application/json' })
  })

  it('quotes what the winning route delivers', async () => {
    answer(reply())
    await expect(quoteOf(venue())(ASK, ME)).resolves.toEqual({
      receive: { amount: '0.0578', symbol: 'SOL' },
    })
  })

  it('builds a transaction its own check passes, paid and signed by the person alone', async () => {
    answer(reply())
    const prepared = await venue().prepare(ASK, ME)
    expect(prepared).toMatchObject({
      venueId: 'titan',
      venueName: 'Titan',
      kind: 'swap',
      pay: { amount: '5', symbol: 'USDC' },
      receive: { amount: '0.0578', symbol: 'SOL', approximate: true },
    })
    expect(prepared.notes[0]).toMatch(/at least 0\.057222 SOL/)
    const transaction = (prepared.signing as { transaction: string }).transaction
    const decoded = decodeSolanaTransaction(transaction)
    expect(decoded.feePayer).toBe(ME)
    expect(decoded.signerCount).toBe(1)
    expect(decoded.blockhash).toBe(BLOCKHASH)
    // A compute limit and price come first where the route set none.
    expect(decoded.instructions).toHaveLength(3)
    expect(() => venue().assertSafe(prepared.signing, ME)).not.toThrow()
  })

  it('reads the pool through the lookup table rather than in the open', async () => {
    answer(reply())
    const prepared = await venue().prepare(ASK, ME)
    const decoded = decodeSolanaTransaction(
      (prepared.signing as { transaction: string }).transaction
    )
    expect(decoded.staticAccounts).not.toContain(POOL)
  })

  it('keeps a compute budget the route already set', async () => {
    answer(
      reply(
        {},
        {
          instructions: [
            {
              p: 'ComputeBudget111111111111111111111111111111',
              a: [],
              d: Buffer.from([2, 0x40, 0x0d, 0x03, 0]).toString('base64'),
            },
            ...route().instructions,
          ],
        }
      )
    )
    const prepared = await venue().prepare(ASK, ME)
    const decoded = decodeSolanaTransaction(
      (prepared.signing as { transaction: string }).transaction
    )
    expect(decoded.instructions).toHaveLength(2)
  })

  it.each([
    [
      'another signer',
      {},
      {
        instructions: [{ p: TITAN_SWAP_PROGRAM, a: [{ p: SOMEONE, s: true, w: true }], d: 'AQ==' }],
      },
      /someone other than you/,
    ],
    [
      'a program it should not call',
      {},
      { instructions: [{ p: SOMEONE, a: [{ p: ME, s: true, w: true }], d: 'AQ==' }] },
      /./,
    ],
    ['more slippage than 1%', {}, { slippageBps: 300 }, /more slippage/],
    ['a different amount in', {}, { inAmount: '9000000' }, /not what you asked/],
    ['a different output token', { outputMint: USDC }, {}, /not what you asked/],
    ['no winner', { metadata: {} }, {}, /no route/],
    ['a table it did not send', { alts: [] }, {}, /lookup table/],
    ['a thin return', {}, { outAmount: '40000000' }, /less than it is worth/],
  ])('refuses %s', async (_name, over, routeOver, words) => {
    answer(reply(over, routeOver))
    const built = venue().prepare(ASK, ME)
    await expect(built).rejects.toBeInstanceOf(ChainActionRefused)
    await expect(built).rejects.toThrow(words)
  })

  it('refuses when Titan answers with an error', async () => {
    answer({ error: { code: 'invalid_api_key' } }, 401)
    await expect(quoteOf(venue())(ASK, ME)).rejects.toThrow(/no route/)
  })

  it('swaps only, and only for a Solana wallet', async () => {
    answer(reply())
    await expect(venue().prepare({ ...ASK, kind: 'supply' }, ME)).rejects.toThrow(/swaps tokens/)
    await expect(venue().prepare(ASK, 'nope')).rejects.toThrow(/not a Solana wallet/)
  })
})
