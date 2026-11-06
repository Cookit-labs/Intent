import {
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getTransactionDecoder,
} from '@solana/kit'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RAYDIUM_SOL_TO_USDC, RAYDIUM_WALLET } from '../chains/solana/__fixtures__/raydium-captured'
import { RAYDIUM_ROUTE_PROGRAM } from '../chains/solana/programs'
import { assertRaydiumRoute, createRaydiumSwapVenue } from '../chains/solana/raydium-swap'
import { ChainActionRefused } from '../chains/types'

import { guarded } from './solana-wallet-guards.fixture'

const { transaction, amountIn, minimumOut, outputAmount } = RAYDIUM_SOL_TO_USDC
const expected = { amountIn: BigInt(amountIn), minimumOut: BigInt(minimumOut), wrapsSol: true }
const context = { amountIn, minimumOut, wrapsSol: '1' }
const solana = (tx: string) => ({ family: 'solana' as const, transaction: tx })

/** The capture with one route instruction's data rewritten, the way a tampered build would read. */
function withRouteData(index: number, data: number[]): string {
  const { messageBytes } = getTransactionDecoder().decode(Buffer.from(transaction, 'base64'))
  const message = getCompiledTransactionMessageDecoder().decode(messageBytes)
  if (message.version !== 'legacy' && message.version !== 0) throw new Error('not v0')
  const route = message.staticAccounts.indexOf(RAYDIUM_ROUTE_PROGRAM as never)
  let seen = -1
  const instructions = message.instructions.map((ix) => {
    if (ix.programAddressIndex !== route) return ix
    seen += 1
    return seen === index ? { ...ix, data: new Uint8Array(data) } : ix
  })
  const bytes = getCompiledTransactionMessageEncoder().encode({ ...message, instructions })
  return Buffer.concat([Buffer.from([1]), Buffer.alloc(64), Buffer.from(bytes)]).toString('base64')
}

const u64 = (value: bigint): number[] =>
  Array.from({ length: 8 }, (_, i) => Number((value >> BigInt(8 * i)) & BigInt(255)))

describe('a Raydium swap Raydium built', () => {
  it('passes, held to the quote it came from', () => {
    expect(() => assertRaydiumRoute(transaction, expected)).not.toThrow()
    const venue = createRaydiumSwapVenue({ priceUsd: async () => 1 })
    expect(() => venue.assertSafe(solana(transaction), RAYDIUM_WALLET, context)).not.toThrow()
  })

  it('refuses a swap of another amount, or for less than the floor', () => {
    expect(() => assertRaydiumRoute(transaction, { ...expected, amountIn: BigInt(1) })).toThrow(
      /different amount|wrap SOL/
    )
    expect(() =>
      assertRaydiumRoute(transaction, { ...expected, minimumOut: expected.minimumOut + BigInt(1) })
    ).toThrow(/accepts less/)
  })

  it('refuses a swap whose minimum was rewritten to zero', () => {
    const tampered = withRouteData(1, [0, ...u64(expected.amountIn), ...u64(BigInt(0))])
    expect(() => assertRaydiumRoute(tampered, expected)).toThrow(/accepts less/)
  })

  it('refuses wrapping SOL when SOL is not what is spent, or more than is spent', () => {
    expect(() => assertRaydiumRoute(transaction, { ...expected, wrapsSol: false })).toThrow(
      /wrap SOL/
    )
    const more = withRouteData(0, [5, ...u64(expected.amountIn * BigInt(100))])
    expect(() => assertRaydiumRoute(more, expected)).toThrow(/wrap SOL/)
  })

  it('refuses a route instruction it can’t read', () => {
    expect(() => assertRaydiumRoute(withRouteData(2, [9]), expected)).toThrow(/didn’t expect/)
  })

  it('refuses without the quote it was built from, and any other program added', () => {
    const venue = createRaydiumSwapVenue({ priceUsd: async () => 1 })
    expect(() => venue.assertSafe(solana(transaction), RAYDIUM_WALLET, {})).toThrow(
      ChainActionRefused
    )
    const foreign = guarded(transaction, 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK')
    expect(() => venue.assertSafe(solana(foreign), RAYDIUM_WALLET, context)).toThrow(
      /Raydium should not need/
    )
  })
})

describe('Raydium’s quote and build', () => {
  afterEach(() => vi.unstubAllGlobals())

  const quoteBody = (over: Record<string, unknown> = {}) => ({
    success: true,
    data: {
      swapType: 'BaseIn',
      inputMint: 'So11111111111111111111111111111111111111112',
      outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      inputAmount: amountIn,
      outputAmount,
      otherAmountThreshold: minimumOut,
      slippageBps: 100,
      priceImpactPct: 0,
      routePlan: [{ poolId: 'CYbD9RaToYMtWKA7QZyoLahnHdWq553Vm62Lh6qWtuxq' }],
      ...over,
    },
  })

  function stub(quote: unknown, built: unknown = { success: true, data: [{ transaction }] }) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => Response.json(String(url).includes('/compute/') ? quote : built))
    )
  }

  const venue = () =>
    createRaydiumSwapVenue({
      priceUsd: async (token) => (token.symbol === 'SOL' ? 90 : 1),
      retryDelayMs: 0,
    })
  const request = { kind: 'swap' as const, amount: '0.007', tokenIn: 'SOL', tokenOut: 'USDC' }

  it('prepares the transaction Raydium built, with what the check needs to hold it', async () => {
    stub(quoteBody())
    const prepared = await venue().prepare(request, RAYDIUM_WALLET)
    expect(prepared).toMatchObject({
      venueId: 'raydium',
      signing: { family: 'solana', transaction },
      context,
    })
  })

  it('refuses a quote for another amount, too much slippage or a large price impact', async () => {
    stub(quoteBody({ inputAmount: '1' }))
    await expect(venue().quote?.(request, RAYDIUM_WALLET)).rejects.toThrow(/not what you asked/)
    stub(quoteBody({ slippageBps: 500 }))
    await expect(venue().quote?.(request, RAYDIUM_WALLET)).rejects.toThrow(/slippage/)
    stub(quoteBody({ priceImpactPct: 7 }))
    await expect(venue().quote?.(request, RAYDIUM_WALLET)).rejects.toThrow(/price impact/)
  })

  it('sends Raydium back its whole quote, route details and all', async () => {
    const sent: unknown[] = []
    const quote = quoteBody()
    const route = quote.data.routePlan[0] as Record<string, unknown>
    route['remainingAccounts'] = ['A9kPFmUkWMu99n66QGKKLXohNhR9hRFhQj3hi9JGLdqA']
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes('/compute/')) return Response.json({ ...quote, id: 'q-1' })
        sent.push(JSON.parse(String(init?.body)))
        return Response.json({ success: true, data: [{ transaction }] })
      })
    )
    await venue().prepare(request, RAYDIUM_WALLET)
    expect(sent[0]).toMatchObject({
      wallet: RAYDIUM_WALLET,
      wrapSol: true,
      swapResponse: {
        id: 'q-1',
        data: { routePlan: [{ remainingAccounts: [expect.any(String)] }] },
      },
    })
  })

  it('refuses a build of more than one transaction', async () => {
    stub(quoteBody(), { success: true, data: [{ transaction }, { transaction }] })
    await expect(venue().prepare(request, RAYDIUM_WALLET)).rejects.toThrow(
      /could not build this swap/
    )
  })
})
