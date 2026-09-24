import { keccak_256 } from '@noble/hashes/sha3'
import {
  Account,
  BASE_FEE,
  Contract,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk'

import { NameLookupFailed, NameNotFound } from './errors'
import { domainLabels, isSorobanDomain } from './kind'

/**
 * `.xlm` names, resolved through the SorobanDomains registry.
 *
 * **The registry is on mainnet and the payment is on testnet.** That is not a
 * mismatch this module can fix: the registry has no testnet deployment (the
 * app at app.sorobandomains.org references none), so a name can only be asked
 * about where it exists. The card says so — "resolved on Stellar mainnet" —
 * because the account a name points at may hold nothing on testnet, and the
 * user should know which network answered.
 *
 * A name is a keccak node, hashed the way the registry hashes it:
 * `keccak(keccak(tld) ‖ keccak(label))` for a root name, and for each
 * subdomain `keccak(keccak(parent) ‖ keccak(sub))`. The order matters and is
 * silent when wrong — a reversed concatenation is still 32 plausible bytes
 * that resolve to nothing — which is why the test computes the node from the
 * formula rather than pinning a constant.
 */

export const SOROBAN_DOMAINS_REGISTRY = 'CC75Z72OCE667WVPQOROIWDAGBOXFNJ4VQONQEURL74EYIDLWA4F7FEN'
export const SOROBAN_DOMAINS_RPC = 'https://mainnet.sorobanrpc.com'
const SOROBAN_DOMAINS_RPC_FALLBACK = 'https://rpc.lightsail.network'
/** Simulation needs a funded source; this one is public and never signs. */
export const SOROBAN_DOMAINS_SIMULATION_ACCOUNT =
  'GALAXYVOIDAOPZTDLHILAJQKCVVFMD4IKLXLSZV5YHO7VY74IWZILUTO'

/** The registry's error for a node it holds no record under. */
const NOT_FOUND_CODE = '#307'

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

export function domainNode(name: string): Uint8Array {
  const labels = domainLabels(name)
  const tld = labels.pop() ?? ''
  const root = labels.pop() ?? ''
  let node = keccak_256(concat(keccak_256(utf8(tld)), keccak_256(utf8(root))))
  // Nearest the root first: the parent of "a" in "a.b.deon.xlm" is "b.deon.xlm".
  for (const sub of labels.reverse()) {
    node = keccak_256(concat(keccak_256(node), keccak_256(utf8(sub))))
  }
  return node
}

export interface ResolveDomainOptions {
  /** Injected in tests, so the lookup is checkable without a network. */
  serverImpl?: Pick<rpc.Server, 'simulateTransaction'>
  rpcUrl?: string
}

type RecordKind = 'Domain' | 'SubDomain'

function recordKindOf(name: string): RecordKind {
  return domainLabels(name).length > 2 ? 'SubDomain' : 'Domain'
}

function recordKey(name: string, kind: RecordKind): xdr.ScVal {
  return xdr.ScVal.scvVec([
    nativeToScVal(kind, { type: 'symbol' }),
    xdr.ScVal.scvBytes(Buffer.from(domainNode(name))),
  ])
}

function lookupTransaction(name: string, kind: RecordKind) {
  return new TransactionBuilder(new Account(SOROBAN_DOMAINS_SIMULATION_ACCOUNT, '0'), {
    fee: BASE_FEE,
    networkPassphrase: Networks.PUBLIC,
  })
    .addOperation(new Contract(SOROBAN_DOMAINS_REGISTRY).call('record', recordKey(name, kind)))
    .setTimeout(60)
    .build()
}

/**
 * The address a record names, read from the registry's tuple.
 *
 * `record` returns `(Domain, Option<SubDomain>)`, which decodes to a
 * two-element array. For a root name the first slot is the answer. For a
 * subdomain the first slot is the *parent* — a real account, and the wrong
 * one to pay — so the second slot is required, and a missing one is a
 * refusal rather than a fall back to the parent.
 */
function recordOf(
  native: unknown,
  kind: RecordKind
): { address: string; expiresAt: number } | undefined {
  if (!Array.isArray(native)) return undefined
  const slot: unknown = kind === 'Domain' ? native[0] : native[1]
  if (typeof slot !== 'object' || slot === null) return undefined
  const struct = slot as { address?: unknown; exp_date?: unknown }
  if (typeof struct.address !== 'string') return undefined
  return {
    address: struct.address,
    expiresAt: struct.exp_date === undefined ? 0 : Number(struct.exp_date),
  }
}

async function simulate(
  name: string,
  kind: RecordKind,
  server: Pick<rpc.Server, 'simulateTransaction'>
): Promise<rpc.Api.SimulateTransactionResponse> {
  return server.simulateTransaction(lookupTransaction(name, kind))
}

export async function resolveSorobanDomain(
  name: string,
  options: ResolveDomainOptions = {}
): Promise<{ address: string; expiresAt: number }> {
  if (!isSorobanDomain(name)) {
    throw new NameLookupFailed(`${name} is not a .xlm name`)
  }

  const kind = recordKindOf(name)
  let sim: rpc.Api.SimulateTransactionResponse
  try {
    if (options.serverImpl !== undefined) {
      sim = await simulate(name, kind, options.serverImpl)
    } else if (options.rpcUrl !== undefined) {
      sim = await simulate(name, kind, new rpc.Server(options.rpcUrl))
    } else {
      // One public RPC, then another. A registry read that fails on transport
      // is not an answer about the name, so a second provider is asked before
      // giving up.
      try {
        sim = await simulate(name, kind, new rpc.Server(SOROBAN_DOMAINS_RPC))
      } catch {
        sim = await simulate(name, kind, new rpc.Server(SOROBAN_DOMAINS_RPC_FALLBACK))
      }
    }
  } catch (e) {
    throw new NameLookupFailed(
      `the name registry could not be reached: ${e instanceof Error ? e.message : String(e)}`
    )
  }

  if (rpc.Api.isSimulationError(sim)) {
    if (sim.error.includes(NOT_FOUND_CODE)) {
      throw new NameNotFound(`${name} is not registered`)
    }
    throw new NameLookupFailed(`the name registry refused the lookup: ${sim.error}`)
  }
  if (sim.result === undefined) {
    throw new NameLookupFailed('the name registry returned nothing')
  }

  const record = recordOf(scValToNative(sim.result.retval), kind)
  if (record === undefined) {
    throw new NameLookupFailed(
      kind === 'SubDomain'
        ? `the registry holds no subdomain record for ${name}`
        : `the record for ${name} names no address`
    )
  }
  return record
}
