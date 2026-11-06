import { createHash } from 'node:crypto'

import { getProgramDerivedAddress, type Address } from '@solana/kit'

import {
  addressAt,
  addressBytes,
  soleHolder,
  TOKEN_PROGRAM,
  u64At,
  type SolanaNameRpc,
} from './solana-rpc'
import { EXPIRED, nameRefused, NOT_CONFIRMED, NOT_REGISTERED } from './tlds'

/**
 * ANS, TLD House and Name House: docs.alldomains.id/protocol/developer-guide/programs-svm-and-smart-
 * contracts-evm, all executable on chain 2026-11-05. The origin is `ROOT_ANS_PUBLIC_KEY` in
 * @onsol/tldparser 1.2.1, owned by ANS on chain and derived again from "ANS" in the live test.
 */
const ANS_PROGRAM = 'ALTNSZ46uaAUU7XUV6awvdorLGqAsPwa9shm7h4uP2FK'
const TLD_HOUSE_PROGRAM = 'TLDHkysf5pCnKsVA4gXpNvmy7psXLPEu4LAdDJthT9S'
const NAME_HOUSE_PROGRAM = 'NH3uX6FtVE2fNREAioP7hm5RaozotZxeL6khU1EHx51'
const ANS_ORIGIN = '3mX9b4AZaQehNoQGfckVcmgmA6bkBoFcbLj9RMmMyNcU'

const NAME_RECORD_DISCRIMINATOR = '4448582c0fa767f3'
const NAME_RECORD_LENGTH = 200
const NFT_RECORD_DISCRIMINATOR = 'aebe7264b10e5afe'
const NFT_RECORD_LENGTH = 138
/** Unlike SNS, where active is 2. */
const NFT_ACTIVE = 1

const NO_HOLDER = 'is held as a token with no single holder, so there is no one wallet to send to.'

function hex(data: Uint8Array, length: number): string {
  return Buffer.from(data.subarray(0, length)).toString('hex')
}

async function ansAddress(text: string, parent: string): Promise<string> {
  const hashed = new Uint8Array(createHash('sha256').update(`ALT Name Service${text}`).digest())
  const [address] = await getProgramDerivedAddress({
    programAddress: ANS_PROGRAM as Address,
    seeds: [hashed, new Uint8Array(32), addressBytes(parent)],
  })
  return address
}

export async function ansAccounts(
  label: string,
  tld: string
): Promise<{ parent: string; name: string; nftRecord: string }> {
  const parent = await ansAddress(`.${tld}`, ANS_ORIGIN)
  const name = await ansAddress(label, parent)
  const [tldHouse] = await getProgramDerivedAddress({
    programAddress: TLD_HOUSE_PROGRAM as Address,
    seeds: ['tld_house', `.${tld}`],
  })
  const [nameHouse] = await getProgramDerivedAddress({
    programAddress: NAME_HOUSE_PROGRAM as Address,
    seeds: ['name_house', addressBytes(tldHouse)],
  })
  const [nftRecord] = await getProgramDerivedAddress({
    programAddress: NAME_HOUSE_PROGRAM as Address,
    seeds: ['nft_record', addressBytes(nameHouse), addressBytes(name)],
  })
  return { parent, name, nftRecord }
}

/**
 * The owner, or the holder when the name is wrapped as an NFT, which is what @onsol/tldparser's
 * `getNameOwner` reads. A name past its expiry is refused, including through the grace period: the
 * docs say an expired name "can no longer receive tokens".
 */
export async function resolveAllDomainsSolana(
  rpc: SolanaNameRpc,
  name: string,
  label: string,
  tld: string
): Promise<string> {
  const accounts = await ansAccounts(label, tld)
  const [account] = await rpc.accounts([accounts.name])
  if (account === null || account === undefined) throw nameRefused(name, NOT_REGISTERED)
  const { data } = account
  if (
    account.program !== ANS_PROGRAM ||
    data.length < NAME_RECORD_LENGTH ||
    hex(data, 8) !== NAME_RECORD_DISCRIMINATOR ||
    addressAt(data, 8) !== accounts.parent
  ) {
    throw nameRefused(name, NOT_CONFIRMED)
  }
  const expiry = u64At(data, 104)
  if (expiry !== BigInt(0) && expiry <= BigInt(Math.floor(Date.now() / 1000))) {
    throw nameRefused(name, EXPIRED)
  }
  const owner = addressAt(data, 40)
  if (owner !== accounts.nftRecord) return owner

  const [record] = await rpc.accounts([accounts.nftRecord])
  if (
    record === null ||
    record === undefined ||
    record.program !== NAME_HOUSE_PROGRAM ||
    record.data.length < NFT_RECORD_LENGTH ||
    hex(record.data, 8) !== NFT_RECORD_DISCRIMINATOR ||
    record.data[8] !== NFT_ACTIVE ||
    addressAt(record.data, 10) !== accounts.name
  ) {
    throw nameRefused(name, NOT_CONFIRMED)
  }
  const holder = await soleHolder(rpc, addressAt(record.data, 74), TOKEN_PROGRAM)
  if (holder === undefined) throw nameRefused(name, NO_HOLDER)
  return holder
}
