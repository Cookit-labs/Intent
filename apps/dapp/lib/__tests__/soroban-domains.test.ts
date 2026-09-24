import { keccak_256 } from '@noble/hashes/sha3'
import {
  Address,
  Keypair,
  Operation,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk'
import { describe, expect, it } from 'vitest'

import { NameLookupFailed, NameNotFound } from '../names/errors'
import { isSorobanDomain } from '../names/kind'
import {
  SOROBAN_DOMAINS_REGISTRY,
  domainNode,
  resolveSorobanDomain,
} from '../names/soroban-domains'

/**
 * The `.xlm` resolver, without a network.
 *
 * Two things are worth pinning. The node hash, because a wrong concatenation
 * order still yields 32 plausible bytes that resolve to nothing — the test
 * computes it here from the formula rather than trusting a constant. And the
 * argument shape, for the same reason the oracle test decodes what went on the
 * wire: the registry answers a wrongly-keyed lookup with "not found", which is
 * indistinguishable from a name that really does not exist.
 */

const TARGET = Keypair.random().publicKey()
const PARENT = Keypair.random().publicKey()

type Sim = Pick<rpc.Server, 'simulateTransaction'>

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

/** The decoded contract call inside a built transaction, as the oracle test reads it. */
function invocationOf(tx: Parameters<Sim['simulateTransaction']>[0]): {
  functionName?: unknown
  args?: xdr.ScVal[]
  contractAddress?: xdr.ScAddress
} {
  const op = (tx as { operations: Operation[] }).operations[0] as
    | {
        func?: {
          invokeContract?: {
            functionName?: unknown
            args?: xdr.ScVal[]
            contractAddress?: xdr.ScAddress
          }
        }
      }
    | undefined
  return op?.func?.invokeContract ?? {}
}

function domainRecord(address: string, expDate: number): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: nativeToScVal('address', { type: 'symbol' }),
      val: new Address(address).toScVal(),
    }),
    new xdr.ScMapEntry({
      key: nativeToScVal('exp_date', { type: 'symbol' }),
      val: nativeToScVal(BigInt(expDate), { type: 'u64' }),
    }),
  ])
}

function fakeRegistry(
  answer: { retval: xdr.ScVal } | { error: string } | { throws: Error }
): Sim & { seen: { fn: string; args: xdr.ScVal[]; contract?: string }[] } {
  const seen: { fn: string; args: xdr.ScVal[]; contract?: string }[] = []
  return {
    seen,
    async simulateTransaction(tx) {
      const call = invocationOf(tx)
      seen.push({
        fn: String(call.functionName ?? ''),
        args: call.args ?? [],
        ...(call.contractAddress !== undefined
          ? { contract: Address.fromScAddress(call.contractAddress).toString() }
          : {}),
      })
      if ('throws' in answer) throw answer.throws
      if ('error' in answer) {
        return {
          id: '1',
          latestLedger: 1,
          events: [],
          error: answer.error,
        } as unknown as rpc.Api.SimulateTransactionErrorResponse
      }
      return {
        id: '1',
        latestLedger: 1,
        events: [],
        minResourceFee: '0',
        result: { auth: [], retval: answer.retval },
      } as unknown as rpc.Api.SimulateTransactionSuccessResponse
    },
  }
}

describe('isSorobanDomain', () => {
  it('accepts a root name and a subdomain', () => {
    expect(isSorobanDomain('deon.xlm')).toBe(true)
    expect(isSorobanDomain('pay.deon.xlm')).toBe(true)
  })

  it('accepts uppercase, since the name is lowercased before hashing', () => {
    expect(isSorobanDomain('Deon.xlm')).toBe(true)
  })

  it('rejects digits, another TLD, an over-long label and a bare word', () => {
    expect(isSorobanDomain('deon1.xlm')).toBe(false)
    expect(isSorobanDomain('deon.eth')).toBe(false)
    expect(isSorobanDomain('abcdefghijklmnop.xlm')).toBe(false)
    expect(isSorobanDomain('deon')).toBe(false)
    expect(isSorobanDomain('.xlm')).toBe(false)
  })

  it('rejects a federation address and a raw key', () => {
    expect(isSorobanDomain('deon*lobstr.co')).toBe(false)
    expect(isSorobanDomain(TARGET)).toBe(false)
  })
})

describe('domainNode', () => {
  it('hashes a root name as keccak(keccak(tld) ‖ keccak(label))', () => {
    // Computed here from the formula, not pinned as a constant: the thing
    // being proved is the concatenation order.
    const expected = keccak_256(concat(keccak_256(utf8('xlm')), keccak_256(utf8('sorobandomains'))))
    expect(hex(domainNode('sorobandomains.xlm'))).toBe(hex(expected))
  })

  it('hashes a subdomain against its parent node', () => {
    const parent = keccak_256(concat(keccak_256(utf8('xlm')), keccak_256(utf8('deon'))))
    const expected = keccak_256(concat(keccak_256(parent), keccak_256(utf8('pay'))))
    expect(hex(domainNode('pay.deon.xlm'))).toBe(hex(expected))
  })

  it('lowercases before hashing', () => {
    expect(hex(domainNode('Deon.XLM'))).toBe(hex(domainNode('deon.xlm')))
  })
})

/**
 * What the registry actually returns: the tuple `(Domain, Option<SubDomain>)`,
 * decoded to `[domainStruct, subStruct | null]`. Verified against mainnet on
 * 2026-09-24 for `sorobandomains.xlm`, which decodes to `[{address, …}, null]`.
 * The first slot is the parent for a subdomain lookup, and the parent's
 * address is the wrong account to pay.
 */
function tuple(domain: xdr.ScVal, sub?: xdr.ScVal): xdr.ScVal {
  return xdr.ScVal.scvVec([domain, sub ?? xdr.ScVal.scvVoid()])
}

describe('resolveSorobanDomain', () => {
  it('asks the registry for record(Domain(node)) and reads the address', async () => {
    const registry = fakeRegistry({ retval: tuple(domainRecord(TARGET, 1_800_000_000)) })

    const resolved = await resolveSorobanDomain('deon.xlm', { serverImpl: registry })

    expect(resolved.address).toBe(TARGET)
    expect(resolved.expiresAt).toBe(1_800_000_000)

    const call = registry.seen[0]
    expect(call?.fn).toBe('record')
    expect(call?.contract).toBe(SOROBAN_DOMAINS_REGISTRY)
    const key = scValToNative(call?.args[0] as xdr.ScVal) as [string, Uint8Array]
    expect(key[0]).toBe('Domain')
    expect(hex(key[1])).toBe(hex(domainNode('deon.xlm')))
  })

  it('keys a subdomain lookup as SubDomain and reads the subdomain’s address, not the parent’s', async () => {
    const registry = fakeRegistry({
      retval: tuple(domainRecord(PARENT, 1_800_000_000), domainRecord(TARGET, 0)),
    })

    const resolved = await resolveSorobanDomain('pay.deon.xlm', { serverImpl: registry })

    expect(resolved.address).toBe(TARGET)
    expect(resolved.address).not.toBe(PARENT)
    const key = scValToNative(registry.seen[0]?.args[0] as xdr.ScVal) as [string, Uint8Array]
    expect(key[0]).toBe('SubDomain')
    expect(hex(key[1])).toBe(hex(domainNode('pay.deon.xlm')))
  })

  it('refuses a subdomain answer that carries no subdomain record', async () => {
    // Paying the parent instead would be paying the wrong account quietly.
    const registry = fakeRegistry({ retval: tuple(domainRecord(PARENT, 1_800_000_000)) })
    await expect(resolveSorobanDomain('pay.deon.xlm', { serverImpl: registry })).rejects.toThrow(
      NameLookupFailed
    )
  })

  it('reports a missing name as NameNotFound', async () => {
    const registry = fakeRegistry({
      error: 'HostError: Error(Contract, #307)\n\nEvent log (newest first):',
    })
    await expect(resolveSorobanDomain('nobody.xlm', { serverImpl: registry })).rejects.toThrow(
      NameNotFound
    )
  })

  it('reports any other contract error as NameLookupFailed', async () => {
    const registry = fakeRegistry({ error: 'HostError: Error(WasmVm, InvalidAction)' })
    await expect(resolveSorobanDomain('deon.xlm', { serverImpl: registry })).rejects.toThrow(
      NameLookupFailed
    )
  })

  it('reports an unreachable RPC as NameLookupFailed', async () => {
    const registry = fakeRegistry({ throws: new Error('fetch failed') })
    await expect(resolveSorobanDomain('deon.xlm', { serverImpl: registry })).rejects.toThrow(
      NameLookupFailed
    )
  })

  it('refuses a name that is not a .xlm domain before asking anything', async () => {
    const registry = fakeRegistry({ throws: new Error('should not be called') })
    await expect(resolveSorobanDomain('deon.eth', { serverImpl: registry })).rejects.toThrow(
      NameLookupFailed
    )
    expect(registry.seen).toHaveLength(0)
  })
})
