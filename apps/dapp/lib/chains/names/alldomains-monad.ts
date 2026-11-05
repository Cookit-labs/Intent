import {
  concat,
  getAddress,
  keccak256,
  parseAbi,
  toBytes,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem'

import { evmReader } from '../evm/client'
import { EXPIRED, nameRefused, NOT_CONFIRMED, NOT_REGISTERED } from './tlds'

/**
 * Root and resolver: docs.alldomains.id/protocol/developer-guide/programs-svm-and-smart-contracts-
 * evm. Registry: `registryContractAddress` in @onsol/tldparser 1.2.1, and root `registry()` returned
 * it on chain 2026-11-05. All three hold code on Monad, read with eth_getCode that day.
 */
export const ANS_MONAD_ROOT: Address = '0xE6d461c863987F2a1096eA3476137F30f75B3d46'
export const ANS_MONAD_REGISTRY: Address = '0xa4338eadf4D2e0851eFb225b0Eab90bE47A095F1'
export const ANS_MONAD_RESOLVER: Address = '0x314582158A0a72802aD8F6EeE6243C73dCf1F562'

const ROOT_ABI = parseAbi([
  'struct Tld { address controller; address registrar; string tld; string name; string symbol; bool locked; bytes32 node; bytes32 label; }',
  'function getTld(bytes32 label) view returns (Tld)',
])
const REGISTRY_ABI = parseAbi([
  'function owner(bytes32 node) view returns (address)',
  'function resolver(bytes32 node) view returns (address)',
])
const REGISTRAR_ABI = parseAbi([
  'struct NameData { string name; uint256 expiry; bool frozen; string url; address owner; }',
  'function nameData(uint256 tokenId) view returns (NameData)',
])
const RESOLVER_ABI = parseAbi(['function addr(bytes32 node) view returns (address)'])

const ZERO_NODE = `0x${'0'.repeat(64)}` as Hex

export interface MonadNameReader {
  read: (call: {
    address: Address
    abi: readonly unknown[]
    functionName: string
    args?: readonly unknown[]
  }) => Promise<unknown>
}

export function monadNameReader(): MonadNameReader {
  const client = evmReader('monad')
  return { read: (call) => client.readContract(call as never) as Promise<unknown> }
}

function hashed(text: string): Hex {
  return keccak256(toBytes(text))
}

/** Not ENS's namehash. ANS hashes the ending with its dot, as @onsol/tldparser's `ansNamehash` does. */
export function ansNode(label: string, tld: string): Hex {
  const tldNode = keccak256(concat([ZERO_NODE, hashed(`.${tld}`)]))
  return keccak256(concat([tldNode, hashed(label)]))
}

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/**
 * The owner, which the registry and the registrar's NFT must both say, with time left on the name.
 * An address record set to anyone else is two answers, so it is refused, not chosen between.
 */
export async function resolveAllDomainsMonad(
  reader: MonadNameReader,
  name: string,
  label: string,
  tld: string
): Promise<string> {
  const tldData = (await reader.read({
    address: ANS_MONAD_ROOT,
    abi: ROOT_ABI,
    functionName: 'getTld',
    args: [hashed(`.${tld}`)],
  })) as { tld: string; registrar: Address }
  if (tldData.tld !== `.${tld}` || same(tldData.registrar, zeroAddress)) {
    throw nameRefused(name, NOT_CONFIRMED)
  }

  const node = ansNode(label, tld)
  const [owner, resolver, data] = (await Promise.all([
    reader.read({
      address: ANS_MONAD_REGISTRY,
      abi: REGISTRY_ABI,
      functionName: 'owner',
      args: [node],
    }),
    reader.read({
      address: ANS_MONAD_REGISTRY,
      abi: REGISTRY_ABI,
      functionName: 'resolver',
      args: [node],
    }),
    reader.read({
      address: tldData.registrar,
      abi: REGISTRAR_ABI,
      functionName: 'nameData',
      args: [BigInt(hashed(label))],
    }),
  ])) as [Address, Address, { name: string; expiry: bigint; owner: Address }]

  if (same(owner, zeroAddress)) throw nameRefused(name, NOT_REGISTERED)
  if (data.name !== label) throw nameRefused(name, NOT_CONFIRMED)
  if (data.expiry <= BigInt(Math.floor(Date.now() / 1000))) throw nameRefused(name, EXPIRED)
  if (!same(data.owner, owner)) {
    throw nameRefused(
      name,
      `points to two different wallets: ${owner} in the registry and ${data.owner} holding the name, so I won't pick one.`
    )
  }

  if (!same(resolver, zeroAddress)) {
    if (!same(resolver, ANS_MONAD_RESOLVER)) throw nameRefused(name, NOT_CONFIRMED)
    const addr = (await reader.read({
      address: ANS_MONAD_RESOLVER,
      abi: RESOLVER_ABI,
      functionName: 'addr',
      args: [node],
    })) as Address
    if (!same(addr, zeroAddress) && !same(addr, owner)) {
      throw nameRefused(
        name,
        `points to two different wallets: ${owner} owns it and its record says ${addr}, so I won't pick one.`
      )
    }
  }
  return getAddress(owner)
}
