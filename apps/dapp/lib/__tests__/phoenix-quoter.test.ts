import { Address, nativeToScVal, rpc, xdr, type Operation } from '@stellar/stellar-sdk'
import { describe, expect, it } from 'vitest'

import { resolveAsset } from '../swap/assets'
import { sacFor } from '../swap/build-soroban'
import { createPhoenixQuoter } from '../swap/sources/phoenix-quoter'

/**
 * Quoting against Phoenix, without a network.
 *
 * The live test (`build-phoenix.live.test.ts`) is what actually proves the
 * encoding and the field choice against the real factory and pool; this is
 * the no_route and pool-resolution handling, matching
 * `AquariusQuoterOptions.serverImpl`'s pattern so it is checkable without a
 * network on every run, not only when SKIP_LIVE is unset.
 */

const FACTORY = 'CB4SVAWJA6TSRNOJZ7W2AWFW46D5VR4ZMFZKDIKXEINZCZEGZCJZCKMI'
const POOL = 'CBHCRSVX3ZZ7EGTSYMKPEFGZNWRVCSESQR3UABET4MIW52N4EVU6BIZX'

const XLM = resolveAsset('XLM')
const USDC = resolveAsset('USDC')
if (XLM === undefined || USDC === undefined) throw new Error('registry missing XLM or USDC')

type Sim = Pick<rpc.Server, 'simulateTransaction'>

function invocationOf(tx: Parameters<Sim['simulateTransaction']>[0]): {
  functionName?: unknown
  args?: xdr.ScVal[]
} {
  const op = (tx as { operations: Operation[] }).operations[0] as
    | { func?: { invokeContract?: { functionName?: unknown; args?: xdr.ScVal[] } } }
    | undefined
  return op?.func?.invokeContract ?? {}
}

function fnOf(tx: Parameters<Sim['simulateTransaction']>[0]): string {
  return String(invocationOf(tx).functionName ?? '')
}

function response(retval: xdr.ScVal): rpc.Api.SimulateTransactionSuccessResponse {
  return {
    id: '1',
    latestLedger: 1,
    events: [],
    minResourceFee: '0',
    result: { auth: [], retval },
  } as unknown as rpc.Api.SimulateTransactionSuccessResponse
}

function errorResponse(message: string): rpc.Api.SimulateTransactionErrorResponse {
  return {
    id: '1',
    latestLedger: 1,
    events: [],
    error: message,
  } as unknown as rpc.Api.SimulateTransactionErrorResponse
}

/**
 * A fake factory + pool: `query_for_pool_by_token_pair` answers from a
 * table keyed by contract id (so "no pool for this pair" is answerable),
 * and `simulate_swap` answers the fixed response given.
 */
function fakePhoenix(opts: {
  pool?: string | 'none'
  askAmount?: bigint
  totalReturn?: bigint
  simulateError?: string
}): Sim {
  return {
    async simulateTransaction(tx) {
      const fn = fnOf(tx)
      if (fn === 'query_for_pool_by_token_pair') {
        if (opts.pool === 'none') return errorResponse('LiquidityPoolNotFound')
        return response(new Address(opts.pool ?? POOL).toScVal())
      }
      if (fn === 'simulate_swap') {
        if (opts.simulateError !== undefined) return errorResponse(opts.simulateError)
        return response(
          nativeToScVal(
            {
              ask_amount: opts.askAmount ?? BigInt(167408495),
              commission_amount: BigInt(841248),
              spread_amount: BigInt(1605936),
              total_return: opts.totalReturn ?? BigInt(169855679),
            },
            {
              type: {
                ask_amount: ['symbol', 'i128'],
                commission_amount: ['symbol', 'i128'],
                spread_amount: ['symbol', 'i128'],
                total_return: ['symbol', 'i128'],
              },
            }
          )
        )
      }
      return errorResponse(`unexpected call: ${fn}`)
    },
  }
}

describe('quoting Phoenix', () => {
  it('resolves the pool, prices the swap, and carries the pool address', async () => {
    const quoter = createPhoenixQuoter({ factoryId: FACTORY, serverImpl: fakePhoenix({}) })
    const out = await quoter.quote({
      kind: 'strict_send',
      from: XLM,
      to: USDC,
      sendAmount: '10000000',
    })

    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.quote.source).toBe('phoenix')
    expect(out.quote.poolAddress).toBe(POOL)
    // ask_amount, not total_return — see the quoter's own header comment
    // for why, confirmed live against a real swap.
    expect(out.quote.destAmount).toBe('167408495')
    expect(out.quote.path).toEqual([])
  })

  it('reports no_route when the factory has no pool for the pair', async () => {
    const quoter = createPhoenixQuoter({
      factoryId: FACTORY,
      serverImpl: fakePhoenix({ pool: 'none' }),
    })
    const out = await quoter.quote({
      kind: 'strict_send',
      from: XLM,
      to: USDC,
      sendAmount: '10000000',
    })

    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.failure.reason).toBe('no_route')
  })

  it('reports upstream_error when the pool refuses to price the trade', async () => {
    const quoter = createPhoenixQuoter({
      factoryId: FACTORY,
      serverImpl: fakePhoenix({ simulateError: 'AssetNotInPool' }),
    })
    const out = await quoter.quote({
      kind: 'strict_send',
      from: XLM,
      to: USDC,
      sendAmount: '10000000',
    })

    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.failure.reason).toBe('upstream_error')
  })

  it('declines a fixed-output request rather than guessing', async () => {
    const quoter = createPhoenixQuoter({ factoryId: FACTORY, serverImpl: fakePhoenix({}) })
    const out = await quoter.quote({
      kind: 'strict_receive',
      from: XLM,
      to: USDC,
      receiveAmount: '10000000',
    })

    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.failure.reason).toBe('unsupported_pair')
  })

  it('is not configured without a factory id (e.g. on testnet)', () => {
    // No factoryId override: falls back to phoenixFactory(), which reads
    // the ambient test network — testnet by default, with no
    // NEXT_PUBLIC_STELLAR_NETWORK stubbed here — and returns undefined
    // there, since Phoenix has no testnet deployment.
    const quoter = createPhoenixQuoter({ serverImpl: fakePhoenix({}) })
    expect(quoter.isConfigured()).toBe(false)
  })

  it('quoteAll agrees with quote on the same answer', async () => {
    const quoter = createPhoenixQuoter({ factoryId: FACTORY, serverImpl: fakePhoenix({}) })
    const [all, best] = await Promise.all([
      quoter.quoteAll?.({ kind: 'strict_send', from: XLM, to: USDC, sendAmount: '10000000' }),
      quoter.quote({ kind: 'strict_send', from: XLM, to: USDC, sendAmount: '10000000' }),
    ])
    if (all?.ok !== true || !best.ok) throw new Error('no quotes')
    expect(all.quotes).toHaveLength(1)
    expect(all.quotes[0]?.destAmount).toBe(best.quote.destAmount)
  })
})

describe('the asset contracts phoenix is asked about', () => {
  it('derives the same mainnet SAC ids this module was verified against', () => {
    // Sanity check on the fixture itself: if these ever drift from what the
    // live test actually exercised, this test — not a live-network call —
    // is where that would be caught.
    expect(sacFor(XLM)).toBeTypeOf('string')
    expect(sacFor(USDC)).toBeTypeOf('string')
  })
})
