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
import { phoenixFactory } from '../contract-registry'
import type {
  MultiQuoteOutcome,
  QuoteFailure,
  QuoteOutcome,
  QuoteRequest,
  QuoteSource,
  SwapQuote,
} from '../quote'

/**
 * Quotes against Phoenix, a third Soroban AMM, mainnet only.
 *
 * Structurally different from Aquarius and Soroswap: there is no single
 * router. A **factory** contract looks pools up by token pair; each pair's
 * liquidity lives in its own **pool** contract, addressed by its own
 * contract id rather than an index into a router. A direct quote is
 * therefore two calls — ask the factory for the pool, then ask that pool to
 * price the trade — not one call against a known router id.
 *
 * Everything below was verified live against mainnet Soroban RPC on
 * 2026-10-28, by simulating each call named, not read from the contracts'
 * Rust source alone:
 *
 * - **The factory and pool addresses are real and corroborate each other.**
 *   `factory.get_config()` returned a `multihop_address` matching
 *   Phoenix's own `scripts/upgrade_mainnet.sh` byte for byte — two
 *   independent sources agreeing is stronger evidence than either alone.
 * - **`query_for_pool_by_token_pair` does not care about argument order.**
 *   Called with (XLM, USDC) and (USDC, XLM) and got back the identical pool
 *   address both times. Unlike Aquarius, there is no pair-sorting step here
 *   — porting Aquarius's `sortedPair` to Phoenix would be dead code.
 * - **Amounts are `i128`**, matching Soroswap, not Aquarius's `u128`.
 * - **`simulate_swap`'s `ask_amount` is the net amount a trade actually
 *   delivers; `total_return` is not.** For a live 100 XLM → USDC simulation,
 *   `ask_amount + commission_amount + spread_amount === total_return`
 *   exactly (167408485 + 841248 + 1605936 = 169855679, confirmed again on
 *   the reverse-direction swap with different numbers) — so `total_return`
 *   is the pre-fee, idealised figure and `ask_amount` is the real one. Using
 *   `total_return` as `destAmount` would overstate what a user receives by
 *   the fee and the spread. This is the field this quoter uses; getting it
 *   backwards here would be a real, money-shaped bug.
 *
 * Not verified live, and out of scope here: the **multihop** contract (a
 * thin orchestrator over several pools, for routes with no direct pair) —
 * a throwaway encoding attempt failed and was not pursued, since a direct
 * quoter needs nothing from it. Add it only once its own `simulate_swap`
 * has been exercised against a live call, not just read from source.
 */

const SIMULATION_SOURCE = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'

export interface PhoenixQuoterOptions {
  rpcUrl?: string
  factoryId?: string
  /** Set false to disable the source without removing it from the list. */
  enabled?: boolean
  /** Injected in tests, so pool handling is checkable without a network. */
  serverImpl?: Pick<rpc.Server, 'simulateTransaction'>
}

/**
 * `{ ok: false, failure }` is the same shape in `QuoteOutcome` and
 * `MultiQuoteOutcome`, so this is usable from either — annotated with
 * neither, so it structurally fits both rather than being pinned to one.
 */
function failure(
  reason: QuoteFailure['reason'],
  detail?: string
): { ok: false; failure: QuoteFailure } {
  return { ok: false, failure: { source: 'phoenix', reason, ...(detail ? { detail } : {}) } }
}

export function createPhoenixQuoter(options: PhoenixQuoterOptions = {}): QuoteSource {
  const rpcUrl = options.rpcUrl ?? stellarNetwork.sorobanRpcUrl
  const factoryId = options.factoryId ?? phoenixFactory()
  const enabled = options.enabled ?? true

  function server(): Pick<rpc.Server, 'simulateTransaction'> {
    return options.serverImpl ?? new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') })
  }

  async function simulate(contractId: string, fn: string, args: xdr.ScVal[]): Promise<unknown> {
    const tx = new TransactionBuilder(new Account(SIMULATION_SOURCE, '0'), {
      fee: BASE_FEE,
      networkPassphrase: stellarNetwork.networkPassphrase,
    })
      .addOperation(new Contract(contractId).call(fn, ...args))
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
    // Fixed-input only, matching Aquarius and Soroswap: nothing here has
    // exercised Phoenix's reverse-swap path, and quoting a shape never run
    // live would be worse than declining.
    if (req.kind !== 'strict_send') {
      return { ok: false, failure: { source: 'phoenix', reason: 'unsupported_pair' } }
    }
    if (factoryId === undefined) {
      // Mainnet only; the caller should not have asked on testnet, but a
      // defensive no_route is cheaper than an exception.
      return { ok: false, failure: { source: 'phoenix', reason: 'unsupported_pair' } }
    }

    const fromContract = contractFor(req.from)
    const toContract = contractFor(req.to)
    if (fromContract === undefined || toContract === undefined) {
      return { ok: false, failure: { source: 'phoenix', reason: 'unsupported_pair' } }
    }

    let poolAddress: string
    try {
      // Order genuinely does not matter here — verified live both ways —
      // unlike Aquarius, so the two contracts are passed as asked.
      const pool = await simulate(factoryId, 'query_for_pool_by_token_pair', [
        new Address(fromContract).toScVal(),
        new Address(toContract).toScVal(),
      ])
      if (typeof pool !== 'string' || pool === '') throw new Error('factory named no pool')
      poolAddress = pool
    } catch (e) {
      // No pool for the pair is an ordinary answer, not a fault.
      return {
        ok: false,
        failure: {
          source: 'phoenix',
          reason: 'no_route',
          ...(e instanceof Error ? { detail: e.message } : {}),
        },
      }
    }

    let response: unknown
    try {
      response = await simulate(poolAddress, 'simulate_swap', [
        new Address(fromContract).toScVal(),
        // i128, not u128 — Phoenix's pool interface, unlike Aquarius's router.
        nativeToScVal(BigInt(req.sendAmount), { type: 'i128' }),
      ])
    } catch (e) {
      return failure('upstream_error', e instanceof Error ? e.message : undefined)
    }

    const askAmount =
      response !== null && typeof response === 'object' && 'ask_amount' in response
        ? (response as { ask_amount: unknown }).ask_amount
        : undefined

    let dest: bigint
    try {
      dest = BigInt(String(askAmount))
    } catch {
      return failure('upstream_error', 'the pool returned no ask_amount')
    }
    if (dest <= BigInt(0)) return failure('no_route')

    const quote: SwapQuote = {
      source: 'phoenix',
      kind: 'strict_send',
      from: req.from,
      to: req.to,
      sendAmount: req.sendAmount,
      destAmount: dest.toString(),
      // A single pool is a direct swap; there are no hops to replay.
      path: [],
      // The exact pool this price came from. The builder signs only this
      // address, the same discipline poolIndex enforces for Aquarius.
      poolAddress,
      quotedAt: new Date().toISOString(),
    }
    return { ok: true, quotes: [quote] }
  }

  return {
    id: 'phoenix',
    displayName: 'Phoenix',
    isConfigured: () => enabled && factoryId !== undefined && rpcUrl !== '',

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
            source: 'phoenix',
            reason: aborted ? 'timeout' : 'upstream_error',
            ...(e instanceof Error ? { detail: e.message } : {}),
          },
        }
      }
    },
  }
}
