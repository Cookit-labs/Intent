import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  generateKeyPair,
  getAddressFromPublicKey,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getPublicKeyFromAddress,
  getTransactionDecoder,
  getTransactionEncoder,
  signBytes,
  verifySignature,
  type Address,
  type SignatureBytes,
} from '@solana/kit'
import type { Wallet, WalletAccount } from '@wallet-standard/base'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { prepareChainAction } from '../chains/prepare'
import {
  associatedTokenAccount,
  decodeSolanaTransaction,
  ownWrappedSolAccount,
  solanaAssertSafe,
} from '../chains/solana/assert-safe'
import { solanaCapabilities } from '../chains/solana/capabilities'
import { buildCreate, createKaminoLimitVenue, limoBook } from '../chains/solana/limo'
import {
  decodeOrder,
  eventAuthority,
  inputVault,
  limoAssertSafe,
  pdaAuthority,
} from '../chains/solana/limo-rules'
import { buildSolanaVenues, solanaModule } from '../chains/solana/module'
import { JUPITER_SWAP_POLICY, LIMO_GLOBAL_CONFIG, LIMO_PROGRAM } from '../chains/solana/programs'
import { signSolana } from '../chains/solana/sign'
import { feePayerSignature } from '../chains/solana/submit'
import { solanaVenues } from '../chains/solana/venues'
import { ChainActionRefused, type PreparedAction, type SigningPayload } from '../chains/types'

const ACCOUNT = 'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS'
const ATTACKER = 'BPFLoaderUpgradeab1e11111111111111111111111'
const SOL = 'So11111111111111111111111111111111111111112'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
const JITO_SOL = 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn'
const SYSTEM = '11111111111111111111111111111111'
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
const BLOCKHASH = 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k'
const LIFETIME = { blockhash: BLOCKHASH, lastValidBlockHeight: 1000 }
const CREATE_ORDER = [141, 54, 37, 207, 237, 210, 250, 215]
const CLOSE_ORDER = [244, 27, 12, 226, 45, 247, 230, 43]
const UPDATE_ORDER = [54, 8, 208, 207, 34, 134, 239, 168]

interface MessageInstruction {
  programAddressIndex: number
  accountIndices?: readonly number[]
  data?: Uint8Array
}
interface Message {
  version: number | 'legacy'
  header: {
    numSignerAccounts: number
    numReadonlySignerAccounts: number
    numReadonlyNonSignerAccounts: number
  }
  staticAccounts: readonly Address[]
  lifetimeToken: string
  instructions: readonly MessageInstruction[]
}

function open(base64: string): Message {
  const { messageBytes } = getTransactionDecoder().decode(Buffer.from(base64, 'base64'))
  return getCompiledTransactionMessageDecoder().decode(messageBytes) as unknown as Message
}

/** A changed message, with the extra signers' slots filled as they are on a real payload. */
function close(message: Message): string {
  const bytes = getCompiledTransactionMessageEncoder().encode(
    message as unknown as Parameters<
      ReturnType<typeof getCompiledTransactionMessageEncoder>['encode']
    >[0]
  )
  const count = message.header.numSignerAccounts
  return Buffer.concat([
    Buffer.from([count]),
    Buffer.alloc(64),
    Buffer.alloc(64 * (count - 1), 1),
    Buffer.from(bytes),
  ]).toString('base64')
}

/** Adds a read-only account, keeping every index pointing at the same address. */
function withAccount(message: Message, address: string): { next: Message; index: number } {
  const found = message.staticAccounts.indexOf(address as Address)
  if (found !== -1) return { next: message, index: found }
  const index = message.staticAccounts.length
  return {
    index,
    next: {
      ...message,
      header: {
        ...message.header,
        numReadonlyNonSignerAccounts: message.header.numReadonlyNonSignerAccounts + 1,
      },
      staticAccounts: [...message.staticAccounts, address as Address],
    },
  }
}

function indexOfInstruction(message: Message, program: string, firstByte: number): number {
  const index = message.instructions.findIndex(
    (ix) => message.staticAccounts[ix.programAddressIndex] === program && ix.data?.[0] === firstByte
  )
  if (index === -1) throw new Error(`No instruction on ${program} starting ${firstByte}`)
  return index
}

function replaceInstruction(
  message: Message,
  index: number,
  change: Partial<MessageInstruction>
): Message {
  return {
    ...message,
    instructions: message.instructions.map((ix, i) => (i === index ? { ...ix, ...change } : ix)),
  }
}

/** Points one account of an instruction somewhere else. */
function withAccountAt(
  message: Message,
  instruction: number,
  position: number,
  address: string
): Message {
  const { next, index } = withAccount(message, address)
  const accounts = [...(next.instructions[instruction]?.accountIndices ?? [])]
  accounts[position] = index
  return replaceInstruction(next, instruction, { accountIndices: accounts })
}

function appended(
  message: Message,
  program: string,
  accounts: readonly string[],
  data: readonly number[]
): Message {
  let next = message
  const indexOf = (address: string): number => {
    const added = withAccount(next, address)
    next = added.next
    return added.index
  }
  const programAddressIndex = indexOf(program)
  const accountIndices = accounts.map(indexOf)
  return {
    ...next,
    instructions: [
      ...next.instructions,
      { programAddressIndex, accountIndices, data: Uint8Array.from(data) },
    ],
  }
}

function u64(value: bigint): number[] {
  const bytes = Buffer.alloc(8)
  bytes.writeBigUInt64LE(value)
  return [...bytes]
}

function createOrderData(input: bigint, output: bigint): Uint8Array {
  return Uint8Array.from([...CREATE_ORDER, ...u64(input), ...u64(output), 0])
}

const createOrderIndex = (m: Message): number =>
  indexOfInstruction(m, LIMO_PROGRAM, CREATE_ORDER[0]!)
const createAccountIndex = (m: Message): number => indexOfInstruction(m, SYSTEM, 0)

function createAccountData(lamports: bigint, space: bigint, owner: string): Uint8Array {
  return Uint8Array.from([0, 0, 0, 0, ...u64(lamports), ...u64(space), ...addressBytes(owner)])
}

function addressBytes(address: string): number[] {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  let value = BigInt(0)
  for (const c of address) value = value * BigInt(58) + BigInt(alphabet.indexOf(c))
  const bytes: number[] = []
  while (value > BigInt(0)) {
    bytes.unshift(Number(value % BigInt(256)))
    value /= BigInt(256)
  }
  while (bytes.length < 32) bytes.unshift(0)
  return bytes
}

const base = await buildCreate({
  account: ACCOUNT,
  tokenIn: 'SOL',
  tokenOut: 'USDC',
  amount: '1',
  limitPrice: '110',
  lifetime: LIFETIME,
})
const baseMessage = open(base.transaction)

function assertWith(message: Message, context = base.context): void {
  limoAssertSafe({ family: 'solana', transaction: close(message) }, ACCOUNT, context)
}

/** The refusal's words, so a case can't pass because something else refused first. */
function refusal(run: () => void): string {
  try {
    run()
  } catch (e) {
    if (e instanceof ChainActionRefused) return e.message
    throw e
  }
  throw new Error('It was not refused.')
}

interface RpcReply {
  [method: string]: unknown
}

const calls: { method: string; params: unknown[] }[] = []

function stubRpc(replies: RpcReply): void {
  calls.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const { method, params } = JSON.parse(init.body as string) as {
        method: string
        params: unknown[]
      }
      calls.push({ method, params })
      if (!(method in replies)) throw new Error(`Unexpected RPC call: ${method}`)
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: replies[method] }))
    })
  )
}

function configBytes(
  change: { txnFee?: number; ataCost?: number; newOrdersBlocked?: number; emergency?: number } = {}
): string {
  const bytes = Buffer.alloc(2168)
  Buffer.from([149, 8, 156, 202, 160, 252, 176, 217]).copy(bytes, 0)
  bytes[8] = change.emergency ?? 0
  bytes[10] = change.newOrdersBlocked ?? 0
  bytes.writeBigUInt64LE(BigInt(change.txnFee ?? 3_000_000), 224)
  bytes.writeBigUInt64LE(BigInt(change.ataCost ?? 0), 232)
  return bytes.toString('base64')
}

function liveAccount(data: string, owner: string, lamports = 1_000_000) {
  return { data: [data, 'base64'], owner, lamports, executable: false, rentEpoch: 0 }
}

function liveConfig(config = configBytes(), vaultThere = true): RpcReply {
  return {
    getMultipleAccounts: {
      context: { slot: 1 },
      value: [
        liveAccount(config, LIMO_PROGRAM),
        vaultThere ? liveAccount(Buffer.alloc(165).toString('base64'), TOKEN) : null,
      ],
    },
    getLatestBlockhash: { context: { slot: 1 }, value: LIFETIME },
  }
}

const SOL_FOR_USDC = {
  kind: 'limit' as const,
  amount: '1',
  tokenIn: 'SOL',
  tokenOut: 'USDC',
  limitPrice: '110',
}

const FIXTURE = (): { address: string; lamports: number; owner: string; data: string } =>
  JSON.parse(
    readFileSync(join(__dirname, '../chains/solana/__fixtures__/limo-order.json'), 'utf8')
  ) as { address: string; lamports: number; owner: string; data: string }
const FIXTURE_MAKER = 'vuRtvoHwadVZABXSfuWD35gHiDU9eTFpxxXbnwT9k5R'

/** The fixture with its status and amounts changed, as an order earlier in its life would read. */
function orderLike(change: {
  maker?: string
  status?: number
  remaining?: bigint
  filled?: bigint
  outputMint?: string
}): string {
  const bytes = Buffer.from(FIXTURE().data, 'base64')
  if (change.maker !== undefined) Buffer.from(addressBytes(change.maker)).copy(bytes, 40)
  if (change.outputMint !== undefined) Buffer.from(addressBytes(change.outputMint)).copy(bytes, 136)
  if (change.remaining !== undefined) bytes.writeBigUInt64LE(change.remaining, 216)
  if (change.filled !== undefined) bytes.writeBigUInt64LE(change.filled, 224)
  if (change.status !== undefined) bytes[249] = change.status
  return bytes.toString('base64')
}

function liveOrder(data: string, lamports = 3_841_920): RpcReply {
  return {
    getAccountInfo: { context: { slot: 1 }, value: liveAccount(data, LIMO_PROGRAM, lamports) },
    getLatestBlockhash: { context: { slot: 1 }, value: LIFETIME },
  }
}

function solanaTransaction(prepared: PreparedAction): string {
  if (prepared.signing.family !== 'solana') throw new Error('Expected Solana.')
  return prepared.signing.transaction
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('buildCreate', () => {
  const accountsOf = (m: Message, ix: MessageInstruction): (string | undefined)[] =>
    (ix.accountIndices ?? []).map((i) => m.staticAccounts[i])

  it('makes 1 SOL to USDC at 110 a create_order for exactly those amounts', () => {
    const order = baseMessage.instructions[createOrderIndex(baseMessage)]!
    expect([...(order.data ?? [])]).toEqual([
      ...createOrderData(BigInt(1000000000), BigInt(110000000)),
    ])
    expect(base.context).toEqual({
      inputMint: SOL,
      outputMint: USDC,
      inputAmount: '1000000000',
      outputAmount: '110000000',
    })
  })

  it('gives create_order its accounts in the program’s order', () => {
    const order = baseMessage.instructions[createOrderIndex(baseMessage)]!
    expect(accountsOf(baseMessage, order)).toEqual([
      ACCOUNT,
      LIMO_GLOBAL_CONFIG,
      pdaAuthority(),
      base.order,
      SOL,
      USDC,
      ownWrappedSolAccount(ACCOUNT),
      inputVault(SOL),
      TOKEN,
      TOKEN,
      SYSTEM,
      eventAuthority(),
      LIMO_PROGRAM,
    ])
  })

  it('derives the same PDAs the deployed program uses', () => {
    expect(pdaAuthority()).toBe('DJGVEH2F5DdwQVNgxtCEVSpC2Qu5sEjRmBHfa22tAnYY')
  })

  it('creates the order account at 424 bytes owned by the program, with the order key signing', () => {
    const create = baseMessage.instructions[createAccountIndex(baseMessage)]!
    expect(accountsOf(baseMessage, create)).toEqual([ACCOUNT, base.order])
    expect([...(create.data ?? [])]).toEqual([
      0,
      0,
      0,
      0,
      ...u64(BigInt(3841920)),
      ...u64(BigInt(424)),
      ...addressBytes(LIMO_PROGRAM),
    ])
    expect(baseMessage.header.numSignerAccounts).toBe(2)
    expect(baseMessage.staticAccounts[1]).toBe(base.order)
  })

  it('creates the output token account, because the SDK omits it and fills can fail without it', () => {
    const creates = baseMessage.instructions
      .filter((ix) => baseMessage.staticAccounts[ix.programAddressIndex] === ATA)
      .map((ix) => ({ data: [...(ix.data ?? [])], accounts: accountsOf(baseMessage, ix) }))
    const output = associatedTokenAccount(ACCOUNT, USDC)
    expect(creates).toContainEqual({
      data: [1],
      accounts: [ACCOUNT, output, ACCOUNT, USDC, SYSTEM, TOKEN],
    })
  })

  it('wraps exactly the amount, syncs, and closes the wrapped account back to the maker', () => {
    const wrapped = ownWrappedSolAccount(ACCOUNT)
    const programs = baseMessage.instructions
      .map((ix) => baseMessage.staticAccounts[ix.programAddressIndex])
      .filter((p) => !String(p).startsWith('ComputeBudget'))
    expect(programs).toEqual([SYSTEM, ATA, SYSTEM, TOKEN, ATA, LIMO_PROGRAM, TOKEN])

    const creates = baseMessage.instructions.filter(
      (ix) => baseMessage.staticAccounts[ix.programAddressIndex] === ATA
    )
    expect(accountsOf(baseMessage, creates[0]!)).toEqual([
      ACCOUNT,
      wrapped,
      ACCOUNT,
      SOL,
      SYSTEM,
      TOKEN,
    ])
    const transfer = baseMessage.instructions[indexOfInstruction(baseMessage, SYSTEM, 2)]!
    expect(accountsOf(baseMessage, transfer)).toEqual([ACCOUNT, wrapped])
    expect([...(transfer.data ?? [])]).toEqual([2, 0, 0, 0, ...u64(BigInt(1000000000))])
    const sync = baseMessage.instructions[indexOfInstruction(baseMessage, TOKEN, 17)]!
    expect(accountsOf(baseMessage, sync)).toEqual([wrapped])
    const closeAccount = baseMessage.instructions[indexOfInstruction(baseMessage, TOKEN, 9)]!
    expect(accountsOf(baseMessage, closeAccount)).toEqual([wrapped, ACCOUNT, ACCOUNT])
  })

  it('makes USDC to SOL with no output account create and no wrap', async () => {
    const built = await buildCreate({
      account: ACCOUNT,
      tokenIn: 'USDC',
      tokenOut: 'SOL',
      amount: '110',
      limitPrice: '100',
      lifetime: LIFETIME,
    })
    const message = open(built.transaction)
    const programs = message.instructions
      .map((ix) => message.staticAccounts[ix.programAddressIndex])
      .filter((p) => !String(p).startsWith('ComputeBudget'))
    expect(programs).toEqual([SYSTEM, LIMO_PROGRAM])
    const order = message.instructions[createOrderIndex(message)]!
    expect([...(order.data ?? [])]).toEqual([
      ...createOrderData(BigInt(110000000), BigInt(1100000000)),
    ])
    expect(accountsOf(message, order)[6]).toBe(associatedTokenAccount(ACCOUNT, USDC))
    expect(accountsOf(message, order)[7]).toBe(inputVault(USDC))
    expect(() =>
      limoAssertSafe({ family: 'solana', transaction: built.transaction }, ACCOUNT, built.context)
    ).not.toThrow()
  })

  it('creates the USDT output account when selling SOL for USDT', async () => {
    const built = await buildCreate({
      account: ACCOUNT,
      tokenIn: 'SOL',
      tokenOut: 'USDT',
      amount: '1',
      limitPrice: '110',
      lifetime: LIFETIME,
    })
    const message = open(built.transaction)
    const creates = message.instructions.filter(
      (ix) => message.staticAccounts[ix.programAddressIndex] === ATA
    )
    expect(creates.map((ix) => accountsOf(message, ix)[3])).toEqual([SOL, USDT])
  })

  it.each([
    ['JitoSOL', 'USDC'],
    ['USDC', 'ONyc'],
    ['USDC', 'USDT'],
    ['SOL', 'SOL'],
  ])(
    'refuses %s to %s, as only SOL, USDC and USDT against a stablecoin are offered',
    async (a, b) => {
      await expect(
        buildCreate({
          account: ACCOUNT,
          tokenIn: a,
          tokenOut: b,
          amount: '1',
          limitPrice: '110',
          lifetime: LIFETIME,
        })
      ).rejects.toThrow(/Nothing was signed or sent\.$/)
    }
  )

  it('signs with an order key the server does not keep, and only that', async () => {
    const { signatures, messageBytes } = getTransactionDecoder().decode(
      Buffer.from(base.transaction, 'base64')
    )
    expect(signatures[ACCOUNT as Address]).toBeNull()
    const signature = signatures[base.order as Address] as SignatureBytes
    const key = await getPublicKeyFromAddress(base.order as Address)
    expect(await verifySignature(key, signature, messageBytes)).toBe(true)
    expect(Object.keys(signatures).sort()).toEqual([ACCOUNT, base.order].sort())
    expect(JSON.stringify(base)).not.toMatch(/private|secret/i)
  })

  it('uses a new order key every time', async () => {
    const again = await buildCreate({
      account: ACCOUNT,
      tokenIn: 'SOL',
      tokenOut: 'USDC',
      amount: '1',
      limitPrice: '110',
      lifetime: LIFETIME,
    })
    expect(again.order).not.toBe(base.order)
  })
})

describe('limoAssertSafe', () => {
  it('passes the payload it built', () => {
    expect(() =>
      limoAssertSafe({ family: 'solana', transaction: base.transaction }, ACCOUNT, base.context)
    ).not.toThrow()
    expect(baseMessage.version).toBe('legacy')
  })

  it('passes the re-sealed payload, so the refusals below come from what each changes', () => {
    expect(() => assertWith(baseMessage)).not.toThrow()
  })

  it('refuses another global config', () => {
    const i = createOrderIndex(baseMessage)
    expect(refusal(() => assertWith(withAccountAt(baseMessage, i, 1, ATTACKER)))).toMatch(
      /global config/
    )
  })

  it('refuses another maker', () => {
    const i = createOrderIndex(baseMessage)
    expect(refusal(() => assertWith(withAccountAt(baseMessage, i, 0, ATTACKER)))).toMatch(/maker/)
  })

  it('refuses another vault', () => {
    const i = createOrderIndex(baseMessage)
    expect(refusal(() => assertWith(withAccountAt(baseMessage, i, 7, ATTACKER)))).toMatch(/vault/)
  })

  it('refuses another pda authority', () => {
    const i = createOrderIndex(baseMessage)
    expect(refusal(() => assertWith(withAccountAt(baseMessage, i, 2, ATTACKER)))).toMatch(
      /authority/
    )
  })

  it.each([
    ['input up by one', BigInt(1000000001), BigInt(110000000)],
    ['input down by one', BigInt(999999999), BigInt(110000000)],
    ['output up by one', BigInt(1000000000), BigInt(110000001)],
    ['output down by one', BigInt(1000000000), BigInt(109999999)],
  ])('refuses %s', (_name, input, output) => {
    const i = createOrderIndex(baseMessage)
    const changed = replaceInstruction(baseMessage, i, { data: createOrderData(input, output) })
    expect(refusal(() => assertWith(changed))).toMatch(/amount/i)
  })

  it('refuses order type 1', () => {
    const i = createOrderIndex(baseMessage)
    const data = createOrderData(BigInt(1000000000), BigInt(110000000))
    data[24] = 1
    expect(refusal(() => assertWith(replaceInstruction(baseMessage, i, { data })))).toMatch(
      /amount|type/i
    )
  })

  it('refuses a system transfer to anyone else', () => {
    const changed = appended(
      baseMessage,
      SYSTEM,
      [ACCOUNT, ATTACKER],
      [2, 0, 0, 0, ...u64(BigInt(1))]
    )
    expect(refusal(() => assertWith(changed))).toMatch(/SOL transfer/)
  })

  it('refuses a second system transfer into the wrapped account', () => {
    const changed = appended(
      baseMessage,
      SYSTEM,
      [ACCOUNT, ownWrappedSolAccount(ACCOUNT)],
      [2, 0, 0, 0, ...u64(BigInt(1))]
    )
    expect(refusal(() => assertWith(changed))).toMatch(/not the limit order/)
  })

  it('refuses wrapping one lamport more than the order takes', () => {
    const i = indexOfInstruction(baseMessage, SYSTEM, 2)
    const changed = replaceInstruction(baseMessage, i, {
      data: Uint8Array.from([2, 0, 0, 0, ...u64(BigInt(1000000001))]),
    })
    expect(refusal(() => assertWith(changed))).toMatch(/not the limit order/)
  })

  it('refuses a close-account destination that is not the maker', () => {
    const i = indexOfInstruction(baseMessage, TOKEN, 9)
    expect(refusal(() => assertWith(withAccountAt(baseMessage, i, 1, ATTACKER)))).toMatch(
      /does not pay you back/
    )
  })

  it('refuses dropping the wrapped account close, which would strand SOL', () => {
    const i = indexOfInstruction(baseMessage, TOKEN, 9)
    const changed = {
      ...baseMessage,
      instructions: baseMessage.instructions.filter((_, index) => index !== i),
    }
    expect(refusal(() => assertWith(changed))).toMatch(/not the limit order/)
  })

  it('refuses update_order', () => {
    const changed = appended(baseMessage, LIMO_PROGRAM, [ACCOUNT, base.order], [...UPDATE_ORDER, 1])
    expect(refusal(() => assertWith(changed))).toMatch(/instruction I didn’t expect/)
  })

  it('refuses initialize_vault, since a missing vault is refused rather than paid for', () => {
    const changed = appended(
      baseMessage,
      LIMO_PROGRAM,
      [ACCOUNT],
      [207, 2, 100, 25, 126, 106, 225, 4]
    )
    expect(refusal(() => assertWith(changed))).toMatch(/instruction I didn’t expect/)
  })

  it('refuses a second extra signer', () => {
    const changed = {
      ...baseMessage,
      header: { ...baseMessage.header, numSignerAccounts: 3 },
    }
    expect(refusal(() => assertWith(changed))).toMatch(/someone other than you/)
  })

  it('refuses a read-only extra signer', () => {
    const changed = {
      ...baseMessage,
      header: { ...baseMessage.header, numReadonlySignerAccounts: 1 },
    }
    expect(refusal(() => assertWith(changed))).toMatch(/someone other than you/)
  })

  it('refuses an extra signer the transaction does not create', () => {
    const i = createAccountIndex(baseMessage)
    const changed = {
      ...baseMessage,
      instructions: baseMessage.instructions.filter((_, index) => index !== i),
    }
    expect(refusal(() => assertWith(changed))).toMatch(/someone other than you/)
  })

  it('refuses creating an account other than the extra signer', () => {
    const i = createAccountIndex(baseMessage)
    expect(refusal(() => assertWith(withAccountAt(baseMessage, i, 1, ATTACKER)))).toMatch(
      /System Program/
    )
  })

  it('refuses another wallet paying for the order account', () => {
    const i = createAccountIndex(baseMessage)
    expect(refusal(() => assertWith(withAccountAt(baseMessage, i, 0, ATTACKER)))).toMatch(
      /System Program/
    )
  })

  it('refuses a create_order on an account other than the one created', () => {
    const i = createOrderIndex(baseMessage)
    expect(refusal(() => assertWith(withAccountAt(baseMessage, i, 3, ATTACKER)))).toMatch(
      /order account/
    )
  })

  it.each([
    ['423 bytes', BigInt(3841920), BigInt(423), LIMO_PROGRAM],
    ['425 bytes', BigInt(3841920), BigInt(425), LIMO_PROGRAM],
    ['another owner', BigInt(3841920), BigInt(424), ATTACKER],
    ['more lamports', BigInt(3841921), BigInt(424), LIMO_PROGRAM],
  ])('refuses an order account of %s', (_name, lamports, space, owner) => {
    const changed = replaceInstruction(baseMessage, createAccountIndex(baseMessage), {
      data: createAccountData(lamports, space, owner),
    })
    expect(refusal(() => assertWith(changed))).toMatch(/System Program/)
  })

  it('refuses a second create of the order account', () => {
    const changed = appended(
      baseMessage,
      SYSTEM,
      [ACCOUNT, base.order],
      [...createAccountData(BigInt(3841920), BigInt(424), LIMO_PROGRAM)]
    )
    expect(refusal(() => assertWith(changed))).toMatch(/someone other than you/)
  })

  it('refuses a payload a person’s wallet would not pay the fee on', () => {
    expect(
      refusal(() =>
        limoAssertSafe({ family: 'solana', transaction: base.transaction }, ATTACKER, base.context)
      )
    ).toMatch(/would not be paid by your wallet/)
  })

  it('refuses a create with nothing saying what was asked for', () => {
    expect(
      refusal(() => limoAssertSafe({ family: 'solana', transaction: base.transaction }, ACCOUNT))
    ).toMatch(/Nothing was signed or sent\.$/)
  })

  it('refuses a mint outside SOL, USDC and USDT, even if the amounts say so', () => {
    expect(
      refusal(() =>
        limoAssertSafe({ family: 'solana', transaction: base.transaction }, ACCOUNT, {
          ...base.context,
          outputMint: JITO_SOL,
        })
      )
    ).toMatch(/Nothing was signed or sent\.$/)
  })

  it('refuses a transaction with no order in it', () => {
    const i = createOrderIndex(baseMessage)
    const changed = {
      ...baseMessage,
      instructions: baseMessage.instructions.filter((_, index) => index !== i),
    }
    expect(refusal(() => assertWith(changed))).toMatch(/Nothing was signed or sent\.$/)
  })

  it('refuses an order signature that is missing', () => {
    const bytes = Buffer.from(base.transaction, 'base64')
    // One count byte, the wallet's empty slot, then the order key's slot.
    bytes.fill(0, 1 + 64, 1 + 64 + 64)
    expect(
      refusal(() =>
        limoAssertSafe(
          { family: 'solana', transaction: bytes.toString('base64') },
          ACCOUNT,
          base.context
        )
      )
    ).toMatch(/signature/)
  })
})

describe('solanaAssertSafe', () => {
  it('still refuses an extra signer for a venue that creates no account', () => {
    const assertSafe = solanaAssertSafe(JUPITER_SWAP_POLICY)
    expect(() => assertSafe({ family: 'solana', transaction: base.transaction }, ACCOUNT)).toThrow(
      /someone other than you/
    )
  })
})

describe('the wallet path', () => {
  it('keeps the order’s signature through signing, and passes the check at submit', async () => {
    const pair = await generateKeyPair()
    const wallet = await getAddressFromPublicKey(pair.publicKey)
    const built = await buildCreate({
      account: wallet,
      tokenIn: 'SOL',
      tokenOut: 'USDC',
      amount: '1',
      limitPrice: '110',
      lifetime: LIFETIME,
    })

    let handed: Uint8Array | undefined
    const fakeWallet = {
      name: 'Fake',
      features: {
        'solana:signTransaction': {
          signTransaction: async ({ transaction }: { transaction: Uint8Array }) => {
            handed = transaction
            const decoded = getTransactionDecoder().decode(transaction)
            const signature = await signBytes(pair.privateKey, decoded.messageBytes)
            const signedTransaction = getTransactionEncoder().encode({
              ...decoded,
              signatures: { ...decoded.signatures, [wallet]: signature },
            })
            return [{ signedTransaction: Uint8Array.from(signedTransaction) }]
          },
        },
      },
    } as unknown as Wallet

    const signed = await signSolana(fakeWallet, { address: wallet } as unknown as WalletAccount, {
      family: 'solana',
      transaction: built.transaction,
    })
    if (signed.family !== 'solana') throw new Error('Expected Solana.')

    // What the wallet was handed is what the server built, already carrying the order's signature.
    expect(Buffer.from(handed as Uint8Array).toString('base64')).toBe(built.transaction)

    const { signatures, messageBytes } = getTransactionDecoder().decode(
      Buffer.from(signed.signedTransaction, 'base64')
    )
    const orderKey = await getPublicKeyFromAddress(built.order as Address)
    expect(
      await verifySignature(
        orderKey,
        signatures[built.order as Address] as SignatureBytes,
        messageBytes
      )
    ).toBe(true)
    expect(
      await verifySignature(pair.publicKey, signatures[wallet] as SignatureBytes, messageBytes)
    ).toBe(true)

    const payload: SigningPayload = { family: 'solana', transaction: signed.signedTransaction }
    expect(() => limoAssertSafe(payload, wallet, built.context)).not.toThrow()
    expect(feePayerSignature(signed.signedTransaction)).toBeTruthy()
    expect(decodeSolanaTransaction(signed.signedTransaction).feePayer).toBe(wallet)
  })

  it('refuses at submit if the wallet dropped the order’s signature', async () => {
    const decoded = getTransactionDecoder().decode(Buffer.from(base.transaction, 'base64'))
    const stripped = getTransactionEncoder().encode({
      ...decoded,
      signatures: { ...decoded.signatures, [base.order]: null },
    })
    const payload: SigningPayload = {
      family: 'solana',
      transaction: Buffer.from(stripped).toString('base64'),
    }
    expect(refusal(() => limoAssertSafe(payload, ACCOUNT, base.context))).toMatch(/signature/)
  })
})

describe('kamino limit venue', () => {
  const venue = createKaminoLimitVenue()

  it('is named, costed and only does limit orders', () => {
    expect(venue.id).toBe('kamino-limit')
    expect(venue.name).toBe('Kamino Limit Orders')
    expect(venue.kinds).toEqual(['limit'])
    expect(venue.limitCost).toEqual({ amount: '0.00684', symbol: 'SOL' })
  })

  it('prepares an order it would pass, with the notes the person reads', async () => {
    stubRpc(liveConfig())
    const prepared = await venue.prepare(SOL_FOR_USDC, ACCOUNT)
    expect(prepared.venueId).toBe('kamino-limit')
    expect(prepared.kind).toBe('limit')
    expect(prepared.pay).toEqual({ amount: '1', symbol: 'SOL' })
    expect(prepared.receive).toEqual({ amount: '110', symbol: 'USDC', approximate: false })
    expect(prepared.summary).toMatch(/1 SOL/)
    expect(prepared.summary).toMatch(/110 USDC/)
    expect(prepared.notes).toEqual([
      'This stays open until it fills or you cancel it. There is no expiry.',
      'Costs about 0.003 SOL, probably not refunded, and locks 0.00384 SOL until you close the order.',
      'Only Pyth Express Relay searchers fill it. It may never fill, and small orders are less likely to.',
      'Kamino can upgrade this program, so your escrowed amount carries that risk.',
    ])
    expect(prepared.context).toMatchObject({ inputAmount: '1000000000', outputAmount: '110000000' })
    expect(() => venue.assertSafe(prepared.signing, ACCOUNT, prepared.context)).not.toThrow()
    expect(decodeSolanaTransaction(solanaTransaction(prepared)).blockhash).toBe(BLOCKHASH)
  })

  it('reads the pinned config and the input mint’s vault', async () => {
    stubRpc(liveConfig())
    await venue.prepare(SOL_FOR_USDC, ACCOUNT)
    const read = calls.find((c) => c.method === 'getMultipleAccounts')
    expect(read?.params[0]).toEqual([LIMO_GLOBAL_CONFIG, inputVault(SOL)])
  })

  it('states a cost other than the usual one, rather than the usual figure', async () => {
    stubRpc(liveConfig(configBytes({ txnFee: 5_000_000, ataCost: 1_000_000 })))
    const prepared = await venue.prepare(SOL_FOR_USDC, ACCOUNT)
    expect(prepared.notes[1]).toMatch(/^Costs about 0\.006 SOL/)
  })

  it.each([
    ['the fee alone', { txnFee: 10_000_001 }],
    ['the fee and account cost together', { txnFee: 9_000_000, ataCost: 1_000_001 }],
  ])('refuses a cost above 0.01 SOL, from %s', async (_name, change) => {
    stubRpc(liveConfig(configBytes(change)))
    await expect(venue.prepare(SOL_FOR_USDC, ACCOUNT)).rejects.toThrow(
      /Nothing was signed or sent\.$/
    )
    expect(calls.map((c) => c.method)).not.toContain('getLatestBlockhash')
  })

  it('takes a cost of exactly 0.01 SOL', async () => {
    stubRpc(liveConfig(configBytes({ txnFee: 10_000_000 })))
    await expect(venue.prepare(SOL_FOR_USDC, ACCOUNT)).resolves.toBeDefined()
  })

  it('refuses when new orders are blocked', async () => {
    stubRpc(liveConfig(configBytes({ newOrdersBlocked: 1 })))
    await expect(venue.prepare(SOL_FOR_USDC, ACCOUNT)).rejects.toThrow(
      /not taking new orders.*Nothing was signed or sent\.$/
    )
  })

  it('refuses in emergency mode', async () => {
    stubRpc(liveConfig(configBytes({ emergency: 1 })))
    await expect(venue.prepare(SOL_FOR_USDC, ACCOUNT)).rejects.toThrow(
      /Nothing was signed or sent\.$/
    )
  })

  it('refuses a mint whose vault does not exist', async () => {
    stubRpc(liveConfig(configBytes(), false))
    await expect(venue.prepare(SOL_FOR_USDC, ACCOUNT)).rejects.toThrow(
      /vault.*Nothing was signed or sent\.$/
    )
  })

  it('refuses a config it can’t read, rather than assume it is fine', async () => {
    stubRpc({
      getMultipleAccounts: {
        context: { slot: 1 },
        value: [liveAccount(Buffer.alloc(10).toString('base64'), LIMO_PROGRAM), null],
      },
    })
    await expect(venue.prepare(SOL_FOR_USDC, ACCOUNT)).rejects.toThrow(
      /Nothing was signed or sent\.$/
    )
  })

  it('refuses a config another program owns', async () => {
    stubRpc({
      getMultipleAccounts: {
        context: { slot: 1 },
        value: [
          liveAccount(configBytes(), ATTACKER),
          liveAccount(Buffer.alloc(165).toString('base64'), TOKEN),
        ],
      },
    })
    await expect(venue.prepare(SOL_FOR_USDC, ACCOUNT)).rejects.toThrow(
      /Nothing was signed or sent\.$/
    )
  })

  it('turns an unreachable network into a refusal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 503 }))
    )
    await expect(venue.prepare(SOL_FOR_USDC, ACCOUNT)).rejects.toThrow(ChainActionRefused)
  })

  it('refuses another pair, kind or malformed account before reading the chain', async () => {
    stubRpc({})
    await expect(venue.prepare({ ...SOL_FOR_USDC, tokenIn: 'JitoSOL' }, ACCOUNT)).rejects.toThrow(
      /Nothing was signed or sent\.$/
    )
    await expect(venue.prepare({ ...SOL_FOR_USDC, kind: 'swap' }, ACCOUNT)).rejects.toThrow(
      /Nothing was signed or sent\.$/
    )
    await expect(venue.prepare(SOL_FOR_USDC, 'not-an-address')).rejects.toThrow(
      /Nothing was signed or sent\.$/
    )
    expect(calls).toEqual([])
  })

  it('refuses more decimal places than the token has, in the same words as any refusal', async () => {
    stubRpc(liveConfig())
    await expect(
      venue.prepare(
        { ...SOL_FOR_USDC, tokenIn: 'USDC', tokenOut: 'SOL', amount: '1.1234567' },
        ACCOUNT
      )
    ).rejects.toThrow(/Nothing was signed or sent\.$/)
  })

  it('runs through the shared route, which holds back the cost and checks the price', async () => {
    stubRpc(liveConfig())
    const chainApi = { ...solanaModule, priceUsd: async () => 100 }
    const prepared = await prepareChainAction(chainApi, SOL_FOR_USDC, ACCOUNT)
    expect(prepared.venueId).toBe('kamino-limit')
    await expect(
      prepareChainAction(chainApi, { ...SOL_FOR_USDC, limitPrice: '90' }, ACCOUNT)
    ).rejects.toThrow(/fill at once/)
  })

  it('answers to "kamino" for a limit, leaving a deposit with the vault venue', async () => {
    stubRpc(liveConfig())
    const chainApi = { ...solanaModule, priceUsd: async () => 100 }
    const prepared = await prepareChainAction(
      chainApi,
      { ...SOL_FOR_USDC, venue: 'kamino' },
      ACCOUNT
    )
    expect(prepared.venueId).toBe('kamino-limit')
  })
})

describe('decodeOrder', () => {
  it('reads a real order account', () => {
    const fixture = FIXTURE()
    expect(fixture.owner).toBe(LIMO_PROGRAM)
    const order = decodeOrder(Buffer.from(fixture.data, 'base64'))
    expect(order).toEqual({
      globalConfig: LIMO_GLOBAL_CONFIG,
      maker: FIXTURE_MAKER,
      inputMint: SOL,
      outputMint: USDC,
      initialInput: BigInt(200000000),
      expectedOutput: BigInt(37268956),
      remainingInput: BigInt(0),
      filledOutput: BigInt(37268956),
      tip: BigInt(24350),
      status: 1,
    })
  })

  it('reads nothing from an account of another size or kind', () => {
    const bytes = Buffer.from(FIXTURE().data, 'base64')
    expect(decodeOrder(bytes.subarray(0, 423))).toBeUndefined()
    const other = Buffer.from(bytes)
    other[0] = 0
    expect(decodeOrder(other)).toBeUndefined()
  })
})

describe('limoBook', () => {
  const book = limoBook()

  function listed(data: string, address = FIXTURE().address, lamports = 3_841_920) {
    return { pubkey: address, account: liveAccount(data, LIMO_PROGRAM, lamports) }
  }

  it('asks only for this account’s orders under the pinned config', async () => {
    stubRpc({ getProgramAccounts: [] })
    await book.openOrders(FIXTURE_MAKER)
    const call = calls[0]
    expect(call?.method).toBe('getProgramAccounts')
    expect(call?.params[0]).toBe(LIMO_PROGRAM)
    const { filters } = call?.params[1] as { filters: unknown[] }
    expect(filters).toEqual([
      { dataSize: 424 },
      { memcmp: { offset: 0, bytes: 'PXZJQQ2HEmx', encoding: 'base58' } },
      { memcmp: { offset: 8, bytes: LIMO_GLOBAL_CONFIG, encoding: 'base58' } },
      { memcmp: { offset: 40, bytes: FIXTURE_MAKER, encoding: 'base58' } },
    ])
  })

  it('shows a filled order, with what closing it brings back', async () => {
    stubRpc({ getProgramAccounts: [listed(FIXTURE().data)] })
    const [order] = await book.openOrders(FIXTURE_MAKER)
    expect(order).toMatchObject({
      id: FIXTURE().address,
      venueId: 'kamino-limit',
      tokenIn: 'SOL',
      tokenOut: 'USDC',
      amountIn: '0.2',
      remainingIn: '0',
      receivedOut: '37.268956',
      status: 'filled',
      limitPrice: '186.345',
    })
    // Rent of 3,841,920 lamports plus the tip of 24,350.
    expect(order?.collectable).toEqual([{ amount: '0.00386627', symbol: 'SOL' }])
    expect(order?.note).toMatch(/SOL/)
  })

  it('tells an open order from a partly filled one, and neither has anything to collect', async () => {
    stubRpc({
      getProgramAccounts: [
        listed(orderLike({ status: 0, remaining: BigInt(200000000), filled: BigInt(0) })),
        listed(orderLike({ status: 0, remaining: BigInt(50000000), filled: BigInt(27951717) })),
      ],
    })
    const orders = await book.openOrders(FIXTURE_MAKER)
    expect(orders.map((o) => o.status)).toEqual(['open', 'partly'])
    expect(orders[1]).toMatchObject({ remainingIn: '0.05', receivedOut: '27.951717' })
    expect(orders.map((o) => o.collectable)).toEqual([undefined, undefined])
  })

  it('reads a cancelled order as done', async () => {
    stubRpc({ getProgramAccounts: [listed(orderLike({ status: 2 }))] })
    expect((await book.openOrders(FIXTURE_MAKER))[0]?.status).toBe('done')
  })

  it('states a buy’s price the same way up as its limit, the stablecoin per token', async () => {
    const bytes = Buffer.from(FIXTURE().data, 'base64')
    Buffer.from(addressBytes(USDC)).copy(bytes, 72)
    Buffer.from(addressBytes(SOL)).copy(bytes, 136)
    bytes.writeBigUInt64LE(BigInt(110000000), 200)
    bytes.writeBigUInt64LE(BigInt(1100000000), 208)
    stubRpc({ getProgramAccounts: [listed(bytes.toString('base64'))] })
    const [order] = await book.openOrders(FIXTURE_MAKER)
    expect(order).toMatchObject({ tokenIn: 'USDC', tokenOut: 'SOL', limitPrice: '100' })
  })

  it('leaves out an order on a token this app does not offer', async () => {
    stubRpc({ getProgramAccounts: [listed(orderLike({ outputMint: JITO_SOL }))] })
    await expect(book.openOrders(FIXTURE_MAKER)).resolves.toEqual([])
  })

  it('refuses a malformed account', async () => {
    stubRpc({})
    await expect(book.openOrders('nope')).rejects.toThrow(ChainActionRefused)
  })

  it('lets an unreadable chain throw, rather than show no orders', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 429 }))
    )
    await expect(book.openOrders(FIXTURE_MAKER)).rejects.toThrow()
  })

  describe('prepareExit', () => {
    const closeAccounts = (prepared: PreparedAction): (string | undefined)[] => {
      const message = open(solanaTransaction(prepared))
      const close = message.instructions[indexOfInstruction(message, LIMO_PROGRAM, CLOSE_ORDER[0]!)]
      return (close?.accountIndices ?? []).map((i) => message.staticAccounts[i])
    }

    it('refuses an order whose maker is not the account', async () => {
      stubRpc(liveOrder(FIXTURE().data))
      await expect(book.prepareExit(ACCOUNT, FIXTURE().address, 'collect')).rejects.toThrow(
        /another wallet.*Nothing was signed or sent\.$/
      )
    })

    it('offers a filled order’s collect, saying the SOL comes back', async () => {
      stubRpc(liveOrder(FIXTURE().data))
      const prepared = await book.prepareExit(FIXTURE_MAKER, FIXTURE().address, 'collect')
      expect(prepared.venueId).toBe('kamino-limit')
      expect(prepared.kind).toBe('limit')
      expect(prepared.summary).toMatch(/SOL/)
      expect(prepared.summary).toMatch(/back/)
      expect(prepared.receive).toEqual({
        amount: '0.00386627',
        symbol: 'SOL',
        approximate: false,
      })
      expect(() => limoAssertSafe(prepared.signing, FIXTURE_MAKER)).not.toThrow()
    })

    it('counts what the account really holds, as a newer order may also hold its fee', async () => {
      stubRpc(liveOrder(FIXTURE().data, 6_841_920))
      const prepared = await book.prepareExit(FIXTURE_MAKER, FIXTURE().address, 'collect')
      expect(prepared.receive?.amount).toBe('0.00686627')
    })

    it('gives close_order its accounts in the program’s order', async () => {
      stubRpc(liveOrder(FIXTURE().data))
      const prepared = await book.prepareExit(FIXTURE_MAKER, FIXTURE().address, 'collect')
      expect(closeAccounts(prepared)).toEqual([
        FIXTURE_MAKER,
        FIXTURE().address,
        LIMO_GLOBAL_CONFIG,
        pdaAuthority(),
        SOL,
        USDC,
        ownWrappedSolAccount(FIXTURE_MAKER),
        inputVault(SOL),
        TOKEN,
        SYSTEM,
        eventAuthority(),
        LIMO_PROGRAM,
      ])
    })

    it('recreates and closes the wrapped account around closing a SOL order', async () => {
      stubRpc(liveOrder(FIXTURE().data))
      const prepared = await book.prepareExit(FIXTURE_MAKER, FIXTURE().address, 'collect')
      const message = open(solanaTransaction(prepared))
      const programs = message.instructions
        .map((ix) => message.staticAccounts[ix.programAddressIndex])
        .filter((p) => !String(p).startsWith('ComputeBudget'))
      expect(programs).toEqual([ATA, LIMO_PROGRAM, TOKEN])
      expect(message.header.numSignerAccounts).toBe(1)
    })

    it('cancels an open order, saying what comes back', async () => {
      stubRpc(liveOrder(orderLike({ status: 0, remaining: BigInt(200000000), filled: BigInt(0) })))
      const prepared = await book.prepareExit(FIXTURE_MAKER, FIXTURE().address, 'cancel')
      expect(prepared.summary).toMatch(/0\.2 SOL/)
      expect(prepared.receive).toEqual({ amount: '0.2', symbol: 'SOL', approximate: false })
      expect(() => limoAssertSafe(prepared.signing, FIXTURE_MAKER)).not.toThrow()
    })

    it('leaves a stablecoin order’s token account in place when cancelling', async () => {
      const bytes = Buffer.from(
        orderLike({ status: 0, remaining: BigInt(100000000), filled: BigInt(0) }),
        'base64'
      )
      Buffer.from(addressBytes(USDC)).copy(bytes, 72)
      Buffer.from(addressBytes(SOL)).copy(bytes, 136)
      stubRpc(liveOrder(bytes.toString('base64')))
      const prepared = await book.prepareExit(FIXTURE_MAKER, FIXTURE().address, 'cancel')
      const message = open(solanaTransaction(prepared))
      const programs = message.instructions
        .map((ix) => message.staticAccounts[ix.programAddressIndex])
        .filter((p) => !String(p).startsWith('ComputeBudget'))
      expect(programs).toEqual([ATA, LIMO_PROGRAM])
      expect(closeAccounts(prepared)[6]).toBe(associatedTokenAccount(FIXTURE_MAKER, USDC))
      expect(prepared.receive).toEqual({ amount: '100', symbol: 'USDC', approximate: false })
      expect(() => limoAssertSafe(prepared.signing, FIXTURE_MAKER)).not.toThrow()
    })

    it('won’t collect an order still open, since closing it would cancel it', async () => {
      stubRpc(liveOrder(orderLike({ status: 0, remaining: BigInt(1), filled: BigInt(1) })))
      await expect(book.prepareExit(FIXTURE_MAKER, FIXTURE().address, 'collect')).rejects.toThrow(
        /still open.*Nothing was signed or sent\.$/
      )
    })

    it('won’t cancel an order that has filled', async () => {
      stubRpc(liveOrder(FIXTURE().data))
      await expect(book.prepareExit(FIXTURE_MAKER, FIXTURE().address, 'cancel')).rejects.toThrow(
        /already filled.*Nothing was signed or sent\.$/
      )
    })

    it('refuses an order that is already cancelled', async () => {
      stubRpc(liveOrder(orderLike({ status: 2 })))
      await expect(book.prepareExit(FIXTURE_MAKER, FIXTURE().address, 'collect')).rejects.toThrow(
        /Nothing was signed or sent\.$/
      )
    })

    it('refuses an order that is gone', async () => {
      stubRpc({ getAccountInfo: { context: { slot: 1 }, value: null } })
      await expect(book.prepareExit(FIXTURE_MAKER, FIXTURE().address, 'cancel')).rejects.toThrow(
        /Nothing was signed or sent\.$/
      )
    })

    it('refuses an account another program owns, whatever it holds', async () => {
      stubRpc({
        getAccountInfo: { context: { slot: 1 }, value: liveAccount(FIXTURE().data, ATTACKER) },
      })
      await expect(book.prepareExit(FIXTURE_MAKER, FIXTURE().address, 'collect')).rejects.toThrow(
        /Nothing was signed or sent\.$/
      )
    })

    it('refuses an order under another global config', async () => {
      const bytes = Buffer.from(FIXTURE().data, 'base64')
      Buffer.from(addressBytes(ATTACKER)).copy(bytes, 8)
      stubRpc(liveOrder(bytes.toString('base64')))
      await expect(book.prepareExit(FIXTURE_MAKER, FIXTURE().address, 'collect')).rejects.toThrow(
        /Nothing was signed or sent\.$/
      )
    })

    it('refuses an order on a token this app does not offer', async () => {
      stubRpc(liveOrder(orderLike({ outputMint: JITO_SOL })))
      await expect(book.prepareExit(FIXTURE_MAKER, FIXTURE().address, 'collect')).rejects.toThrow(
        /Nothing was signed or sent\.$/
      )
    })

    it('refuses an id that is not an address', async () => {
      stubRpc({})
      await expect(book.prepareExit(FIXTURE_MAKER, 'nope', 'cancel')).rejects.toThrow(
        /Nothing was signed or sent\.$/
      )
      expect(calls).toEqual([])
    })
  })
})

describe('limoAssertSafe on an exit', () => {
  async function collect(): Promise<{ message: Message; prepared: PreparedAction }> {
    stubRpc(liveOrder(FIXTURE().data))
    const prepared = await limoBook().prepareExit(FIXTURE_MAKER, FIXTURE().address, 'collect')
    return { prepared, message: open(solanaTransaction(prepared)) }
  }
  const exit = (message: Message): void =>
    limoAssertSafe({ family: 'solana', transaction: close(message) }, FIXTURE_MAKER)
  const position = (message: Message): number =>
    indexOfInstruction(message, LIMO_PROGRAM, CLOSE_ORDER[0]!)

  it.each([
    ['maker', 0],
    ['global config', 2],
    ['authority', 3],
    ['token account', 6],
    ['vault', 7],
  ])('refuses another %s', async (word, at) => {
    const { message } = await collect()
    expect(refusal(() => exit(withAccountAt(message, position(message), at, ATTACKER)))).toMatch(
      new RegExp(word)
    )
  })

  it('refuses a close with an extra transfer', async () => {
    const { message } = await collect()
    const changed = appended(
      message,
      SYSTEM,
      [FIXTURE_MAKER, ATTACKER],
      [2, 0, 0, 0, ...u64(BigInt(1))]
    )
    expect(refusal(() => exit(changed))).toMatch(/SOL transfer/)
  })

  it('refuses two closes in one transaction', async () => {
    const { message } = await collect()
    const close0 = message.instructions[position(message)]!
    const changed = { ...message, instructions: [...message.instructions, close0] }
    expect(refusal(() => exit(changed))).toMatch(/Nothing was signed or sent\.$/)
  })

  it('refuses a close of a mint outside SOL, USDC and USDT', async () => {
    const { message } = await collect()
    expect(refusal(() => exit(withAccountAt(message, position(message), 5, JITO_SOL)))).toMatch(
      /Nothing was signed or sent\.$/
    )
  })

  it('refuses an account creation on an exit', async () => {
    const { message } = await collect()
    const changed = appended(
      message,
      SYSTEM,
      [FIXTURE_MAKER, ATTACKER],
      [...createAccountData(BigInt(3841920), BigInt(424), LIMO_PROGRAM)]
    )
    expect(refusal(() => exit(changed))).toMatch(/System Program/)
  })
})

describe('the app knows about it', () => {
  it('is offered without any configuration', () => {
    expect(buildSolanaVenues({}).map((v) => v.id)).toContain('kamino-limit')
  })

  it('is the chain’s default for a limit, and the book answers', () => {
    expect(solanaModule.defaultVenue.limit).toBe('kamino-limit')
    expect(solanaModule.limitBook).toBeDefined()
  })

  it('is listed on the Apps page as something that runs', () => {
    expect(solanaVenues.find((v) => v.id === 'kamino-limit')).toMatchObject({
      name: 'Kamino Limit Orders',
      integration: 'executes',
    })
  })

  it('is one of the things this chain says it can do', () => {
    expect(solanaCapabilities.map((c) => c.kind)).toContain('limit')
  })
})
