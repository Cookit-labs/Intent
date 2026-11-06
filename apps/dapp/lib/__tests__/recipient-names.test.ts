import { generateKeyPair, getAddressFromPublicKey, signBytes, type Address } from '@solana/kit'
import { getAddress, keccak256, toBytes, zeroAddress } from 'viem'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { ansAccounts, resolveAllDomainsSolana } from '../chains/names/alldomains-solana'
import {
  ANS_MONAD_REGISTRY,
  ANS_MONAD_RESOLVER,
  ANS_MONAD_ROOT,
  ansNode,
  resolveAllDomainsMonad,
  type MonadNameReader,
} from '../chains/names/alldomains-monad'
import { resolveName, resolveRecipient, withResolvedName } from '../chains/names/resolve'
import { snsAccounts, resolveSnsName, solAccounts, resolveSolName } from '../chains/names/sns'
import type { NameAccount, SolanaNameRpc } from '../chains/names/solana-rpc'
import {
  NameRecord,
  SUINS_NAME_RECORD_TYPE,
  SUINS_REGISTRY_TABLE,
  resolveSuiName,
  type SuiNameReader,
} from '../chains/names/suins'
import { recipientName } from '../chains/names/tlds'
import { parseChainAction } from '../chains/parse-action'
import { prepareChainAction } from '../chains/prepare'
import { isValidRecipient, sendRefusal } from '../chains/recipient'
import { createSendVenue } from '../chains/send'
import { SOLANA_TOKENS } from '../chains/solana/tokens'
import {
  ChainActionRefused,
  type ChainActionKind,
  type ChainActionRequest,
  type ChainModule,
  type ChainVenue,
  type ChainWithActions,
  type PreparedAction,
} from '../chains/types'

vi.hoisted(() => {
  process.env['AUTH_SECRET'] = 'x'.repeat(48)
})

const NOTHING = 'Nothing was signed or sent.'
const NAME_PROGRAM = 'namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX'
const SNS_ROOT = '58PwtjSDuFHuUkYjH9BYnnQKHfwo9reZhC2zMJv9JPkx'
const TOKENIZER = 'nftD3vbNkNqfj2Sd3HZwbpw4BxxKWr4AjGb9X38JeZk'
const RECORDS_CENTRAL_STATE = '2pMnqHvei2N5oDcVGCRdZx48gqti199wr5CsyTTafsbo'
const SRS_PROGRAM = 'srsWjm76StJucL7atFyPSdXFaVLNPFqEt1uFEDPrZsn'
const SRS_CLASS = 'Dqc9TrYg1AZLEa6UkZUqCDrr9zsHQveo1szGTE1BTW5'
const ANS_PROGRAM = 'ALTNSZ46uaAUU7XUV6awvdorLGqAsPwa9shm7h4uP2FK'
const NAME_HOUSE = 'NH3uX6FtVE2fNREAioP7hm5RaozotZxeL6khU1EHx51'
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
const ZERO = '11111111111111111111111111111111'

const { getAddressEncoder } = await import('@solana/kit')
const encode = (address: string): Uint8Array =>
  new Uint8Array(getAddressEncoder().encode(address as Address))

function bytes(...parts: (Uint8Array | number[])[]): Uint8Array {
  return new Uint8Array(parts.flatMap((part) => [...part]))
}

function u64(value: number | bigint): Uint8Array {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, BigInt(value), true)
  return out
}

function i64(value: number | bigint): Uint8Array {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigInt64(0, BigInt(value), true)
  return out
}

function registry(parent: string, owner: string, cls = ZERO, extra = 0): Uint8Array {
  return bytes(encode(parent), encode(owner), encode(cls), new Uint8Array(extra))
}

function v1Data(domain: string, owner: string, target: string, signature: Uint8Array): Uint8Array {
  return bytes(registry(domain, owner), encode(target), signature)
}

function hexMessage(target: string, record: string): Uint8Array {
  const raw = bytes(encode(target), encode(record))
  const hex = [...raw].map((b) => b.toString(16).padStart(2, '0')).join('')
  return new TextEncoder().encode(hex)
}

function v2Data(
  domain: string,
  stale: string,
  roa: string,
  content: Uint8Array,
  { staleness = 1, right = 1 }: { staleness?: number; right?: number } = {}
): Uint8Array {
  const header = new Uint8Array(8)
  const view = new DataView(header.buffer)
  view.setUint16(0, staleness, true)
  view.setUint16(2, right, true)
  view.setUint32(4, content.length, true)
  return bytes(
    registry(domain, RECORDS_CENTRAL_STATE, RECORDS_CENTRAL_STATE),
    header,
    encode(stale),
    encode(roa),
    content
  )
}

function nftRecord(tag: number, nameAccount: string, mint: string): Uint8Array {
  return bytes([tag, 255], encode(nameAccount), encode(ZERO), encode(mint))
}

function mintData({ supply = 1, decimals = 0, init = 1 } = {}): Uint8Array {
  return bytes(new Uint8Array(36), u64(supply), [decimals, init], new Uint8Array(36))
}

function tokenData(mint: string, owner: string, amount = 1, state = 1): Uint8Array {
  return bytes(
    encode(mint),
    encode(owner),
    u64(amount),
    new Uint8Array(36),
    [state],
    new Uint8Array(56)
  )
}

function srsData(
  cls: string,
  ownerType: number,
  owner: string,
  {
    frozen = 0,
    expiry = 0,
    discriminator = 2,
  }: { frozen?: number; expiry?: number; discriminator?: number } = {}
): Uint8Array {
  return bytes(
    [discriminator],
    encode(cls),
    [ownerType],
    encode(owner),
    [frozen],
    i64(expiry),
    new Uint8Array(40)
  )
}

class World implements SolanaNameRpc {
  accountsByAddress = new Map<string, NameAccount>()
  holders = new Map<string, { address: string; data: Uint8Array }[]>()
  reads = 0
  broken = false

  set(address: string, program: string, data: Uint8Array): void {
    this.accountsByAddress.set(address, { program, data })
  }

  async accounts(addresses: readonly string[]): Promise<(NameAccount | null)[]> {
    this.reads += 1
    if (this.broken) throw new Error('rpc down')
    return addresses.map((address) => this.accountsByAddress.get(address) ?? null)
  }

  async tokenAccounts(mint: string): Promise<{ address: string; data: Uint8Array }[]> {
    this.reads += 1
    if (this.broken) throw new Error('rpc down')
    return this.holders.get(mint) ?? []
  }
}

let owner: { address: string; keys: CryptoKeyPair }
let oldOwner: { address: string; keys: CryptoKeyPair }
let wallet: string
let holder: string
let me: string

async function keyed(): Promise<{ address: string; keys: CryptoKeyPair }> {
  const keys = await generateKeyPair()
  return { address: await getAddressFromPublicKey(keys.publicKey), keys }
}

beforeAll(async () => {
  owner = await keyed()
  oldOwner = await keyed()
  wallet = (await keyed()).address
  holder = (await keyed()).address
  me = (await keyed()).address
})

async function snsWorld(label = 'ada', domainOwner = owner.address): Promise<World> {
  const world = new World()
  const { domain } = await snsAccounts(label)
  world.set(domain, NAME_PROGRAM, registry(SNS_ROOT, domainOwner))
  return world
}

async function setHolder(
  world: World,
  label = 'ada',
  { tag = 2, supply = 1, holders = 1 }: { tag?: number; supply?: number; holders?: number } = {}
): Promise<void> {
  const { domain, nft, mint } = await snsAccounts(label)
  world.set(domain, NAME_PROGRAM, registry(SNS_ROOT, nft))
  world.set(nft, TOKENIZER, nftRecord(tag, domain, mint))
  world.set(mint, TOKEN_PROGRAM, mintData({ supply }))
  world.holders.set(
    mint,
    Array.from({ length: holders }, (_, i) => ({
      address: `token${i}`,
      data: tokenData(mint, holder),
    }))
  )
}

async function setV2(
  world: World,
  target: string,
  stale = owner.address,
  roa = target
): Promise<void> {
  const { domain, v2 } = await snsAccounts('ada')
  world.set(v2, NAME_PROGRAM, v2Data(domain, stale, roa, encode(target)))
}

async function setV1(world: World, target: string, signer = owner.keys): Promise<void> {
  const { domain, v1 } = await snsAccounts('ada')
  const signature = await signBytes(signer.privateKey, hexMessage(target, v1))
  world.set(v1, NAME_PROGRAM, v1Data(domain, owner.address, target, new Uint8Array(signature)))
}

describe('what counts as a name', () => {
  it('reads the shapes a person types, through every kind that names someone', () => {
    expect(parseChainAction('send 50 USDC to ada.sol')).toMatchObject({
      kind: 'send',
      recipient: 'ada.sol',
    })
    expect(parseChainAction('send 50 USDC to ada.sol.')).toMatchObject({ recipient: 'ada.sol' })
    expect(parseChainAction('stream 100 USDC to bob.mon over 30 days')).toMatchObject({
      kind: 'stream',
      recipient: 'bob.mon',
    })
    expect(parseChainAction('invoice ada.skr for 100 USDC due 2027-01-01')).toMatchObject({
      kind: 'invoice',
      recipient: 'ada.skr',
    })
  })

  it('lower-cases a name and leaves anything else alone', () => {
    expect(recipientName('ADA.Sol')).toMatchObject({ name: 'ada.sol', label: 'ada', tld: 'sol' })
    expect(recipientName('pay.ada.sol')).toMatchObject({ tld: 'sol', sub: true })
    expect(recipientName('alice.near')).toBeUndefined()
    expect(recipientName(SNS_ROOT)).toBeUndefined()
    expect(recipientName(zeroAddress)).toBeUndefined()
    expect(recipientName('ada.eth')).toBeUndefined()
  })

  it('never lets a name stand as an address, even where it fits the shape', () => {
    expect(isValidRecipient('near', 'ada.sol')).toBe(false)
    expect(isValidRecipient('near', 'ada.sui')).toBe(false)
    expect(isValidRecipient('near', 'alice.near')).toBe(true)
  })
})

describe('a name on the wrong chain', () => {
  const ON_SUI = `ada.sol is a Solana name, and this is on Sui, so it can't be read here. Switch to Solana, or use a Sui address. ${NOTHING}`

  it('says so in plain words', () => {
    expect(sendRefusal('sui', 'USDC', 'ada.sol')).toBe(ON_SUI)
    expect(sendRefusal('near', 'USDC', 'ada.sol')).toContain('ada.sol is a Solana name')
    expect(sendRefusal('avalanche', 'USDC', 'ada.sol')).toContain('this is on Avalanche')
    expect(sendRefusal('monad', 'USDC', 'ada.sns')).toContain('this is on Monad')
    expect(sendRefusal('solana', 'USDC', 'bob.mon')).toContain('bob.mon is a Monad name')
    expect(sendRefusal('solana', 'USDC', 'bob.sui')).toContain('bob.sui is a Sui name')
    expect(sendRefusal('monad', 'USDC', 'bob.skr')).toContain('bob.skr is a Solana name')
  })

  it('refuses subnames and characters it will not read, on the right chain', () => {
    expect(sendRefusal('solana', 'USDC', 'pay.ada.sol')).toContain('pay.ada.sol')
    expect(sendRefusal('solana', 'USDC', 'pay.ada.sol')).toContain(NOTHING)
    expect(sendRefusal('solana', 'USDC', 'a_b.sol')).toContain("can't be read as a name")
  })

  it('passes a name on its own chain, and still checks the token', () => {
    expect(sendRefusal('solana', 'USDC', 'ada.sol')).toBeUndefined()
    expect(sendRefusal('solana', 'USDC', 'ada.poor')).toBeUndefined()
    expect(sendRefusal('sui', 'USDC', 'ada.sui')).toBeUndefined()
    expect(sendRefusal('monad', 'USDC', 'ada.mon')).toBeUndefined()
    expect(sendRefusal('solana', 'DOGE', 'ada.sol')).toContain('Sending DOGE')
  })

  it('refuses in the same words through the money path, with no read at all', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await expect(
      prepareChainAction(
        moduleWith('sui', [sendVenueStub('send')]),
        { kind: 'send', amount: '1', tokenIn: 'USDC', recipient: 'ada.sol' },
        '0x' + '1'.repeat(64)
      )
    ).rejects.toThrow(ON_SUI)
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

describe('SNS: the order, on ada.sns', () => {
  it('step 4: pays the owner when nothing else is set', async () => {
    const world = await snsWorld()
    await expect(resolveSnsName(world, 'ada.sns', 'ada')).resolves.toBe(owner.address)
  })

  it('step 3: a signed V1 record beats the owner', async () => {
    const world = await snsWorld()
    await setV1(world, wallet)
    await expect(resolveSnsName(world, 'ada.sns', 'ada')).resolves.toBe(wallet)
  })

  it('step 2: a verified V2 record beats V1 and the owner', async () => {
    const world = await snsWorld()
    await setV1(world, holder)
    await setV2(world, wallet)
    await expect(resolveSnsName(world, 'ada.sns', 'ada')).resolves.toBe(wallet)
  })

  it('step 1: the token holder beats every record', async () => {
    const world = await snsWorld()
    await setV2(world, wallet)
    await setHolder(world)
    await expect(resolveSnsName(world, 'ada.sns', 'ada')).resolves.toBe(holder)
  })

  it('an inactive token record is passed over', async () => {
    const world = await snsWorld()
    const { domain, nft, mint } = await snsAccounts('ada')
    world.set(nft, TOKENIZER, nftRecord(3, domain, mint))
    await expect(resolveSnsName(world, 'ada.sns', 'ada')).resolves.toBe(owner.address)
  })
})

describe('SNS: refusals', () => {
  const refused = async (world: SolanaNameRpc, match: RegExp | string): Promise<void> => {
    const attempt = resolveSnsName(world, 'ada.sns', 'ada')
    await expect(attempt).rejects.toBeInstanceOf(ChainActionRefused)
    await expect(attempt).rejects.toThrow(match)
    await expect(attempt).rejects.toThrow(NOTHING)
  }

  it('an unregistered name', async () => {
    await refused(new World(), "isn't registered")
  })

  it("a domain account not under the SNS root, or not the program's", async () => {
    const world = new World()
    const { domain } = await snsAccounts('ada')
    world.set(domain, NAME_PROGRAM, registry(wallet, owner.address))
    await refused(world, 'could not be confirmed')
    world.set(domain, wallet, registry(SNS_ROOT, owner.address))
    await refused(world, 'could not be confirmed')
  })

  it('a V1 record signed by nobody', async () => {
    const world = await snsWorld()
    const { domain, v1 } = await snsAccounts('ada')
    world.set(v1, NAME_PROGRAM, v1Data(domain, owner.address, wallet, new Uint8Array(64)))
    await refused(world, 'not signed')
  })

  it('a V1 record signed by a previous owner', async () => {
    const world = await snsWorld()
    await setV1(world, wallet, oldOwner.keys)
    await refused(world, 'not signed')
  })

  it('a V1 record whose address was changed after signing', async () => {
    const world = await snsWorld()
    await setV1(world, wallet)
    const { domain, v1 } = await snsAccounts('ada')
    const signed = world.accountsByAddress.get(v1) as NameAccount
    world.set(v1, NAME_PROGRAM, v1Data(domain, owner.address, holder, signed.data.slice(128)))
    await refused(world, 'not signed')
  })

  it('a V1 record signed over the raw bytes, not the hex SNS signs', async () => {
    const world = await snsWorld()
    const { domain, v1 } = await snsAccounts('ada')
    const signature = await signBytes(owner.keys.privateKey, bytes(encode(wallet), encode(v1)))
    world.set(v1, NAME_PROGRAM, v1Data(domain, owner.address, wallet, new Uint8Array(signature)))
    await refused(world, 'not signed')
  })

  it('a V1 record cut short', async () => {
    const world = await snsWorld()
    const { domain, v1 } = await snsAccounts('ada')
    world.set(v1, NAME_PROGRAM, bytes(registry(domain, owner.address), encode(wallet)))
    await refused(world, 'not signed')
  })

  it('a stale V2 record, set by a previous owner, even with a good V1 under it', async () => {
    const world = await snsWorld()
    await setV1(world, holder)
    await setV2(world, wallet, oldOwner.address)
    await refused(world, 'previous owner')
  })

  it('a V2 record whose right of association does not match its content', async () => {
    const world = await snsWorld()
    await setV2(world, wallet, owner.address, holder)
    await refused(world, "doesn't prove")
  })

  it('a V2 record with validation other than Solana', async () => {
    const world = await snsWorld()
    const { domain, v2 } = await snsAccounts('ada')
    world.set(v2, NAME_PROGRAM, v2Data(domain, owner.address, wallet, encode(wallet), { right: 3 }))
    await refused(world, "doesn't prove")
  })

  it('a V2 record whose content is not one address', async () => {
    const world = await snsWorld()
    const { domain, v2 } = await snsAccounts('ada')
    world.set(v2, NAME_PROGRAM, v2Data(domain, owner.address, wallet, new Uint8Array(20)))
    await refused(world, "doesn't prove")
  })

  it('a record account the name program does not own', async () => {
    const world = await snsWorld()
    const { domain, v2 } = await snsAccounts('ada')
    world.set(v2, wallet, v2Data(domain, owner.address, wallet, encode(wallet)))
    await refused(world, "doesn't prove")
  })

  it('a token record with no sole holder', async () => {
    let world = await snsWorld()
    await setHolder(world, 'ada', { holders: 0 })
    await refused(world, 'single holder')
    world = await snsWorld()
    await setHolder(world, 'ada', { holders: 2 })
    await refused(world, 'single holder')
    world = await snsWorld()
    await setHolder(world, 'ada', { supply: 2 })
    await refused(world, 'single holder')
  })

  it('a token record pointing at another mint', async () => {
    const world = await snsWorld()
    await setHolder(world)
    const { domain, nft } = await snsAccounts('ada')
    world.set(nft, TOKENIZER, nftRecord(2, domain, wallet))
    await refused(world, 'single holder')
  })

  it('a token record in a state it does not know', async () => {
    const world = await snsWorld()
    const { domain, nft, mint } = await snsAccounts('ada')
    world.set(nft, TOKENIZER, nftRecord(1, domain, mint))
    await refused(world, 'could not be confirmed')
  })
})

describe('.sol: the .sol registry and SNS must agree', () => {
  async function solWorld(srsOwner = owner.address, options = {}): Promise<World> {
    const world = await snsWorld()
    const { record } = await solAccounts('ada')
    world.set(record, SRS_PROGRAM, srsData(SRS_CLASS, 0, srsOwner, options))
    return world
  }

  it('pays when both say the same wallet', async () => {
    await expect(resolveSolName(await solWorld(), 'ada.sol', 'ada')).resolves.toBe(owner.address)
  })

  it('refuses when they name different wallets', async () => {
    const attempt = resolveSolName(await solWorld(wallet), 'ada.sol', 'ada')
    await expect(attempt).rejects.toThrow('two different wallets')
    await expect(attempt).rejects.toThrow(wallet)
    await expect(attempt).rejects.toThrow(owner.address)
  })

  it('refuses a V2 record that sends elsewhere than the .sol owner', async () => {
    const world = await solWorld()
    await setV2(world, wallet)
    await expect(resolveSolName(world, 'ada.sol', 'ada')).rejects.toThrow('two different wallets')
  })

  it('refuses a name only one of them knows', async () => {
    const onlySns = await snsWorld()
    await expect(resolveSolName(onlySns, 'ada.sol', 'ada')).rejects.toThrow(ChainActionRefused)
    const onlySrs = new World()
    const { record } = await solAccounts('ada')
    onlySrs.set(record, SRS_PROGRAM, srsData(SRS_CLASS, 0, owner.address))
    await expect(resolveSolName(onlySrs, 'ada.sol', 'ada')).rejects.toThrow(ChainActionRefused)
  })

  it('refuses an expired record, and passes the no-expiry and future ones', async () => {
    const now = Math.floor(Date.now() / 1000)
    await expect(
      resolveSolName(await solWorld(owner.address, { expiry: now - 1 }), 'ada.sol', 'ada')
    ).rejects.toThrow('expired')
    await expect(
      resolveSolName(await solWorld(owner.address, { expiry: now + 86_400 }), 'ada.sol', 'ada')
    ).resolves.toBe(owner.address)
  })

  it('refuses a frozen, misclassed, wrongly owned or malformed record', async () => {
    await expect(
      resolveSolName(await solWorld(owner.address, { frozen: 1 }), 'ada.sol', 'ada')
    ).rejects.toThrow('could not be confirmed')
    await expect(
      resolveSolName(await solWorld(owner.address, { discriminator: 1 }), 'ada.sol', 'ada')
    ).rejects.toThrow('could not be confirmed')
    const world = await snsWorld()
    const { record } = await solAccounts('ada')
    world.set(record, SRS_PROGRAM, srsData(wallet, 0, owner.address))
    await expect(resolveSolName(world, 'ada.sol', 'ada')).rejects.toThrow('could not be confirmed')
    world.set(record, wallet, srsData(SRS_CLASS, 0, owner.address))
    await expect(resolveSolName(world, 'ada.sol', 'ada')).rejects.toThrow('could not be confirmed')
    world.set(record, SRS_PROGRAM, srsData(SRS_CLASS, 2, owner.address))
    await expect(resolveSolName(world, 'ada.sol', 'ada')).rejects.toThrow('could not be confirmed')
  })

  it('reads a tokenized .sol record through its canonical Token-2022 mint', async () => {
    const world = await snsWorld('ada', holder)
    const { record, mint } = await solAccounts('ada')
    world.set(record, SRS_PROGRAM, srsData(SRS_CLASS, 1, mint))
    world.set(mint, TOKEN_2022, mintData())
    world.holders.set(mint, [{ address: 't', data: tokenData(mint, holder) }])
    await expect(resolveSolName(world, 'ada.sol', 'ada')).resolves.toBe(holder)

    world.set(record, SRS_PROGRAM, srsData(SRS_CLASS, 1, wallet))
    await expect(resolveSolName(world, 'ada.sol', 'ada')).rejects.toThrow('single holder')
  })

  it('refuses a mint run by the wrong token program', async () => {
    const world = await snsWorld('ada', holder)
    const { record, mint } = await solAccounts('ada')
    world.set(record, SRS_PROGRAM, srsData(SRS_CLASS, 1, mint))
    world.set(mint, TOKEN_PROGRAM, mintData())
    world.holders.set(mint, [{ address: 't', data: tokenData(mint, holder) }])
    await expect(resolveSolName(world, 'ada.sol', 'ada')).rejects.toThrow('single holder')
  })
})

describe('AllDomains on Solana', () => {
  const ALT_DISCRIMINATOR = [0x44, 0x48, 0x58, 0x2c, 0x0f, 0xa7, 0x67, 0xf3]
  const NFT_DISCRIMINATOR = [174, 190, 114, 100, 177, 14, 90, 254]

  function ansRecord(
    parent: string,
    recordOwner: string,
    expiry = 0,
    discriminator = ALT_DISCRIMINATOR
  ): Uint8Array {
    return bytes(
      discriminator,
      encode(parent),
      encode(recordOwner),
      encode(ZERO),
      u64(expiry),
      u64(0),
      new Uint8Array(80)
    )
  }

  it('pays the owner of an unwrapped name', async () => {
    const world = new World()
    const { parent, name } = await ansAccounts('ada', 'poor')
    world.set(name, ANS_PROGRAM, ansRecord(parent, owner.address))
    await expect(resolveAllDomainsSolana(world, 'ada.poor', 'ada', 'poor')).resolves.toBe(
      owner.address
    )
  })

  it('pays the holder of a wrapped name', async () => {
    const world = new World()
    const { parent, name, nftRecord: nft } = await ansAccounts('ada', 'poor')
    world.set(name, ANS_PROGRAM, ansRecord(parent, nft))
    world.set(
      nft,
      NAME_HOUSE,
      bytes(NFT_DISCRIMINATOR, [1, 255], encode(name), encode(ZERO), encode(wallet), encode(ZERO))
    )
    world.set(wallet, TOKEN_PROGRAM, mintData())
    world.holders.set(wallet, [{ address: 't', data: tokenData(wallet, holder) }])
    await expect(resolveAllDomainsSolana(world, 'ada.poor', 'ada', 'poor')).resolves.toBe(holder)
  })

  it('refuses a wrapped name whose record is inactive or for another name', async () => {
    const world = new World()
    const { parent, name, nftRecord: nft } = await ansAccounts('ada', 'poor')
    world.set(name, ANS_PROGRAM, ansRecord(parent, nft))
    world.set(
      nft,
      NAME_HOUSE,
      bytes(NFT_DISCRIMINATOR, [2, 255], encode(name), encode(ZERO), encode(wallet), encode(ZERO))
    )
    await expect(resolveAllDomainsSolana(world, 'ada.poor', 'ada', 'poor')).rejects.toThrow(
      'could not be confirmed'
    )
    world.set(
      nft,
      NAME_HOUSE,
      bytes(NFT_DISCRIMINATOR, [1, 255], encode(wallet), encode(ZERO), encode(wallet), encode(ZERO))
    )
    await expect(resolveAllDomainsSolana(world, 'ada.poor', 'ada', 'poor')).rejects.toThrow(
      'could not be confirmed'
    )
  })

  it('refuses an expired name, and passes one with time left', async () => {
    const now = Math.floor(Date.now() / 1000)
    const world = new World()
    const { parent, name } = await ansAccounts('ada', 'poor')
    world.set(name, ANS_PROGRAM, ansRecord(parent, owner.address, now - 1))
    await expect(resolveAllDomainsSolana(world, 'ada.poor', 'ada', 'poor')).rejects.toThrow(
      'expired'
    )
    world.set(name, ANS_PROGRAM, ansRecord(parent, owner.address, now + 86_400))
    await expect(resolveAllDomainsSolana(world, 'ada.poor', 'ada', 'poor')).resolves.toBe(
      owner.address
    )
  })

  it('refuses a missing name, a wrong parent, a wrong program, a wrong discriminator', async () => {
    const world = new World()
    const { parent, name } = await ansAccounts('ada', 'poor')
    await expect(resolveAllDomainsSolana(world, 'ada.poor', 'ada', 'poor')).rejects.toThrow(
      "isn't registered"
    )
    world.set(name, ANS_PROGRAM, ansRecord(wallet, owner.address))
    await expect(resolveAllDomainsSolana(world, 'ada.poor', 'ada', 'poor')).rejects.toThrow(
      'could not be confirmed'
    )
    world.set(name, wallet, ansRecord(parent, owner.address))
    await expect(resolveAllDomainsSolana(world, 'ada.poor', 'ada', 'poor')).rejects.toThrow(
      'could not be confirmed'
    )
    world.set(name, ANS_PROGRAM, ansRecord(parent, owner.address, 0, [1, 2, 3, 4, 5, 6, 7, 8]))
    await expect(resolveAllDomainsSolana(world, 'ada.poor', 'ada', 'poor')).rejects.toThrow(
      'could not be confirmed'
    )
  })
})

describe('AllDomains on Monad', () => {
  const HOLDER = getAddress('0x94bfb92da83b27b39370550ca038af96d182462f')
  const OTHER = getAddress('0x1111111111111111111111111111111111111111')
  const REGISTRAR = getAddress('0xbc811d4c4a17a645e024e8b9eefa72d4ed30cdd0')

  interface Chain {
    tld?: string
    registrar?: string
    owner?: string
    resolver?: string
    name?: string
    expiry?: bigint
    nftOwner?: string
    addr?: string
    fail?: boolean
  }

  function reader(chain: Chain = {}): MonadNameReader & { calls: string[] } {
    const calls: string[] = []
    return {
      calls,
      read: async ({ address, functionName, args }) => {
        calls.push(`${address}:${functionName}`)
        if (chain.fail === true) throw new Error('rpc down')
        const node = ansNode('ada', 'mon')
        switch (functionName) {
          case 'getTld':
            expect(address).toBe(ANS_MONAD_ROOT)
            expect(args?.[0]).toBe(keccak256(toBytes('.mon')))
            return {
              tld: chain.tld ?? '.mon',
              registrar: chain.registrar ?? REGISTRAR,
            }
          case 'owner':
            expect(address).toBe(ANS_MONAD_REGISTRY)
            expect(args?.[0]).toBe(node)
            return chain.owner ?? HOLDER
          case 'resolver':
            expect(address).toBe(ANS_MONAD_REGISTRY)
            return chain.resolver ?? ANS_MONAD_RESOLVER
          case 'nameData':
            expect(address).toBe(chain.registrar ?? REGISTRAR)
            expect(args?.[0]).toBe(BigInt(keccak256(toBytes('ada'))))
            return {
              name: chain.name ?? 'ada',
              expiry: chain.expiry ?? BigInt(Math.floor(Date.now() / 1000) + 86_400),
              owner: chain.nftOwner ?? HOLDER,
            }
          case 'addr':
            expect(address).toBe(ANS_MONAD_RESOLVER)
            return chain.addr ?? zeroAddress
          default:
            throw new Error(`unexpected ${functionName}`)
        }
      },
    }
  }

  const resolve = (chain?: Chain): Promise<string> =>
    resolveAllDomainsMonad(reader(chain), 'ada.mon', 'ada', 'mon')

  it('computes the node as the protocol does, with the dot in the ending', () => {
    // The .mon node as root.listTlds() returns it on chain, then the label over it.
    const tldNode = '0xcbc339c8da5e6733357b69f6b396a8319afd0a9624eb6cc5ef65e35b54a77421'
    expect(ansNode('miester', 'mon')).toBe(
      keccak256(`0x${tldNode.slice(2)}${keccak256(toBytes('miester')).slice(2)}`)
    )
  })

  it('pays the owner when the registry, the registrar and the resolver agree', async () => {
    await expect(resolve()).resolves.toBe(HOLDER)
    await expect(resolve({ addr: HOLDER })).resolves.toBe(HOLDER)
    await expect(resolve({ resolver: zeroAddress })).resolves.toBe(HOLDER)
  })

  it('refuses an unregistered name', async () => {
    await expect(resolve({ owner: zeroAddress, nftOwner: zeroAddress, name: '' })).rejects.toThrow(
      "isn't registered"
    )
  })

  it('refuses an expired name', async () => {
    await expect(resolve({ expiry: BigInt(Math.floor(Date.now() / 1000) - 1) })).rejects.toThrow(
      'expired'
    )
  })

  it('refuses when the registrar and the registry disagree', async () => {
    await expect(resolve({ nftOwner: OTHER })).rejects.toThrow('two different wallets')
  })

  it('refuses an address record set elsewhere than the owner', async () => {
    await expect(resolve({ addr: OTHER })).rejects.toThrow('two different wallets')
  })

  it('refuses a resolver this app does not know', async () => {
    await expect(resolve({ resolver: OTHER })).rejects.toThrow('could not be confirmed')
  })

  it('refuses a registrar record for another name or ending', async () => {
    await expect(resolve({ name: 'bob' })).rejects.toThrow('could not be confirmed')
    await expect(resolve({ tld: '.nad' })).rejects.toThrow('could not be confirmed')
    await expect(resolve({ registrar: zeroAddress })).rejects.toThrow('could not be confirmed')
  })

  it('never reads a registrar this root did not name, and a failed read is a refusal', async () => {
    const seen = reader()
    await resolveAllDomainsMonad(seen, 'ada.mon', 'ada', 'mon')
    expect(seen.calls[0]).toBe(`${ANS_MONAD_ROOT}:getTld`)
    await expect(
      resolveName('monad', recipientName('ada.mon')!, { monad: () => reader({ fail: true }) })
    ).rejects.toThrow('could not be read')
  })
})

describe('SuiNS', () => {
  const TARGET = '0x' + 'a'.repeat(64)
  const future = (): bigint => BigInt(Date.now() + 86_400_000)
  const encodeNameRecord = ({
    expiresMs,
    target,
  }: {
    expiresMs: bigint
    target: string | null
  }): Uint8Array =>
    NameRecord.serialize({
      nft_id: '0x' + 'b'.repeat(64),
      expiration_timestamp_ms: expiresMs,
      target_address: target,
      data: { contents: [{ key: 'avatar', value: 'x' }] },
    }).toBytes()

  function reader(
    record: { value: Uint8Array; type: string } | null | 'broken'
  ): SuiNameReader & { labels: string[][] } {
    const labels: string[][] = []
    return {
      labels,
      nameRecord: async (parts) => {
        labels.push([...parts])
        if (record === 'broken') throw new Error('rpc down')
        return record
      },
    }
  }

  it('pays the target, reading the labels in the order the registry keys them', async () => {
    const seen = reader({
      value: encodeNameRecord({ expiresMs: future(), target: TARGET }),
      type: SUINS_NAME_RECORD_TYPE,
    })
    await expect(resolveSuiName(seen, 'ada.sui', 'ada')).resolves.toBe(TARGET)
    expect(seen.labels).toEqual([['sui', 'ada']])
    expect(SUINS_REGISTRY_TABLE).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('refuses a name with no target set', async () => {
    await expect(
      resolveSuiName(
        reader({
          value: encodeNameRecord({ expiresMs: future(), target: null }),
          type: SUINS_NAME_RECORD_TYPE,
        }),
        'ada.sui',
        'ada'
      )
    ).rejects.toThrow('no address set')
  })

  it('refuses an expired name', async () => {
    await expect(
      resolveSuiName(
        reader({
          value: encodeNameRecord({ expiresMs: BigInt(Date.now() - 1), target: TARGET }),
          type: SUINS_NAME_RECORD_TYPE,
        }),
        'ada.sui',
        'ada'
      )
    ).rejects.toThrow('expired')
  })

  it('refuses an unregistered name', async () => {
    await expect(resolveSuiName(reader(null), 'ada.sui', 'ada')).rejects.toThrow("isn't registered")
  })

  it('refuses a value of any other type, and bytes that do not decode', async () => {
    await expect(
      resolveSuiName(
        reader({
          value: encodeNameRecord({ expiresMs: future(), target: TARGET }),
          type: '0x2::other::Thing',
        }),
        'ada.sui',
        'ada'
      )
    ).rejects.toThrow('could not be confirmed')
    await expect(
      resolveName('sui', recipientName('ada.sui')!, {
        sui: () => reader({ value: new Uint8Array([1, 2]), type: SUINS_NAME_RECORD_TYPE }),
      })
    ).rejects.toThrow('could not be read')
  })

  it('a failed read is a refusal, and the card warns a sold name keeps its target', async () => {
    await expect(
      resolveName('sui', recipientName('ada.sui')!, { sui: () => reader('broken') })
    ).rejects.toThrow('could not be read')
    const resolved = await resolveName('sui', recipientName('ada.sui')!, {
      sui: () =>
        reader({
          value: encodeNameRecord({ expiresMs: future(), target: TARGET }),
          type: SUINS_NAME_RECORD_TYPE,
        }),
    })
    expect(resolved).toMatchObject({ name: 'ada.sui', address: TARGET, source: 'SuiNS' })
    expect(resolved.caution).toContain('sold')
  })
})

describe('resolveName', () => {
  it('routes .sol and .sns to SNS, with the .sol registry only behind .sol', async () => {
    const world = await snsWorld()
    await expect(
      resolveName('solana', recipientName('ada.sns')!, { solana: () => world })
    ).resolves.toMatchObject({ address: owner.address, source: 'the Solana Name Service' })
    await expect(
      resolveName('solana', recipientName('ada.sol')!, { solana: () => world })
    ).rejects.toThrow(ChainActionRefused)
  })

  it('a failed read is a refusal, never a guess', async () => {
    const world = await snsWorld()
    world.broken = true
    await expect(
      resolveName('solana', recipientName('ada.sns')!, { solana: () => world })
    ).rejects.toThrow(
      `ada.sns could not be read from the chain just now, so I won't guess where it points. Try again, or use the wallet address. ${NOTHING}`
    )
  })

  it('refuses anything a program holds rather than a wallet', async () => {
    const { domain } = await snsAccounts('ada')
    const world = await snsWorld('ada', domain)
    await expect(
      resolveName('solana', recipientName('ada.sns')!, { solana: () => world })
    ).rejects.toThrow('held by a program')
  })

  it('will not run a name on the wrong chain even if asked directly', async () => {
    await expect(resolveName('sui', recipientName('ada.sol')!, {})).rejects.toThrow(
      'is a Solana name'
    )
  })
})

describe('a resolved address gets every check a typed address gets', () => {
  it('refuses a name that points at a token contract, the zero address or your own wallet', async () => {
    const mint = SOLANA_TOKENS.find((t) => t.symbol === 'USDC')?.id as string
    for (const [target, words] of [
      [mint, 'not an address that can receive'],
      [ZERO, 'not an address that can receive'],
      [me, 'your own wallet'],
    ] as const) {
      await expect(
        resolveRecipient('solana', 'USDC', 'ada.sns', me, {
          solana: () => ({
            accounts: async (addresses: readonly string[]) =>
              addresses.map((_, i) =>
                i === 0 ? { program: NAME_PROGRAM, data: registry(SNS_ROOT, target) } : null
              ),
            tokenAccounts: async () => [],
          }),
        })
      ).rejects.toThrow(words)
    }
  })

  it('says which name led there', async () => {
    const world = await snsWorld('ada', me)
    await expect(
      resolveRecipient('solana', 'USDC', 'ada.sns', me, { solana: () => world })
    ).rejects.toThrow(`ada.sns points to ${me}.`)
  })

  it('leaves a typed address alone and does not read anything', async () => {
    const world = await snsWorld()
    await expect(
      resolveRecipient('solana', 'USDC', wallet, me, { solana: () => world })
    ).resolves.toBeUndefined()
    expect(world.reads).toBe(0)
  })
})

describe('the card', () => {
  const prepared: PreparedAction = {
    venueId: 'send',
    venueName: 'Wallet transfer',
    kind: 'send',
    summary: 'Send 1 USDC to WALLET.',
    pay: { amount: '1', symbol: 'USDC' },
    notes: ['Existing note.'],
    signing: { family: 'solana', transaction: 'x' },
    context: { recipient: 'WALLET' },
  }
  const named = { name: 'ada.sol', address: 'WALLET', source: 'the Solana Name Service' }

  it('names the address and where it came from', () => {
    const card = withResolvedName(prepared, named)
    expect(card.summary).toBe('Send 1 USDC to ada.sol (WALLET).')
    expect(card.notes[0]).toContain('ada.sol points to WALLET')
    expect(card.notes[0]).toContain('the Solana Name Service')
    expect(card.notes).toContain('Existing note.')
  })

  it('adds the address where a summary leaves it out', () => {
    const card = withResolvedName({ ...prepared, summary: 'Stream 1 USDC for 30 days.' }, named)
    expect(card.summary).toBe('Stream 1 USDC for 30 days. ada.sol is WALLET.')
  })

  it('refuses a venue that issued anything but the address the name read to', () => {
    expect(() =>
      withResolvedName({ ...prepared, context: { recipient: 'SOMEONE_ELSE' } }, named)
    ).toThrow(ChainActionRefused)
  })
})

/** A module whose venues are given, reading nothing else. */
function moduleWith(chain: ChainWithActions, venues: ChainVenue[]): ChainModule {
  return {
    chain,
    tokens: SOLANA_TOKENS,
    venues,
    defaultVenue: { send: venues[0]?.id ?? 'send' },
    priceUsd: async () => 1,
    submit: async () => ({ ok: false, error: 'unused' }),
    balances: async () => ({ tokens: [], complete: false }),
  }
}

function sendVenueStub(id: string, kinds: ChainActionKind[] = ['send', 'stream', 'invoice']) {
  const seen: ChainActionRequest[] = []
  const venue: ChainVenue & { seen: ChainActionRequest[] } = {
    id,
    name: id,
    kinds,
    seen,
    prepare: async (request) => {
      seen.push(request)
      return {
        venueId: id,
        venueName: id,
        kind: request.kind,
        summary: `${request.kind} over time.`,
        pay: { amount: request.amount, symbol: request.tokenIn },
        notes: [],
        signing: { family: 'solana', transaction: 'x' },
        context: { recipient: request.recipient as string },
      }
    },
    assertSafe: () => undefined,
  }
  return venue
}

describe('through prepareChainAction', () => {
  let world: World
  let methods: string[]
  let executable: boolean

  beforeEach(async () => {
    world = await snsWorld()
    methods = []
    executable = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL, init?: RequestInit) => {
        const { method, params } = JSON.parse(init?.body as string) as {
          method: string
          params: unknown[]
        }
        methods.push(method)
        const b64 = (data: Uint8Array): string => Buffer.from(data).toString('base64')
        const reply = (result: unknown): Response =>
          new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }))
        if (method === 'getMultipleAccounts') {
          const found = await world.accounts(params[0] as string[])
          return reply({
            context: { slot: 1 },
            value: found.map((account) =>
              account === null
                ? null
                : { owner: account.program, data: [b64(account.data), 'base64'] }
            ),
          })
        }
        if (method === 'getAccountInfo') {
          return reply({
            context: { slot: 1 },
            value: executable ? { owner: 'x', executable } : null,
          })
        }
        if (method === 'getLatestBlockhash') {
          return reply({
            context: { slot: 1 },
            value: {
              blockhash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
              lastValidBlockHeight: 9,
            },
          })
        }
        throw new Error(`unexpected ${method}`)
      })
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const request: ChainActionRequest = {
    kind: 'send',
    amount: '50',
    tokenIn: 'USDC',
    recipient: 'ada.sns',
  }

  it('builds to the resolved address, binds the proof to it, and shows it', async () => {
    const venue = createSendVenue('solana')
    const prepared = await prepareChainAction(moduleWith('solana', [venue]), request, me)

    expect(prepared.context?.['recipient']).toBe(owner.address)
    expect(prepared.context?.['proof']).toBeDefined()
    expect(prepared.summary).toBe(`Send 50 USDC to ada.sns (${owner.address}).`)
    expect(prepared.notes[0]).toContain(`ada.sns points to ${owner.address}`)
    expect(prepared.notes[0]).toContain('the Solana Name Service')

    expect(() => venue.assertSafe(prepared.signing, me, prepared.context)).not.toThrow()
    expect(() =>
      venue.assertSafe(prepared.signing, me, { ...prepared.context, recipient: 'ada.sns' })
    ).toThrow(ChainActionRefused)
    expect(() =>
      venue.assertSafe(prepared.signing, me, { ...prepared.context, recipient: wallet })
    ).toThrow(ChainActionRefused)
  })

  it('reads the name again each time, so a moved name is what is shown', async () => {
    const venue = createSendVenue('solana')
    const api = moduleWith('solana', [venue])
    const first = await prepareChainAction(api, request, me)
    const { domain } = await snsAccounts('ada')
    world.set(domain, NAME_PROGRAM, registry(SNS_ROOT, wallet))
    const second = await prepareChainAction(api, request, me)
    expect(first.context?.['recipient']).toBe(owner.address)
    expect(second.context?.['recipient']).toBe(wallet)
    expect(() => venue.assertSafe(second.signing, me, first.context)).toThrow(ChainActionRefused)
  })

  it('still stops at the receiver check the build makes', async () => {
    executable = true
    await expect(
      prepareChainAction(moduleWith('solana', [createSendVenue('solana')]), request, me)
    ).rejects.toThrow('That address is a program')
  })

  it('builds nothing when the connection drops', async () => {
    world.broken = true
    await expect(
      prepareChainAction(moduleWith('solana', [createSendVenue('solana')]), request, me)
    ).rejects.toThrow("Solana didn't answer in time. Nothing was signed or sent")
    expect(methods).not.toContain('getLatestBlockhash')
  })

  it.each([
    ['an RPC error', () => new Response('{"jsonrpc":"2.0","id":1,"error":{"code":-32005}}')],
    ['a 500', () => new Response('oops', { status: 500 })],
    ['an answer of the wrong shape', () => new Response('{"result":{"value":[{"owner":1}]}}')],
    ['too few accounts', () => new Response('{"result":{"value":[null]}}')],
    [
      'data in another encoding',
      () =>
        new Response('{"result":{"value":[{"owner":"x","data":["00","base58"]},null,null,null]}}'),
    ],
  ])('builds nothing on %s', async (_what, answer) => {
    const earlier = vi.mocked(fetch).getMockImplementation()
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const { method } = JSON.parse(init?.body as string) as { method: string }
      methods.push(method)
      if (method === 'getMultipleAccounts') return answer()
      return (earlier as typeof fetch)(input, init)
    })
    await expect(
      prepareChainAction(moduleWith('solana', [createSendVenue('solana')]), request, me)
    ).rejects.toThrow('ada.sns could not be read from the chain just now')
    expect(methods).not.toContain('getLatestBlockhash')
  })

  it('builds nothing on a tampered record', async () => {
    await setV2(world, wallet, oldOwner.address)
    await expect(
      prepareChainAction(moduleWith('solana', [createSendVenue('solana')]), request, me)
    ).rejects.toThrow('previous owner')
    expect(methods).not.toContain('getLatestBlockhash')
  })

  it('streams and invoices go the same way', async () => {
    const venue = sendVenueStub('fake')
    const api: ChainModule = {
      ...moduleWith('solana', [venue]),
      defaultVenue: { stream: 'fake', invoice: 'fake' },
    }
    for (const kind of ['stream', 'invoice'] as const) {
      const prepared = await prepareChainAction(api, { ...request, kind }, me)
      expect(venue.seen.at(-1)?.recipient).toBe(owner.address)
      expect(prepared.summary).toContain(`ada.sns is ${owner.address}.`)
      expect(prepared.notes[0]).toContain(`ada.sns points to ${owner.address}`)
    }
  })

  it('refuses a venue that kept the typed name or changed the address', async () => {
    const venue: ChainVenue = {
      ...sendVenueStub('fake'),
      prepare: async (r) => ({
        venueId: 'fake',
        venueName: 'fake',
        kind: r.kind,
        summary: 'x',
        pay: { amount: r.amount, symbol: r.tokenIn },
        notes: [],
        signing: { family: 'solana', transaction: 'x' },
        context: { recipient: wallet },
      }),
    }
    await expect(prepareChainAction(moduleWith('solana', [venue]), request, me)).rejects.toThrow(
      ChainActionRefused
    )
  })

  it('a kind that names no one still refuses a name', async () => {
    await expect(
      prepareChainAction(
        { ...moduleWith('solana', [sendVenueStub('fake', ['swap'])]) },
        { ...request, kind: 'supply' },
        me
      )
    ).rejects.toThrow("doesn't take an address")
  })

  it('the send venue will not take a name that was not read first', async () => {
    const venue = createSendVenue('solana')
    await expect(venue.prepare(request, me)).rejects.toThrow(ChainActionRefused)
    expect(methods).toEqual([])
  })

  it('a follow-on reads the name before the swap, and refuses what it finds', async () => {
    const venue = createSendVenue('solana')
    await expect(
      venue.assertCanFollow?.({ kind: 'send', tokenIn: 'USDC', recipient: 'ada.sns' }, me)
    ).resolves.toBeUndefined()
    expect(methods).toContain('getMultipleAccounts')
    await setV2(world, wallet, oldOwner.address)
    await expect(
      venue.assertCanFollow?.({ kind: 'send', tokenIn: 'USDC', recipient: 'ada.sns' }, me)
    ).rejects.toThrow('previous owner')
  })
})
