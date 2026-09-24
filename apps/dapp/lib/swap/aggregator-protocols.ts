import { stellarNetwork } from '@intent/config'
import {
  Account,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk'

import type { AggregatorProtocol } from './soroswap-api'

/**
 * Which venues the aggregator may be asked to route through, decided at
 * runtime from the contract and the ledger.
 *
 * The API accepts `phoenix` in every request, and the address file committed
 * to Soroswap's own repository lists a Phoenix adapter for testnet. Both are
 * wrong about testnet today. Simulating `get_adapters()` on the live
 * aggregator on 2026-09-23 returned three unpaused adapters — protocol 0 at
 * Soroswap's router, 1 at `CBAMPJTMNDXBBYYQ77C7WX2MTBR3XZHERDJ7NQMXLEZHMWUFQBQMFTOC`,
 * 2 at Aquarius's router — and reading the second one's instance from the
 * ledger found nothing there. A quote routed through it can come back priced
 * and then fail when the transaction executes.
 *
 * So the list is the intersection of two things, neither of them a file:
 *
 * - what the app has verified a swap through, in `ALLOWED_PROTOCOLS`; and
 * - what the aggregator currently names *and the ledger currently has*,
 *   unpaused.
 *
 * `sdex` is the exception in shape only. The classic order book has no
 * adapter — the API fills it with a path payment of its own — so it is
 * offered whenever the aggregator is reachable at all.
 */

/**
 * The protocols this app will name in a request. The request vocabulary is
 * wider (`phoenix`, `comet`, `sushi`); each of those joins this list only
 * after somebody has executed a swap through it on testnet and read the
 * result, not when its adapter happens to exist.
 */
export const ALLOWED_PROTOCOLS: readonly AggregatorProtocol[] = ['soroswap', 'aqua', 'sdex']

/**
 * The contract's `Protocol` enum, `#[repr(u32)]`: `Soroswap = 0, Phoenix = 1,
 * Aqua = 2, Comet = 3`. `get_adapters()` returns the discriminant, and the
 * API speaks names, so the mapping has to live somewhere.
 */
const PROTOCOL_BY_ID: Record<number, AggregatorProtocol> = {
  0: 'soroswap',
  1: 'phoenix',
  2: 'aqua',
  3: 'comet',
}

/** How long a resolved list is trusted before the contract is asked again. */
export const PROTOCOLS_TTL_MS = 5 * 60_000

export interface AdapterStatus {
  /** A protocol name, or the raw discriminant for one this build does not know. */
  protocol: AggregatorProtocol | `unknown:${number}`
  router: string
  paused: boolean
  /** Whether the adapter's contract instance exists on the ledger right now. */
  deployed: boolean
}

export interface ProtocolWhitelist {
  /** What to put in the request, in `ALLOWED_PROTOCOLS` order. */
  protocols: AggregatorProtocol[]
  /** Every adapter the contract named, with what the ledger said about it. */
  adapters: AdapterStatus[]
  resolvedAt: number
}

export interface ResolveProtocolsOptions {
  aggregatorId: string
  rpcUrl?: string
  /** Injected in tests, so the whitelist is checkable without a network. */
  serverImpl?: Pick<rpc.Server, 'simulateTransaction' | 'getContractData'>
  now?: () => number
  ttlMs?: number
}

/**
 * Simulation needs a source account but never submits, so the all-zero
 * account is used rather than a third party's — the same choice the Aquarius
 * quoter makes, and for the same reason.
 */
const SIMULATION_SOURCE = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'

/** Keyed by RPC and aggregator id, module-level for the reason `soroswap-api.ts` gives. */
const cache = new Map<string, ProtocolWhitelist & { expiresAt: number }>()

/** For tests, which otherwise share the cache above. */
export function resetAggregatorProtocolCache(): void {
  cache.clear()
}

interface RawAdapter {
  protocol_id?: unknown
  router?: unknown
  paused?: unknown
}

function readAdapters(native: unknown): { id: number; router: string; paused: boolean }[] {
  if (!Array.isArray(native)) return []
  const out: { id: number; router: string; paused: boolean }[] = []
  for (const item of native as RawAdapter[]) {
    const id = Number(item?.protocol_id)
    const router = item?.router
    if (!Number.isInteger(id) || typeof router !== 'string') continue
    out.push({ id, router, paused: item?.paused === true })
  }
  return out
}

/**
 * The protocols that can be asked for right now, or nothing if the contract
 * could not be read. Never throws: a source that cannot learn its whitelist
 * declines to quote, and the caller reports that as unavailable.
 */
export async function resolveAggregatorProtocols(
  options: ResolveProtocolsOptions
): Promise<ProtocolWhitelist | undefined> {
  const rpcUrl = options.rpcUrl ?? stellarNetwork.sorobanRpcUrl
  const now = options.now ?? Date.now
  const ttl = options.ttlMs ?? PROTOCOLS_TTL_MS
  const key = `${rpcUrl}|${options.aggregatorId}`

  const cached = cache.get(key)
  if (cached !== undefined && cached.expiresAt > now()) return cached

  const server =
    options.serverImpl ?? new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') })

  let adapters: { id: number; router: string; paused: boolean }[]
  try {
    const tx = new TransactionBuilder(new Account(SIMULATION_SOURCE, '0'), {
      fee: BASE_FEE,
      networkPassphrase: stellarNetwork.networkPassphrase,
    })
      .addOperation(new Contract(options.aggregatorId).call('get_adapters'))
      .setTimeout(30)
      .build()

    const sim = await server.simulateTransaction(tx)
    if (rpc.Api.isSimulationError(sim) || sim.result === undefined) return undefined
    adapters = readAdapters(scValToNative(sim.result.retval))
  } catch {
    return undefined
  }
  if (adapters.length === 0) return undefined

  // Each adapter checked against the ledger, because the contract's list is
  // only what an admin last wrote there. Reading the instance key is the
  // cheapest question that distinguishes "deployed" from "named".
  const statuses: AdapterStatus[] = await Promise.all(
    adapters.map(async (a) => {
      let deployed = false
      try {
        await server.getContractData(
          a.router,
          xdr.ScVal.scvLedgerKeyContractInstance(),
          rpc.Durability.Persistent
        )
        deployed = true
      } catch {
        deployed = false
      }
      return {
        protocol: PROTOCOL_BY_ID[a.id] ?? (`unknown:${a.id}` as const),
        router: a.router,
        paused: a.paused,
        deployed,
      }
    })
  )

  const live = new Set(
    statuses.filter((s) => s.deployed && !s.paused).map((s) => s.protocol as string)
  )
  const protocols = ALLOWED_PROTOCOLS.filter((p) => p === 'sdex' || live.has(p))

  const resolved: ProtocolWhitelist & { expiresAt: number } = {
    protocols,
    adapters: statuses,
    resolvedAt: now(),
    expiresAt: now() + ttl,
  }
  cache.set(key, resolved)
  return resolved
}
