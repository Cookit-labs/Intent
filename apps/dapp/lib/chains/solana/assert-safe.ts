import { createHash } from 'node:crypto'

import {
  getAddressDecoder,
  getAddressEncoder,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getTransactionDecoder,
  isAddress,
  isOffCurveAddress,
  type Address,
} from '@solana/kit'

import { bytesFromBase64 } from '../base64'
import { ChainActionRefused, type SigningPayload } from '../types'

export const SYSTEM_PROGRAM = '11111111111111111111111111111111'
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
export const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111'
const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112'

/**
 * A priority fee is paid in SOL by the fee payer and nothing else caps it, so a
 * hostile API could spend a wallet's SOL through one. Live routes on 3 November
 * 2026 paid up to about 40,000 lamports. This leaves room for congestion at about
 * 0.005 SOL.
 */
const MAX_PRIORITY_FEE_LAMPORTS = BigInt(5_000_000)
/** What the network charges compute for when a transaction sets no limit of its own. */
const DEFAULT_COMPUTE_UNIT_LIMIT = BigInt(1_400_000)

export interface SolanaVenuePolicy {
  venueName: string
  /** Program id to the discriminators it may be called with. None listed means any. */
  programs: Readonly<Record<string, { discriminators?: readonly string[] }>>
  /** Whether wrapping SOL (a transfer to the account's own wrapped SOL account) is expected. */
  mayWrapSol: boolean
  /**
   * The one extra signer a venue may ask for: a brand new account this same transaction creates,
   * paid for by the wallet, at exactly this size and rent, and owned by this program.
   */
  createsSigner?: { owner: string; space: bigint; lamports: bigint }
}

interface DecodedInstruction {
  programIndex: number
  accounts: readonly number[]
  data: Uint8Array
}

export interface DecodedSolanaTransaction {
  feePayer: string
  /** The fee payer's signature bytes, or null while unsigned. */
  feePayerSignature: Uint8Array | null
  blockhash: string
  signerCount: number
  readonlySignerCount: number
  staticAccounts: readonly string[]
  instructions: readonly DecodedInstruction[]
}

function refuse(sentence: string): never {
  throw new ChainActionRefused(
    `${sentence} I refused it, so nothing was signed or sent. Try again, or use another venue if it keeps happening.`
  )
}

export function decodeSolanaTransaction(base64: string): DecodedSolanaTransaction {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) refuse('That transaction could not be read.')
  let decoded: DecodedSolanaTransaction | undefined
  try {
    const bytes = bytesFromBase64(base64)
    const transaction = getTransactionDecoder().decode(bytes)
    const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes)
    // Anything after the message would be bytes a wallet shows nobody. The decoder keeps
    // them as message bytes and ignores them, so re-encoding is what reveals them.
    const encoded = getCompiledTransactionMessageEncoder().encode(message)
    const exact =
      encoded.length === transaction.messageBytes.length &&
      encoded.every((byte, index) => byte === transaction.messageBytes[index])
    if (exact && (message.version === 'legacy' || message.version === 0)) {
      const feePayer = message.staticAccounts[0] as string
      decoded = {
        feePayer,
        feePayerSignature: transaction.signatures[feePayer as Address] ?? null,
        blockhash: message.lifetimeToken,
        signerCount: message.header.numSignerAccounts,
        readonlySignerCount: message.header.numReadonlySignerAccounts,
        staticAccounts: message.staticAccounts,
        instructions: message.instructions.map((instruction) => ({
          programIndex: instruction.programAddressIndex,
          accounts: instruction.accountIndices ?? [],
          data: Uint8Array.from(instruction.data ?? []),
        })),
      }
    }
  } catch {
    refuse('That transaction could not be read.')
  }
  return decoded ?? refuse('That transaction is in a form I can’t check.')
}

/**
 * A program's derived address. Written out rather than taken from the kit's async
 * derivation because `assertSafe` is synchronous by contract.
 */
export function programAddress(seeds: readonly Uint8Array[], program: string): string {
  const decoder = getAddressDecoder()
  const programBytes = Uint8Array.from(getAddressEncoder().encode(program as Address))
  for (let bump = 255; bump >= 0; bump -= 1) {
    const hash = createHash('sha256')
    for (const seed of seeds) hash.update(seed)
    hash.update(Uint8Array.of(bump))
    hash.update(programBytes)
    hash.update('ProgramDerivedAddress')
    const candidate = decoder.decode(hash.digest())
    if (isOffCurveAddress(candidate)) return candidate
  }
  throw new Error('No program address for these seeds.')
}

/** The owner's token account for a mint. */
export function associatedTokenAccount(owner: string, mint: string): string {
  const encoder = getAddressEncoder()
  return programAddress(
    [owner, TOKEN_PROGRAM, mint].map((part) => Uint8Array.from(encoder.encode(part as Address))),
    ASSOCIATED_TOKEN_PROGRAM
  )
}

export function ownWrappedSolAccount(owner: string): string {
  return associatedTokenAccount(owner, WRAPPED_SOL_MINT)
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function readLittleEndian(data: Uint8Array, offset: number, length: number): bigint {
  let value = BigInt(0)
  for (let i = length - 1; i >= 0; i -= 1) {
    value = (value << BigInt(8)) | BigInt(data[offset + i] ?? 0)
  }
  return value
}

/** The address at an account position, or nothing if it sits in a lookup table. */
function staticAccount(
  transaction: DecodedSolanaTransaction,
  instruction: DecodedInstruction,
  position: number
): string | undefined {
  const index = instruction.accounts[position]
  return index === undefined ? undefined : transaction.staticAccounts[index]
}

function checkComputeBudget(instructions: readonly DecodedInstruction[]): void {
  let price = BigInt(0)
  let limit = DEFAULT_COMPUTE_UNIT_LIMIT
  for (const { data } of instructions) {
    const tag = data[0]
    if (tag === 2 && data.length === 5) limit = readLittleEndian(data, 1, 4)
    else if (tag === 3 && data.length === 9) price = readLittleEndian(data, 1, 8)
    else if (!(tag === 4 && data.length === 5)) {
      refuse('This transaction sets a compute budget option I don’t recognise.')
    }
  }
  if ((price * limit) / BigInt(1_000_000) > MAX_PRIORITY_FEE_LAMPORTS) {
    refuse('This transaction would pay an unusually large priority fee from your SOL.')
  }
}

/** Whether this is the policy's one permitted account creation, paid for by the wallet. */
function createsExtraSigner(
  transaction: DecodedSolanaTransaction,
  instruction: DecodedInstruction,
  account: string,
  policy: SolanaVenuePolicy,
  extraSigner: string | undefined
): boolean {
  const { data } = instruction
  const allowed = policy.createsSigner
  return (
    allowed !== undefined &&
    extraSigner !== undefined &&
    data.length === 52 &&
    readLittleEndian(data, 0, 4) === BigInt(0) &&
    instruction.accounts.length === 2 &&
    staticAccount(transaction, instruction, 0) === account &&
    staticAccount(transaction, instruction, 1) === extraSigner &&
    readLittleEndian(data, 4, 8) === allowed.lamports &&
    readLittleEndian(data, 12, 8) === allowed.space &&
    getAddressDecoder().decode(data.subarray(20)) === allowed.owner
  )
}

function checkSystem(
  transaction: DecodedSolanaTransaction,
  instruction: DecodedInstruction,
  account: string,
  policy: SolanaVenuePolicy
): void {
  const { data } = instruction
  const isTransfer = data.length === 12 && readLittleEndian(data, 0, 4) === BigInt(2)
  if (!isTransfer) refuse('This transaction asks the System Program to do something unexpected.')
  const from = staticAccount(transaction, instruction, 0)
  const to = staticAccount(transaction, instruction, 1)
  if (!policy.mayWrapSol || from !== account || to !== ownWrappedSolAccount(account)) {
    refuse('This transaction includes a SOL transfer that does not stay in your own account.')
  }
}

function checkToken(
  transaction: DecodedSolanaTransaction,
  instruction: DecodedInstruction,
  account: string,
  policy: SolanaVenuePolicy
): void {
  const { data } = instruction
  const tag = data.length === 1 ? data[0] : undefined
  const own = policy.mayWrapSol ? ownWrappedSolAccount(account) : undefined
  const target = staticAccount(transaction, instruction, 0)
  if (tag === 17) {
    if (own === undefined || target !== own) {
      refuse('This transaction touches a token account it should not.')
    }
    return
  }
  if (tag === 9) {
    const destination = staticAccount(transaction, instruction, 1)
    const owner = staticAccount(transaction, instruction, 2)
    if (own === undefined || target !== own || destination !== account || owner !== account) {
      refuse('This transaction would close a token account in a way that does not pay you back.')
    }
    return
  }
  refuse('This transaction moves tokens outside the venue you asked for.')
}

function checkAssociatedToken(
  transaction: DecodedSolanaTransaction,
  instruction: DecodedInstruction,
  account: string
): void {
  const { data } = instruction
  const createsAccount =
    data.length === 0 || (data.length === 1 && (data[0] === 0 || data[0] === 1))
  if (!createsAccount) refuse('This transaction does something unexpected with token accounts.')
  const payer = staticAccount(transaction, instruction, 0)
  const owner = staticAccount(transaction, instruction, 2)
  if (payer !== account || owner !== account) {
    refuse('This transaction creates a token account that is not yours.')
  }
}

/**
 * Checks what a transaction does at its top level.
 *
 * What this cannot see: what an allowed program does inside, and any account
 * behind a lookup table, because resolving one needs the network and `assertSafe`
 * is synchronous. So a transfer's source and destination must be plain addresses,
 * and how much a route returns rests on the venue's program and the slippage bound.
 */
export function solanaAssertSafe(policy: SolanaVenuePolicy) {
  return (payload: SigningPayload, account: string): void => {
    if (payload.family !== 'solana') return refuse('That is not a Solana transaction.')
    if (!isAddress(account)) refuse('That is not a Solana wallet address.')

    const transaction = decodeSolanaTransaction(payload.transaction)
    if (transaction.feePayer !== account) {
      refuse(`This transaction’s network fee would not be paid by your wallet, ${account}.`)
    }
    const mayHaveExtra = policy.createsSigner !== undefined && transaction.signerCount === 2
    if ((transaction.signerCount !== 1 && !mayHaveExtra) || transaction.readonlySignerCount !== 0) {
      refuse('This transaction needs a signature from someone other than you.')
    }
    const extraSigner = mayHaveExtra ? transaction.staticAccounts[1] : undefined
    let created = 0

    const budget: DecodedInstruction[] = []
    for (const instruction of transaction.instructions) {
      const program = transaction.staticAccounts[instruction.programIndex]
      if (program === undefined) {
        refuse('This transaction calls a program hidden in a lookup table.')
      }
      if (program === COMPUTE_BUDGET_PROGRAM) budget.push(instruction)
      else if (
        program === SYSTEM_PROGRAM &&
        createsExtraSigner(transaction, instruction, account, policy, extraSigner)
      ) {
        created += 1
      } else if (program === SYSTEM_PROGRAM) {
        checkSystem(transaction, instruction, account, policy)
      } else if (program === TOKEN_PROGRAM) checkToken(transaction, instruction, account, policy)
      else if (program === ASSOCIATED_TOKEN_PROGRAM) {
        checkAssociatedToken(transaction, instruction, account)
      } else {
        const rule = policy.programs[program as string]
        if (rule === undefined) {
          refuse(`This transaction calls a program ${policy.venueName} should not need.`)
        } else if (
          rule.discriminators !== undefined &&
          !rule.discriminators.includes(hex(instruction.data.subarray(0, 8)))
        ) {
          refuse(`This transaction asks ${policy.venueName} for an instruction I didn’t expect.`)
        }
      }
    }
    if (mayHaveExtra && created !== 1) {
      refuse('This transaction needs a signature from someone other than you.')
    }
    checkComputeBudget(budget)
  }
}

/**
 * Binds a deposit to the amount asked for. The first eight bytes of the instruction
 * are its discriminator and the next eight the amount in base units.
 */
export function assertDepositAmount(base64: string, program: string, baseUnits: string): void {
  const transaction = decodeSolanaTransaction(base64)
  const deposits = transaction.instructions.filter(
    (instruction) => transaction.staticAccounts[instruction.programIndex] === program
  )
  const [deposit] = deposits
  if (deposits.length !== 1 || deposit === undefined || deposit.data.length !== 16) {
    refuse('This transaction is not the single deposit you asked for.')
  } else if (readLittleEndian(deposit.data, 8, 8) !== BigInt(baseUnits)) {
    refuse('This deposit’s amount is not the amount you asked for.')
  }
}

/** Bounds SOL moved into the wrapped account by a swap to what the swap spends. */
export function assertWrapAtMost(base64: string, lamports: bigint): void {
  const transaction = decodeSolanaTransaction(base64)
  let wrapped = BigInt(0)
  for (const instruction of transaction.instructions) {
    if (transaction.staticAccounts[instruction.programIndex] === SYSTEM_PROGRAM) {
      wrapped += readLittleEndian(instruction.data, 4, 8)
    }
  }
  if (wrapped > lamports) refuse('This swap would wrap more SOL than you asked to spend.')
}
