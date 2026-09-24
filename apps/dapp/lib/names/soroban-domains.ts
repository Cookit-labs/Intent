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

const TLD = 'xlm'
/** The registry's own rule: lowercase letters, one to fifteen of them. */
const LABEL = /^[a-z]{1,15}$/
/** The registry's error for a node it holds no record under. */
const NOT_FOUND_CODE = '#307'

function labelsOf(input: string): string[] {
  return input.trim().toLowerCase().split('.')
}

export function isSorobanDomain(input: string): boolean {
  const labels = labelsOf(input)
  if (labels.length < 2 || labels[labels.length - 1] !== TLD) return false
  return labels.slice(0, -1).every((label) => LABEL.test(label))
}

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
  const labels = labelsOf(name)
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

function recordKey(name: string): xdr.ScVal {
  const kind = labelsOf(name).length > 2 ? 'SubDomain' : 'Domain'
  return xdr.ScVal.scvVec([
    nativeToScVal(kind, { type: 'symbol' }),
    xdr.ScVal.scvBytes(Buffer.from(domainNode(name))),
  ])
}

function lookupTransaction(name: string) {
  return new TransactionBuilder(new Account(SOROBAN_DOMAINS_SIMULATION_ACCOUNT, '0'), {
    fee: BASE_FEE,
    networkPassphrase: Networks.PUBLIC,
  })
    .addOperation(new Contract(SOROBAN_DOMAINS_REGISTRY).call('record', recordKey(name)))
    .setTimeout(60)
    .build()
}

/**
 * The record's address, wherever the decoded answer puts it.
 *
 * The registry returns an enum — `Domain(record)` or `SubDomain(record)` —
 * which decodes to a symbol and a struct. Rather than pin the exact nesting,
 * the struct with an `address` is found by walking the value, which reads
 * both variants and would survive an `Option` wrapper too.
 */
function recordOf(native: unknown): { address: string; expiresAt: number } | undefined {
  if (Array.isArray(native)) {
    for (const item of native) {
      const found = recordOf(item)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (typeof native !== 'object' || native === null) return undefined
  const struct = native as { address?: unknown; exp_date?: unknown }
  if (typeof struct.address !== 'string') return undefined
  return {
    address: struct.address,
    expiresAt: struct.exp_date === undefined ? 0 : Number(struct.exp_date),
  }
}

async function simulate(
  name: string,
  server: Pick<rpc.Server, 'simulateTransaction'>
): Promise<rpc.Api.SimulateTransactionResponse> {
  return server.simulateTransaction(lookupTransaction(name))
}

export async function resolveSorobanDomain(
  name: string,
  options: ResolveDomainOptions = {}
): Promise<{ address: string; expiresAt: number }> {
  if (!isSorobanDomain(name)) {
    throw new NameLookupFailed(`${name} is not a .xlm name`)
  }

  let sim: rpc.Api.SimulateTransactionResponse
  try {
    if (options.serverImpl !== undefined) {
      sim = await simulate(name, options.serverImpl)
    } else if (options.rpcUrl !== undefined) {
      sim = await simulate(name, new rpc.Server(options.rpcUrl))
    } else {
      // One public RPC, then another. A registry read that fails on transport
      // is not an answer about the name, so a second provider is asked before
      // giving up.
      try {
        sim = await simulate(name, new rpc.Server(SOROBAN_DOMAINS_RPC))
      } catch {
        sim = await simulate(name, new rpc.Server(SOROBAN_DOMAINS_RPC_FALLBACK))
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

  const record = recordOf(scValToNative(sim.result.retval))
  if (record === undefined) {
    throw new NameLookupFailed(`the record for ${name} names no address`)
  }
  return record
}
