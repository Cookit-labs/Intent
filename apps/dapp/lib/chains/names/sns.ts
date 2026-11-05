import { createHash } from 'node:crypto'

import {
  getProgramDerivedAddress,
  getPublicKeyFromAddress,
  verifySignature,
  type Address,
  type SignatureBytes,
} from '@solana/kit'

import {
  addressAt,
  addressBytes,
  soleHolder,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  type NameAccount,
  type SolanaNameRpc,
} from './solana-rpc'
import { EXPIRED, nameRefused, NOT_CONFIRMED, NOT_REGISTERED } from './tlds'

/**
 * `namesLP...`, `nftD3...`, the root and the records central state are in @solana-name-service/
 * sns-sdk-kit 1.0.1 `constants/addresses`, and the root in docs.sns.id/dev/tld. `srsWjm...` is in
 * its `config`. All checked on chain 2026-11-05: both programs executable, the root owned by the
 * name program, and records read back from the PDAs derived here.
 */
const NAME_PROGRAM = 'namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX'
const SNS_ROOT = '58PwtjSDuFHuUkYjH9BYnnQKHfwo9reZhC2zMJv9JPkx'
const NAME_TOKENIZER = 'nftD3vbNkNqfj2Sd3HZwbpw4BxxKWr4AjGb9X38JeZk'
const RECORDS_CENTRAL_STATE = '2pMnqHvei2N5oDcVGCRdZx48gqti199wr5CsyTTafsbo'
const SRS_PROGRAM = 'srsWjm76StJucL7atFyPSdXFaVLNPFqEt1uFEDPrZsn'
/** From sns-sdk-kit 1.1.0-beta.1. 1.0.1 carries an older value that no live record we read holds. */
const SRS_SOL_CLASS = 'Dqc9TrYg1AZLEa6UkZUqCDrr9zsHQveo1szGTE1BTW5'

const REGISTRY_HEADER = 96
const V1_LENGTH = REGISTRY_HEADER + 32 + 64
const V2_ID_LENGTH = 32
const V2_HEADER = 8
const V2_LENGTH = REGISTRY_HEADER + V2_HEADER + V2_ID_LENGTH * 2 + 32
const VALIDATION_SOLANA = 1

const NFT_RECORD_LENGTH = 98
const NFT_ACTIVE = 2
const NFT_INACTIVE = 3

const SRS_HEADER = 75
const SRS_RECORD = 2
const SRS_OWNER_WALLET = 0
const SRS_OWNER_TOKEN = 1

const NOT_SIGNED = "has a wallet record its owner has not signed, so it can't be trusted."
const STALE = 'has a wallet record set by a previous owner, so it may point to the wrong person.'
const NOT_PROVEN = "has a wallet record that doesn't prove the wallet agreed to it."
const NO_HOLDER = 'is held as a token with no single holder, so there is no one wallet to send to.'

function nameHash(text: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(`SPL Name Service${text}`).digest())
}

async function nameAddress(
  text: string,
  nameClass: string | undefined,
  parent: string
): Promise<string> {
  const [address] = await getProgramDerivedAddress({
    programAddress: NAME_PROGRAM as Address,
    seeds: [
      nameHash(text),
      nameClass === undefined ? new Uint8Array(32) : addressBytes(nameClass),
      addressBytes(parent),
    ],
  })
  return address
}

async function tokenizerAddress(seed: string, domain: string): Promise<string> {
  const [address] = await getProgramDerivedAddress({
    programAddress: NAME_TOKENIZER as Address,
    seeds: [seed, addressBytes(domain)],
  })
  return address
}

/** Derived the same way as sns-sdk-kit's `getRecordV1Address`, `getRecordV2Address` and `NftState`. */
export async function snsAccounts(label: string): Promise<{
  domain: string
  nft: string
  mint: string
  v1: string
  v2: string
}> {
  const domain = await nameAddress(label, undefined, SNS_ROOT)
  const [nft, mint, v1, v2] = await Promise.all([
    tokenizerAddress('nft_record', domain),
    tokenizerAddress('tokenized_name', domain),
    nameAddress('\x01SOL', undefined, domain),
    nameAddress('\x02SOL', RECORDS_CENTRAL_STATE, domain),
  ])
  return { domain, nft, mint, v1, v2 }
}

export async function solAccounts(label: string): Promise<{ record: string; mint: string }> {
  const hashed = new Uint8Array(createHash('sha256').update(`name${label}`).digest())
  const [record] = await getProgramDerivedAddress({
    programAddress: SRS_PROGRAM as Address,
    seeds: ['record', addressBytes(SRS_SOL_CLASS), hashed],
  })
  const [mint] = await getProgramDerivedAddress({
    programAddress: SRS_PROGRAM as Address,
    seeds: ['mint', addressBytes(record)],
  })
  return { record, mint }
}

function ownedRecord(account: NameAccount, parent: string, minLength: number): boolean {
  return (
    account.program === NAME_PROGRAM &&
    account.data.length >= minLength &&
    addressAt(account.data, 0) === parent
  )
}

/**
 * SNS checks a V2 record two ways. Staleness: the owner who set it must still own the name. Right
 * of association: the wallet it names must have agreed. sns-sdk-kit's `resolveSns` reads the same
 * bytes, but it passes over a stale record. Here any record that fails is the end of the read.
 */
function readV2(name: string, account: NameAccount, domain: string, owner: string): string {
  if (!ownedRecord(account, domain, V2_LENGTH)) throw nameRefused(name, NOT_PROVEN)
  const { data } = account
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const staleness = view.getUint16(REGISTRY_HEADER, true)
  const right = view.getUint16(REGISTRY_HEADER + 2, true)
  const contentLength = view.getUint32(REGISTRY_HEADER + 4, true)
  if (staleness !== VALIDATION_SOLANA || right !== VALIDATION_SOLANA || contentLength !== 32) {
    throw nameRefused(name, NOT_PROVEN)
  }
  const ids = REGISTRY_HEADER + V2_HEADER
  if (addressAt(data, ids) !== owner) throw nameRefused(name, STALE)
  const content = addressAt(data, ids + V2_ID_LENGTH * 2)
  if (addressAt(data, ids + V2_ID_LENGTH) !== content) throw nameRefused(name, NOT_PROVEN)
  return content
}

/**
 * The docs call the signature one over the two addresses' bytes. Live records sign the hex of those
 * bytes as text, as sns-sdk-kit verifies, and the raw form fails on them (checked on `erizzo`).
 */
async function readV1(
  name: string,
  account: NameAccount,
  record: string,
  domain: string,
  owner: string
): Promise<string> {
  if (!ownedRecord(account, domain, V1_LENGTH)) throw nameRefused(name, NOT_SIGNED)
  const { data } = account
  const target = data.subarray(REGISTRY_HEADER, REGISTRY_HEADER + 32)
  const signed = Buffer.concat([target, addressBytes(record)]).toString('hex')
  const signature = data.slice(REGISTRY_HEADER + 32, REGISTRY_HEADER + 32 + 64)
  let valid = false
  try {
    valid = await verifySignature(
      await getPublicKeyFromAddress(owner as Address),
      signature as unknown as SignatureBytes,
      new TextEncoder().encode(signed)
    )
  } catch {
    valid = false
  }
  if (!valid) throw nameRefused(name, NOT_SIGNED)
  return addressAt(data, REGISTRY_HEADER)
}

/**
 * docs.sns.id/dev/on-chain-resolution: the token holder, then a verified V2 record, then a signed
 * V1 record, then the owner. The docs send a bad record on to the owner. This refuses instead: a
 * record that can't be checked means the name changed hands or was tampered with, and a refused
 * send costs nothing while a wrong one can't be undone.
 */
export async function resolveSnsName(
  rpc: SolanaNameRpc,
  name: string,
  label: string
): Promise<string> {
  const { domain, nft, mint, v1, v2 } = await snsAccounts(label)
  const [domainAccount, nftAccount, v1Account, v2Account] = await rpc.accounts([
    domain,
    nft,
    v1,
    v2,
  ])
  if (domainAccount === null || domainAccount === undefined) {
    throw nameRefused(name, NOT_REGISTERED)
  }
  if (!ownedRecord(domainAccount, SNS_ROOT, REGISTRY_HEADER)) {
    throw nameRefused(name, NOT_CONFIRMED)
  }
  const owner = addressAt(domainAccount.data, 32)

  if (nftAccount !== null && nftAccount !== undefined) {
    const tag = nftAccount.data[0]
    if (
      nftAccount.program !== NAME_TOKENIZER ||
      nftAccount.data.length !== NFT_RECORD_LENGTH ||
      addressAt(nftAccount.data, 2) !== domain ||
      (tag !== NFT_ACTIVE && tag !== NFT_INACTIVE)
    ) {
      throw nameRefused(name, NOT_CONFIRMED)
    }
    if (tag === NFT_ACTIVE) {
      if (owner !== nft) throw nameRefused(name, NOT_CONFIRMED)
      if (addressAt(nftAccount.data, 66) !== mint) throw nameRefused(name, NO_HOLDER)
      const holder = await soleHolder(rpc, mint, TOKEN_PROGRAM)
      if (holder === undefined) throw nameRefused(name, NO_HOLDER)
      return holder
    }
  }
  if (v2Account !== null && v2Account !== undefined) return readV2(name, v2Account, domain, owner)
  if (v1Account !== null && v1Account !== undefined) {
    return readV1(name, v1Account, v1, domain, owner)
  }
  return owner
}

/** The record's owner, as sns-sdk-kit 1.1.0-beta.1's `resolveSol` reads it. */
async function resolveSrsRecord(rpc: SolanaNameRpc, name: string, label: string): Promise<string> {
  const { record, mint } = await solAccounts(label)
  const [account] = await rpc.accounts([record])
  if (account === null || account === undefined) throw nameRefused(name, NOT_REGISTERED)
  const { data } = account
  if (
    account.program !== SRS_PROGRAM ||
    data.length < SRS_HEADER ||
    data[0] !== SRS_RECORD ||
    addressAt(data, 1) !== SRS_SOL_CLASS ||
    data[66] !== 0
  ) {
    throw nameRefused(name, NOT_CONFIRMED)
  }
  const expiry = new DataView(data.buffer, data.byteOffset, data.byteLength).getBigInt64(67, true)
  if (expiry !== BigInt(0) && expiry <= BigInt(Math.floor(Date.now() / 1000))) {
    throw nameRefused(name, EXPIRED)
  }
  const owner = addressAt(data, 34)
  if (data[33] === SRS_OWNER_WALLET) return owner
  if (data[33] !== SRS_OWNER_TOKEN) throw nameRefused(name, NOT_CONFIRMED)
  if (owner !== mint) throw nameRefused(name, NO_HOLDER)
  const holder = await soleHolder(rpc, mint, TOKEN_2022_PROGRAM)
  if (holder === undefined) throw nameRefused(name, NO_HOLDER)
  return holder
}

/**
 * `.sol` has moved. SNS's stable SDK now refuses `.sol` past slot 452,825,395, and its beta reads it
 * from the Solana Registration Service, whose records live apart from SNS and can name someone else
 * (`mert` did on 2026-11-05). Which one a person means can't be known, so both must give one wallet,
 * as the beta's `safeResolve` requires.
 */
export async function resolveSolName(
  rpc: SolanaNameRpc,
  name: string,
  label: string
): Promise<string> {
  const [registry, sns] = await Promise.all([
    resolveSrsRecord(rpc, name, label),
    resolveSnsName(rpc, name, label),
  ])
  if (registry !== sns) {
    throw nameRefused(
      name,
      `points to two different wallets: ${registry} in the .sol registry and ${sns} in the Solana Name Service, so I won't pick one.`
    )
  }
  return registry
}
