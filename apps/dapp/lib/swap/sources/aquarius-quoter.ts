import { stellarNetwork } from '@intent/config'
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk'

import type { ClassicAsset } from '../assets'
import { sacFor } from '../build-soroban'
import type {
  MultiQuoteOutcome,
  QuoteFailure,
  QuoteOutcome,
  QuoteRequest,
  QuoteSource,
  SwapQuote,
} from '../quote'

/**
 * Quotes against Aquarius, a second Soroban AMM.
 *
 * Why a second router is worth having: the two disagree, and not by a little.
 * For 20 USDC, Soroswap delivers 187 XLM and Aquarius's best pool 43. For 100
 * XLM, Aquarius's deepest pool delivers 61 USDC and Soroswap 10.6. Against
 * each other they are mirror images — Soroswap ahead buying XLM by 4×,
 * Aquarius ahead selling it by 5.8× — so which router is right depends on the
 * direction of the trade. (Horizon's classic book beat both selling XLM when
 * this was measured, at 118 USDC; the point is not that Aquarius wins but
 * that no venue wins everywhere.) With one router the agents compete on
 * execution style; with two they compete on routing, which is the thing a
 * competition is for.
 *
 * Three things differ from Soroswap and will fail silently if assumed alike:
 *
 * - **Amounts are `u128`, not `i128`.** The wrong type fails in simulation
 *   with an error that names nothing about types.
 * - **The token vector must be sorted** by address string, or the router
 *   refuses it.
 * - **One pair has several pools.** XLM/USDC has three, each addressed by a
 *   32-byte `pool_index`, and `estimate_swap` prices exactly one of them. The
 *   index is carried on the quote so the builder executes the pool that was
 *   compared, not one it re-derived.
 *
 * All verified against the live router before this was written, by reading
 * its spec and simulating each pool.
 */

/** Aquarius's testnet router. Confirmed live on 2026-09-17; a reset can remove it. */
export const AQUARIUS_ROUTER = 'CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD'

/**
 * Simulation needs a source account but never submits, so any well-formed
 * address works. The all-zero account is used rather than a third party's,
 * so quoting does not depend on somebody else keeping an account funded.
 */
const SIMULATION_SOURCE = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'

export interface AquariusQuoterOptions {
  rpcUrl?: string
  routerId?: string
  /** Set false to disable the source without removing it from the list. */
  enabled?: boolean
  /** Injected in tests, so pool handling is checkable without a network. */
  serverImpl?: Pick<rpc.Server, 'simulateTransaction'>
}

/**
 * The router wants its token pair in address order, and returns pools keyed
 * by index. Which side is "first" changes with the pair, so the order is
 * computed rather than assumed — XLM's SAC sorts after USDC's, for instance.
 */
function sortedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a]
}

/**
 * A `Map<BytesN<32>, Address>` as `scValToNative` hands it back.
 *
 * The SDK has returned this as a `Map` keyed by `Uint8Array` and, in other
 * versions, as a plain object whose keys are the bytes joined by commas. Both
 * are read, because a quoter that handled one and met the other would report
 * "no pools" for a pair that has three.
 */
function poolsOf(native: unknown): { index: Buffer; address: string }[] {
  const entries: [unknown, unknown][] =
    native instanceof Map
      ? [...native.entries()]
      : native !== null && typeof native === 'object'
        ? Object.entries(native as Record<string, unknown>)
        : []

  const pools: { index: Buffer; address: string }[] = []
  for (const [key, value] of entries) {
    if (typeof value !== 'string') continue
    const index =
      key instanceof Uint8Array
        ? Buffer.from(key)
        : typeof key === 'string' && /^[\d,]+$/.test(key)
          ? Buffer.from(key.split(',').map(Number))
          : undefined
    if (index === undefined || index.length !== 32) continue
    pools.push({ index, address: value })
  }
  return pools
}

function failure(reason: QuoteFailure['reason'], detail?: string): QuoteOutcome {
  return { ok: false, failure: { source: 'aquarius', reason, ...(detail ? { detail } : {}) } }
}

export function createAquariusQuoter(options: AquariusQuoterOptions = {}): QuoteSource {
  const rpcUrl = options.rpcUrl ?? stellarNetwork.sorobanRpcUrl
  const routerId = options.routerId ?? AQUARIUS_ROUTER
  const enabled = options.enabled ?? true

  function server(): Pick<rpc.Server, 'simulateTransaction'> {
    return options.serverImpl ?? new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') })
  }

  async function simulate(fn: string, args: xdr.ScVal[]): Promise<unknown> {
    const tx = new TransactionBuilder(new Account(SIMULATION_SOURCE, '0'), {
      fee: BASE_FEE,
      networkPassphrase: stellarNetwork.networkPassphrase,
    })
      .addOperation(new Contract(routerId).call(fn, ...args))
      .setTimeout(30)
      .build()

    const sim = await server().simulateTransaction(tx)
    if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error)
    if (sim.result === undefined) throw new Error(`${fn} returned nothing`)
    return scValToNative(sim.result.retval)
  }

  function contractFor(asset: ClassicAsset): string | undefined {
    try {
      return sacFor(asset)
    } catch {
      return undefined
    }
  }

  async function quoteAll(req: QuoteRequest): Promise<MultiQuoteOutcome> {
    // Fixed-input only, as with Soroswap. The router has a strict-receive
    // path, but nothing here has ever filled one, and quoting a shape this
    // source has never executed would be worse than declining.
    if (req.kind !== 'strict_send') {
      return { ok: false, failure: { source: 'aquarius', reason: 'unsupported_pair' } }
    }

    const fromContract = contractFor(req.from)
    const toContract = contractFor(req.to)
    if (fromContract === undefined || toContract === undefined) {
      return { ok: false, failure: { source: 'aquarius', reason: 'unsupported_pair' } }
    }

    const pair = sortedPair(fromContract, toContract)
    const tokens = xdr.ScVal.scvVec(pair.map((c) => new Address(c).toScVal()))

    let pools: { index: Buffer; address: string }[]
    try {
      pools = poolsOf(await simulate('get_pools', [tokens]))
    } catch (e) {
      // No pool for the pair is an ordinary answer, not a fault.
      return {
        ok: false,
        failure: {
          source: 'aquarius',
          reason: 'no_route',
          ...(e instanceof Error ? { detail: e.message } : {}),
        },
      }
    }
    if (pools.length === 0) {
      return { ok: false, failure: { source: 'aquarius', reason: 'no_route' } }
    }

    const quotedAt = new Date().toISOString()
    const quotes: SwapQuote[] = []

    for (const pool of pools) {
      // A pool that cannot price the trade — drained, or too shallow for the
      // size — is skipped rather than failing the whole venue. The others
      // may still answer.
      let out: unknown
      try {
        out = await simulate('estimate_swap', [
          tokens,
          new Address(fromContract).toScVal(),
          new Address(toContract).toScVal(),
          xdr.ScVal.scvBytes(pool.index),
          // u128, not i128. The router's spec says so and the wrong one fails
          // with an error that mentions neither.
          nativeToScVal(BigInt(req.sendAmount), { type: 'u128' }),
        ])
      } catch {
        continue
      }

      let dest: bigint
      try {
        dest = BigInt(String(out))
      } catch {
        continue
      }
      if (dest <= BigInt(0)) continue

      quotes.push({
        source: 'aquarius',
        kind: 'strict_send',
        from: req.from,
        to: req.to,
        sendAmount: req.sendAmount,
        destAmount: dest.toString(),
        // A single pool is a direct swap; there are no hops to replay.
        path: [],
        // Which pool this price came from. The builder executes this one and
        // no other, so an agent's choice between the three cannot be
        // silently overridden at signing time.
        poolIndex: pool.index.toString('hex'),
        // `sacFor` derives the canonical Stellar Asset Contract, which *is*
        // the classic asset reachable from Soroban — so this route settles in
        // the same asset the user named and `deliversAsset` stays unset.
        quotedAt,
      })
    }

    if (quotes.length === 0) {
      return { ok: false, failure: { source: 'aquarius', reason: 'no_route' } }
    }

    // Best first, so a caller that takes only one gets the right one.
    quotes.sort((a, b) => (BigInt(b.destAmount) > BigInt(a.destAmount) ? 1 : -1))
    return { ok: true, quotes }
  }

  return {
    id: 'aquarius',
    displayName: 'Aquarius',
    isConfigured: () => enabled && rpcUrl !== '',

    async quote(req: QuoteRequest): Promise<QuoteOutcome> {
      try {
        const all = await quoteAll(req)
        if (!all.ok) return { ok: false, failure: all.failure }
        const best = all.quotes[0]
        return best === undefined ? failure('no_route') : { ok: true, quote: best }
      } catch (e) {
        const aborted = e instanceof Error && e.name === 'AbortError'
        return failure(
          aborted ? 'timeout' : 'upstream_error',
          e instanceof Error ? e.message : undefined
        )
      }
    },

    async quoteAll(req: QuoteRequest): Promise<MultiQuoteOutcome> {
      try {
        return await quoteAll(req)
      } catch (e) {
        const aborted = e instanceof Error && e.name === 'AbortError'
        return {
          ok: false,
          failure: {
            source: 'aquarius',
            reason: aborted ? 'timeout' : 'upstream_error',
            ...(e instanceof Error ? { detail: e.message } : {}),
          },
        }
      }
    },
  }
}
