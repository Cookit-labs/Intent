import { stellarTestnet } from '@intent/config'
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
import type { QuoteOutcome, QuoteRequest, QuoteSource } from '../quote'

/**
 * Quotes against Soroswap, a Soroban AMM.
 *
 * This is genuinely separate liquidity from Horizon's: Stellar's classic DEX
 * and a Soroban contract are different pools with different depth, so asking
 * both is real aggregation rather than the same book twice. On testnet the two
 * disagree by an order of magnitude, because both are synthetically seeded.
 *
 * The price comes from *simulating* `router_get_amounts_out`. Soroswap
 * publishes a router address but no working quote API — every documented
 * `/quote` path 404s — and simulation returns what a swap would actually pay
 * without submitting anything, costing a fee, or needing a funded account.
 *
 * **The assets are not interchangeable.** Soroban tokens are addressed by
 * contract id, and Soroswap's USDC is a different contract from Circle's
 * classic issuer. A route from here delivers a different USDC than one from
 * Horizon, which is why quotes carry their venue rather than being presented
 * as one comparable number.
 */

/** Soroswap's testnet router. */
const ROUTER = 'CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD'

/**
 * Soroban contract ids for the assets this app trades.
 *
 * Explicit rather than resolved: a wrong id quotes the wrong asset, and the
 * number that comes back gives no hint that it happened.
 */
const CONTRACTS: Record<string, string> = {
  XLM: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
  USDC: 'CB3TLW74NBIOT3BUWOZ3TUM6RFDF6A4GVIRUQRQZABG5KPOUL4JJOV2F',
}

/**
 * Simulation needs a source account but never submits, so any funded account
 * works. This is Soroswap's own router deployer — a read-only stand-in.
 */
const SIMULATION_SOURCE = 'GBAJABFE3AP4CIZBJB2ZVMFBHNRSOHTAGYS5ODM3MAHNFRMZOWQKMXUH'

export interface SoroswapQuoterOptions {
  rpcUrl?: string
  routerId?: string
  /** Set false to disable the source without removing it from the list. */
  enabled?: boolean
}

function contractFor(asset: ClassicAsset): string | undefined {
  return CONTRACTS[asset.code.toUpperCase()]
}

export function createSoroswapQuoter(options: SoroswapQuoterOptions = {}): QuoteSource {
  const rpcUrl = options.rpcUrl ?? stellarTestnet.sorobanRpcUrl
  const routerId = options.routerId ?? ROUTER
  const enabled = options.enabled ?? true

  return {
    id: 'soroswap',
    displayName: 'Soroswap',
    isConfigured: () => enabled && rpcUrl !== '',

    async quote(req: QuoteRequest): Promise<QuoteOutcome> {
      const fromContract = contractFor(req.from)
      const toContract = contractFor(req.to)

      if (fromContract === undefined || toContract === undefined) {
        // Soroswap can only price assets that exist as Soroban tokens.
        return { ok: false, failure: { source: 'soroswap', reason: 'unsupported_pair' } }
      }

      // Fixed-input only. The router exposes `router_get_amounts_in` for the
      // reverse, but limit orders route through Horizon today, and quoting a
      // path this source has never filled would be worse than declining.
      if (req.kind !== 'strict_send') {
        return { ok: false, failure: { source: 'soroswap', reason: 'unsupported_pair' } }
      }

      try {
        const server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') })
        const contract = new Contract(routerId)

        const path = xdr.ScVal.scvVec([
          new Address(fromContract).toScVal(),
          new Address(toContract).toScVal(),
        ])

        // Sequence 0 is fine: simulation never submits, so the number is
        // never checked against the network.
        const source = new Account(SIMULATION_SOURCE, '0')

        const tx = new TransactionBuilder(source, {
          fee: BASE_FEE,
          networkPassphrase: stellarTestnet.networkPassphrase,
        })
          .addOperation(
            contract.call(
              'router_get_amounts_out',
              nativeToScVal(BigInt(req.sendAmount), { type: 'i128' }),
              path
            )
          )
          .setTimeout(30)
          .build()

        const sim = await server.simulateTransaction(tx)

        if (rpc.Api.isSimulationError(sim)) {
          // Usually means no pool exists for the pair — an ordinary outcome.
          return {
            ok: false,
            failure: { source: 'soroswap', reason: 'no_route', detail: sim.error },
          }
        }

        const retval = sim.result?.retval
        if (retval === undefined) {
          return { ok: false, failure: { source: 'soroswap', reason: 'no_route' } }
        }

        // The router returns amounts along the path; the last is what arrives.
        const amounts = scValToNative(retval) as unknown
        if (!Array.isArray(amounts) || amounts.length < 2) {
          return { ok: false, failure: { source: 'soroswap', reason: 'no_route' } }
        }

        const destAmount = amounts[amounts.length - 1] as bigint | number | string
        const dest = BigInt(destAmount)
        if (dest <= BigInt(0)) {
          return { ok: false, failure: { source: 'soroswap', reason: 'no_route' } }
        }

        return {
          ok: true,
          quote: {
            source: 'soroswap',
            kind: 'strict_send',
            from: req.from,
            to: req.to,
            sendAmount: req.sendAmount,
            destAmount: dest.toString(),
            // The router quotes a direct pair here, so there are no hops to
            // replay. Multi-hop routing would need the path echoed back.
            path: [],
            // `to` names the classic asset the user asked for, but this route
            // settles in Soroswap's own token. Stated rather than implied: a
            // builder that ignored the difference would sign a transaction for
            // an asset the user never chose.
            deliversAsset: { kind: 'contract', code: req.to.code, contract: toContract },
            quotedAt: new Date().toISOString(),
          },
        }
      } catch (e) {
        const aborted = e instanceof Error && e.name === 'AbortError'
        return {
          ok: false,
          failure: {
            source: 'soroswap',
            reason: aborted ? 'timeout' : 'upstream_error',
            ...(e instanceof Error ? { detail: e.message } : {}),
          },
        }
      }
    },
  }
}

export { ROUTER as SOROSWAP_ROUTER, CONTRACTS as SOROSWAP_CONTRACTS }
