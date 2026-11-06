import { createHash } from 'node:crypto'

import {
  AccountRole,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getAddressDecoder,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  getU32Encoder,
  getU64Encoder,
  isAddress,
  isBlockhash,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
  type Instruction,
} from '@solana/kit'
import { z } from 'zod'

import { bytesFromBase64 } from '../base64'
import { ChainActionRefused, type SigningPayload, type VenuePosition } from '../types'
import {
  ASSOCIATED_TOKEN_PROGRAM,
  associatedTokenAccount,
  decodeSolanaTransaction,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
} from './assert-safe'
import { fromBaseUnits } from './tokens'

/**
 * What the staking venues share: reading the chain, the SPL stake pool's instructions, and a check
 * that a transaction is exactly one of the shapes a venue builds.
 *
 * `solanaAssertSafe` can't express these. Its discriminators are eight bytes and the stake pool's
 * are one, so it could only allow every pool instruction, and it refuses the account creation a
 * stake account needs. It also doesn't look at who an instruction's accounts belong to, which is
 * what decides where unstaked SOL lands.
 */

/**
 * https://github.com/solana-program/stake-pool, `program/src/lib.rs` `declare_id!`. Seen on chain
 * as an executable upgradeable program owning both Jito's and Solayer's pools on 5 November 2026.
 */
export const STAKE_POOL_PROGRAM = 'SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy'
export const STAKE_PROGRAM = 'Stake11111111111111111111111111111111111111'
const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111'
export const CLOCK_SYSVAR = 'SysvarC1ock11111111111111111111111111111111'
export const STAKE_HISTORY_SYSVAR = 'SysvarStakeHistory1111111111111111111111111'

const DEFAULT_RPC_URL = 'https://solana-rpc.publicnode.com'
const RPC_TIMEOUT_MS = 15_000

/** Enough to land without a live fee estimate: under 0.0001 SOL at the limits used here. */
const COMPUTE_UNIT_PRICE = BigInt(100_000)
/** The ceiling `solanaAssertSafe` holds every other venue to, about 0.005 SOL. */
const MAX_PRIORITY_FEE_LAMPORTS = BigInt(5_000_000)
/** Rent for a stake account is about 0.0017 SOL today. It stays the person's, and this bounds it. */
const MAX_STAKE_ACCOUNT_LAMPORTS = BigInt(5_000_000)
const STAKE_ACCOUNT_SPACE = BigInt(200)
/** How far a stake-pool rate may move before the transaction lands. The rule's ceiling is 1%. */
const SLIPPAGE_DIVISOR = BigInt(1000)

const DEPOSIT_SOL_WITH_SLIPPAGE = 25
const WITHDRAW_SOL_WITH_SLIPPAGE = 26
const WITHDRAW_STAKE_WITH_SLIPPAGE = 24
const CREATE_ACCOUNT_WITH_SEED = 3
const STAKE_DEACTIVATE = 5
const CREATE_IDEMPOTENT = 1

const VALIDATOR_ENTRY_BYTES = 73
const VALIDATOR_LIST_HEADER_BYTES = 9
const VALIDATOR_ACTIVE = 0

/**
 * How many stake accounts one wallet can have waiting. Each lives at an address worked out from the
 * wallet and its slot, so finding them takes plain account reads and no account index. publicnode,
 * the default here, refused `getProgramAccounts` on 5 November 2026, so a search by owner can't be
 * what an exit rests on. Each holds at least 1 SOL and is claimable in about two days, so this is
 * ample, and an unstake with none free refuses rather than make an account nothing could find.
 */
export const STAKE_EXIT_SLOTS = 20
/** publicnode's limit for one `getMultipleAccounts`, seen on 5 November 2026. Others allow 100. */
const ACCOUNTS_PER_READ = 10

export type SolanaRpc = (method: string, params: unknown[]) => Promise<unknown>

export function unreadable(): never {
  throw new ChainActionRefused(
    'Solana’s network could not be read just now. Nothing was signed or sent, so try again in a moment.'
  )
}

/** Reads only: this never sends anything. A failed read refuses, so nothing is built on a guess. */
export function readOnlyRpc(env: Record<string, string | undefined> = process.env): SolanaRpc {
  return async (method, params) => {
    const url = env['SOLANA_RPC_URL']?.trim() || DEFAULT_RPC_URL
    let body: { result?: unknown; error?: unknown }
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      })
      if (!response.ok) return unreadable()
      body = (await response.json()) as { result?: unknown; error?: unknown }
    } catch (e) {
      if (e instanceof ChainActionRefused) throw e
      return unreadable()
    }
    if (body.error !== undefined || body.result === undefined) return unreadable()
    return body.result
  }
}

const AccountValue = z.object({
  owner: z.string(),
  lamports: z.number().int().nonnegative(),
  data: z.tuple([z.string(), z.literal('base64')]),
})

const AccountReply = z.object({ value: AccountValue.nullable() })
const AccountsReply = z.object({ value: z.array(AccountValue.nullable()) })

export interface ChainAccount {
  owner: string
  lamports: bigint
  data: Uint8Array
}

function chainAccount({ owner, lamports, data }: z.infer<typeof AccountValue>): ChainAccount {
  return { owner, lamports: BigInt(lamports), data: bytesFromBase64(data[0]) }
}

export async function readAccount(rpc: SolanaRpc, address: string): Promise<ChainAccount> {
  const reply = AccountReply.safeParse(
    await rpc('getAccountInfo', [address, { encoding: 'base64', commitment: 'confirmed' }])
  )
  if (!reply.success || reply.data.value === null) return unreadable()
  return chainAccount(reply.data.value)
}

/** Several accounts in one read. Nothing at an address comes back as undefined, and isn't a failure. */
export async function readAccounts(
  rpc: SolanaRpc,
  addresses: readonly string[]
): Promise<(ChainAccount | undefined)[]> {
  const batches: (readonly string[])[] = []
  for (let at = 0; at < addresses.length; at += ACCOUNTS_PER_READ) {
    batches.push(addresses.slice(at, at + ACCOUNTS_PER_READ))
  }
  const read = await Promise.all(
    batches.map(async (batch) => {
      const reply = AccountsReply.safeParse(
        await rpc('getMultipleAccounts', [batch, { encoding: 'base64', commitment: 'confirmed' }])
      )
      if (!reply.success || reply.data.value.length !== batch.length) return unreadable()
      return reply.data.value.map((value) => (value === null ? undefined : chainAccount(value)))
    })
  )
  return read.flat()
}

/** A staking token in the wallet's own account, which is the only one an unstake here spends. */
export async function stakedPositions(
  rpc: SolanaRpc,
  account: string,
  mint: string,
  symbol: string,
  decimals: number
): Promise<VenuePosition[]> {
  if (!isAddress(account)) throw new ChainActionRefused('That is not a Solana wallet address.')
  const [own] = await readAccounts(rpc, [associatedTokenAccount(account, mint)])
  if (own === undefined) return []
  if (
    own.owner !== TOKEN_PROGRAM ||
    own.data.length < 72 ||
    readAddress(own.data, 0) !== mint ||
    readAddress(own.data, 32) !== account
  ) {
    return unreadable()
  }
  const units = readU64(own.data, 64)
  return units === BigInt(0)
    ? []
    : [{ slot: 'staked', symbol, amount: fromBaseUnits(units.toString(), decimals) }]
}

const EpochReply = z.object({ epoch: z.number().int().nonnegative() })

async function readEpoch(rpc: SolanaRpc): Promise<bigint> {
  const reply = EpochReply.safeParse(await rpc('getEpochInfo', [{ commitment: 'confirmed' }]))
  return reply.success ? BigInt(reply.data.epoch) : unreadable()
}

const BlockhashReply = z.object({
  value: z.object({
    blockhash: z.string().refine(isBlockhash),
    lastValidBlockHeight: z.number().int().nonnegative(),
  }),
})

const RentReply = z.number().int().positive()

export async function readStakeAccountRent(rpc: SolanaRpc): Promise<bigint> {
  const reply = RentReply.safeParse(
    await rpc('getMinimumBalanceForRentExemption', [Number(STAKE_ACCOUNT_SPACE)])
  )
  return reply.success ? BigInt(reply.data) : unreadable()
}

const MinimumDelegationReply = z.object({ value: z.number().int().nonnegative() })

/** The least a stake account may hold delegated, so the least that can split off a pool's stake. */
export async function readMinimumDelegation(rpc: SolanaRpc): Promise<bigint> {
  const reply = MinimumDelegationReply.safeParse(
    await rpc('getStakeMinimumDelegation', [{ commitment: 'confirmed' }])
  )
  return reply.success ? BigInt(reply.data.value) : unreadable()
}

export function readU64(data: Uint8Array, offset: number): bigint {
  let value = BigInt(0)
  for (let i = 7; i >= 0; i -= 1) {
    value = (value << BigInt(8)) | BigInt(data[offset + i] ?? 0)
  }
  return value
}

export function readU32(data: Uint8Array, offset: number): number {
  return Number(readU64(Uint8Array.from([...data.subarray(offset, offset + 4), 0, 0, 0, 0]), 0))
}

export function readAddress(data: Uint8Array, offset: number): string {
  return getAddressDecoder().decode(data.subarray(offset, offset + 32))
}

export interface PoolFee {
  numerator: bigint
  denominator: bigint
}

export interface StakePoolState {
  manager: string
  validatorList: string
  reserveStake: string
  poolMint: string
  managerFeeAccount: string
  tokenProgram: string
  totalLamports: bigint
  poolTokenSupply: bigint
  lastUpdateEpoch: bigint
  epochFee: PoolFee
  preferredWithdrawValidator: string | undefined
  stakeWithdrawalFee: PoolFee
  solDepositAuthority: string | undefined
  solDepositFee: PoolFee
  solWithdrawAuthority: string | undefined
  solWithdrawalFee: PoolFee
}

/** The SPL stake pool's account, in its Borsh layout: `program/src/state.rs` `StakePool`. */
export function decodeStakePool(data: Uint8Array): StakePoolState | undefined {
  let at = 0
  const take = (length: number): number => {
    const start = at
    at += length
    return start
  }
  const u64 = (): bigint => readU64(data, take(8))
  const pubkey = (): string => readAddress(data, take(32))
  const fee = (): PoolFee => {
    const denominator = u64()
    return { denominator, numerator: u64() }
  }
  const futureFee = (): void => {
    const tag = data[take(1)]
    if (tag === 1 || tag === 2) fee()
  }
  const optional = (): string | undefined => (data[take(1)] === 0 ? undefined : pubkey())

  if (data[take(1)] !== 1) return undefined
  try {
    const manager = pubkey()
    take(32 + 32 + 1) // staker, stake deposit authority, withdraw bump
    const validatorList = pubkey()
    const reserveStake = pubkey()
    const poolMint = pubkey()
    const managerFeeAccount = pubkey()
    const tokenProgram = pubkey()
    const totalLamports = u64()
    const poolTokenSupply = u64()
    const lastUpdateEpoch = u64()
    take(8 + 8 + 32) // lockup
    const epochFee = fee()
    futureFee()
    optional() // preferred deposit validator
    const preferredWithdrawValidator = optional()
    fee() // stake deposit fee
    const stakeWithdrawalFee = fee()
    futureFee()
    take(1) // stake referral fee
    const solDepositAuthority = optional()
    const solDepositFee = fee()
    take(1) // sol referral fee
    const solWithdrawAuthority = optional()
    const solWithdrawalFee = fee()
    if (at > data.length) return undefined
    return {
      manager,
      validatorList,
      reserveStake,
      poolMint,
      managerFeeAccount,
      tokenProgram,
      totalLamports,
      poolTokenSupply,
      lastUpdateEpoch,
      epochFee,
      preferredWithdrawValidator,
      stakeWithdrawalFee,
      solDepositAuthority,
      solDepositFee,
      solWithdrawAuthority,
      solWithdrawalFee,
    }
  } catch {
    return undefined
  }
}

/**
 * The pool as it stands now, refused unless it is the pool and mint this venue pins and has been
 * updated this epoch. A pool behind the epoch rejects deposits and withdrawals until it catches up.
 */
export async function readStakePool(
  rpc: SolanaRpc,
  venueName: string,
  pool: string,
  mint: string
): Promise<StakePoolState> {
  const [account, epoch] = await Promise.all([readAccount(rpc, pool), readEpoch(rpc)])
  const state = account.owner === STAKE_POOL_PROGRAM ? decodeStakePool(account.data) : undefined
  if (
    state === undefined ||
    state.poolMint !== mint ||
    state.tokenProgram !== TOKEN_PROGRAM ||
    state.poolTokenSupply === BigInt(0) ||
    state.totalLamports === BigInt(0)
  ) {
    throw new ChainActionRefused(
      `${venueName}’s stake pool doesn’t look as expected on chain, so I stopped. Nothing was signed or sent.`
    )
  }
  if (state.lastUpdateEpoch !== epoch) {
    throw new ChainActionRefused(
      `${venueName}’s stake pool is still updating for the new Solana epoch. Nothing was signed or sent, so try again in a few minutes.`
    )
  }
  return state
}

/** Rounds up, as the program does: `Fee::apply` in `program/src/state.rs`. */
function applyFee(fee: PoolFee, amount: bigint): bigint {
  if (fee.denominator === BigInt(0)) return BigInt(0)
  return (amount * fee.numerator + fee.denominator - BigInt(1)) / fee.denominator
}

/** Pool tokens a SOL deposit mints to the depositor at the rate read. */
export function poolTokensForDeposit(state: StakePoolState, lamports: bigint): bigint {
  const minted = (lamports * state.poolTokenSupply) / state.totalLamports
  return minted - applyFee(state.solDepositFee, minted)
}

/** SOL that burning pool tokens is worth after the given withdrawal fee, at the rate read. */
export function lamportsForWithdrawal(
  state: StakePoolState,
  poolTokens: bigint,
  fee: PoolFee
): bigint {
  const burned = poolTokens - applyFee(fee, poolTokens)
  return (burned * state.totalLamports) / state.poolTokenSupply
}

export function withSlippage(amount: bigint): bigint {
  return amount - amount / SLIPPAGE_DIVISOR
}

/** SOL per pool token, to six places, for telling a person the rate read on chain. */
export function rateText(lamports: bigint, tokens: bigint): string {
  const scaled = (lamports * BigInt(1_000_000)) / tokens
  const whole = scaled / BigInt(1_000_000)
  const fraction = (scaled % BigInt(1_000_000)).toString().padStart(6, '0').replace(/0+$/, '')
  return fraction === '' ? whole.toString() : `${whole}.${fraction}`
}

export function feePercentText(fee: PoolFee): string {
  if (fee.denominator === BigInt(0)) return '0%'
  return `${Number((fee.numerator * BigInt(1_000_000)) / fee.denominator) / 10_000}%`
}

export interface PoolValidator {
  vote: string
  seedSuffix: number
  activeLamports: bigint
}

export function decodeValidatorList(data: Uint8Array): PoolValidator[] | undefined {
  if (data[0] !== 2 || data.length < VALIDATOR_LIST_HEADER_BYTES) return undefined
  const count = readU32(data, 5)
  if (VALIDATOR_LIST_HEADER_BYTES + count * VALIDATOR_ENTRY_BYTES > data.length) return undefined
  const validators: PoolValidator[] = []
  for (let i = 0; i < count; i += 1) {
    const at = VALIDATOR_LIST_HEADER_BYTES + i * VALIDATOR_ENTRY_BYTES
    if (data[at + 40] !== VALIDATOR_ACTIVE) continue
    validators.push({
      activeLamports: readU64(data, at),
      seedSuffix: readU32(data, at + 36),
      vote: readAddress(data, at + 41),
    })
  }
  return validators
}

async function poolProgramAddress(seeds: (string | Uint8Array)[]): Promise<string> {
  const [address] = await getProgramDerivedAddress({
    programAddress: STAKE_POOL_PROGRAM as Address,
    seeds,
  })
  return address
}

function addressBytes(address: string): Uint8Array {
  return Uint8Array.from(getAddressEncoder().encode(address as Address))
}

export function poolWithdrawAuthority(pool: string): Promise<string> {
  return poolProgramAddress([addressBytes(pool), 'withdraw'])
}

export function validatorStakeAccount(pool: string, validator: PoolValidator): Promise<string> {
  const seeds: (string | Uint8Array)[] = [addressBytes(validator.vote), addressBytes(pool)]
  if (validator.seedSuffix !== 0) {
    seeds.push(Uint8Array.from(getU32Encoder().encode(validator.seedSuffix)))
  }
  return poolProgramAddress(seeds)
}

/** The address `create_account_with_seed` makes: a hash of base, seed and owning program. */
export function addressWithSeed(base: string, seed: string, owner: string): string {
  const hash = createHash('sha256')
  hash.update(addressBytes(base))
  hash.update(seed)
  hash.update(addressBytes(owner))
  return getAddressDecoder().decode(hash.digest())
}

export const stakeExitSeed = (slot: number): string => `intent-stake-${slot}`

export const stakeExitAddress = (account: string, slot: number): string =>
  addressWithSeed(account, stakeExitSeed(slot), STAKE_PROGRAM)

export const stakeExitAddresses = (account: string): string[] =>
  Array.from({ length: STAKE_EXIT_SLOTS }, (_, slot) => stakeExitAddress(account, slot))

const STAKE_EXIT_SEEDS: ReadonlySet<string> = new Set(
  Array.from({ length: STAKE_EXIT_SLOTS }, (_, slot) => stakeExitSeed(slot))
)

const readonly = (address: string): { address: Address; role: AccountRole } => ({
  address: address as Address,
  role: AccountRole.READONLY,
})
const writable = (address: string): { address: Address; role: AccountRole } => ({
  address: address as Address,
  role: AccountRole.WRITABLE,
})
const signer = (address: string): { address: Address; role: AccountRole } => ({
  address: address as Address,
  role: AccountRole.WRITABLE_SIGNER,
})

export const accountRoles = { readonly, writable, signer }

const u64Bytes = (value: bigint): number[] => [...getU64Encoder().encode(value)]

/** An Anchor instruction whose only argument is an amount: an eight-byte discriminator, then a u64. */
export function anchorAmountData(discriminator: string, amount: bigint): Uint8Array {
  const prefix = Array.from({ length: 8 }, (_, i) =>
    Number.parseInt(discriminator.slice(i * 2, i * 2 + 2), 16)
  )
  return Uint8Array.from([...prefix, ...u64Bytes(amount)])
}

export function computeBudget(units: number): Instruction[] {
  return [
    {
      programAddress: COMPUTE_BUDGET_PROGRAM as Address,
      data: Uint8Array.from([2, ...getU32Encoder().encode(units)]),
    },
    {
      programAddress: COMPUTE_BUDGET_PROGRAM as Address,
      data: Uint8Array.from([3, ...u64Bytes(COMPUTE_UNIT_PRICE)]),
    },
  ]
}

export function createTokenAccount(account: string, mint: string): Instruction {
  return {
    programAddress: ASSOCIATED_TOKEN_PROGRAM as Address,
    accounts: [
      signer(account),
      writable(associatedTokenAccount(account, mint)),
      readonly(account),
      readonly(mint),
      readonly(SYSTEM_PROGRAM),
      readonly(TOKEN_PROGRAM),
    ],
    data: Uint8Array.of(CREATE_IDEMPOTENT),
  }
}

export interface PoolInstructionBase {
  pool: string
  state: StakePoolState
  withdrawAuthority: string
  account: string
}

/** The person is their own referrer, so a referral fee, if the pool ever sets one, stays theirs. */
export function depositSol(
  base: PoolInstructionBase & { lamports: bigint; minimumPoolTokens: bigint }
): Instruction {
  const { pool, state, withdrawAuthority, account, lamports, minimumPoolTokens } = base
  const own = associatedTokenAccount(account, state.poolMint)
  return {
    programAddress: STAKE_POOL_PROGRAM as Address,
    accounts: [
      writable(pool),
      readonly(withdrawAuthority),
      writable(state.reserveStake),
      signer(account),
      writable(own),
      writable(state.managerFeeAccount),
      writable(own),
      writable(state.poolMint),
      readonly(SYSTEM_PROGRAM),
      readonly(TOKEN_PROGRAM),
    ],
    data: Uint8Array.from([
      DEPOSIT_SOL_WITH_SLIPPAGE,
      ...u64Bytes(lamports),
      ...u64Bytes(minimumPoolTokens),
    ]),
  }
}

export function withdrawSol(
  base: PoolInstructionBase & { poolTokens: bigint; minimumLamports: bigint }
): Instruction {
  const { pool, state, withdrawAuthority, account, poolTokens, minimumLamports } = base
  return {
    programAddress: STAKE_POOL_PROGRAM as Address,
    accounts: [
      writable(pool),
      readonly(withdrawAuthority),
      signer(account),
      writable(associatedTokenAccount(account, state.poolMint)),
      writable(state.reserveStake),
      writable(account),
      writable(state.managerFeeAccount),
      writable(state.poolMint),
      readonly(CLOCK_SYSVAR),
      readonly(STAKE_HISTORY_SYSVAR),
      readonly(STAKE_PROGRAM),
      readonly(TOKEN_PROGRAM),
    ],
    data: Uint8Array.from([
      WITHDRAW_SOL_WITH_SLIPPAGE,
      ...u64Bytes(poolTokens),
      ...u64Bytes(minimumLamports),
    ]),
  }
}

/**
 * A new stake account derived from the person's own address and a seed. The usual way needs a fresh
 * keypair to sign too, and a venue here must need no signature but the person's.
 */
export function createStakeAccountWithSeed(
  account: string,
  seed: string,
  lamports: bigint
): Instruction {
  const seedBytes = new TextEncoder().encode(seed)
  return {
    programAddress: SYSTEM_PROGRAM as Address,
    accounts: [signer(account), writable(addressWithSeed(account, seed, STAKE_PROGRAM))],
    data: Uint8Array.from([
      ...getU32Encoder().encode(CREATE_ACCOUNT_WITH_SEED),
      ...addressBytes(account),
      ...u64Bytes(BigInt(seedBytes.length)),
      ...seedBytes,
      ...u64Bytes(lamports),
      ...u64Bytes(STAKE_ACCOUNT_SPACE),
      ...addressBytes(STAKE_PROGRAM),
    ]),
  }
}

export function withdrawStake(
  base: PoolInstructionBase & {
    validatorStake: string
    stakeAccount: string
    poolTokens: bigint
    minimumLamports: bigint
  }
): Instruction {
  const { pool, state, withdrawAuthority, account, validatorStake, stakeAccount } = base
  return {
    programAddress: STAKE_POOL_PROGRAM as Address,
    accounts: [
      writable(pool),
      writable(state.validatorList),
      readonly(withdrawAuthority),
      writable(validatorStake),
      writable(stakeAccount),
      readonly(account),
      signer(account),
      writable(associatedTokenAccount(account, state.poolMint)),
      writable(state.managerFeeAccount),
      writable(state.poolMint),
      readonly(CLOCK_SYSVAR),
      readonly(TOKEN_PROGRAM),
      readonly(STAKE_PROGRAM),
    ],
    data: Uint8Array.from([
      WITHDRAW_STAKE_WITH_SLIPPAGE,
      ...u64Bytes(base.poolTokens),
      ...u64Bytes(base.minimumLamports),
    ]),
  }
}

export function deactivateStake(account: string, stakeAccount: string): Instruction {
  return {
    programAddress: STAKE_PROGRAM as Address,
    accounts: [writable(stakeAccount), readonly(CLOCK_SYSVAR), signer(account)],
    data: Uint8Array.from(getU32Encoder().encode(STAKE_DEACTIVATE)),
  }
}

/** Legacy on purpose: with no lookup tables, every account is there for `assertSafe` to read. */
export async function compileForSigning(
  rpc: SolanaRpc,
  account: string,
  instructions: readonly Instruction[]
): Promise<string> {
  const reply = BlockhashReply.safeParse(
    await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])
  )
  if (!reply.success) return unreadable()
  const { blockhash, lastValidBlockHeight } = reply.data.value
  const message = pipe(
    createTransactionMessage({ version: 'legacy' }),
    (m) => setTransactionMessageFeePayer(account as Address, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: blockhash as Blockhash,
          lastValidBlockHeight: BigInt(lastValidBlockHeight),
        },
        m
      ),
    (m) => appendTransactionMessageInstructions(instructions, m)
  )
  return getBase64EncodedWireTransaction(compileTransaction(message))
}

export interface ReadInstruction {
  program: string
  data: Uint8Array
  /** Every account by position. A lookup-table account is refused before a rule sees one. */
  accounts: readonly string[]
}

export interface InstructionRule {
  program: string
  /** The first bytes of the data, in hex. */
  prefix: string
  /** The whole data's length. Absent only where a rule's `also` measures it. */
  length?: number
  accountCount: number
  /**
   * Addresses by position. A position left out is one the program itself checks against its own
   * state, such as a reserve or a fee account, so naming it wrongly fails and diverts nothing.
   */
  accounts: Readonly<Record<number, string>>
  also?: (instruction: ReadInstruction) => boolean
}

export interface StakeShape {
  rules: readonly InstructionRule[]
  /** Checks across instructions. Returns what is wrong, or nothing. */
  also?: (instructions: readonly ReadInstruction[]) => string | undefined
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export const createTokenAccountRule = (account: string, mint: string): InstructionRule => ({
  program: ASSOCIATED_TOKEN_PROGRAM,
  prefix: '01',
  length: 1,
  accountCount: 6,
  accounts: {
    0: account,
    1: associatedTokenAccount(account, mint),
    2: account,
    3: mint,
    4: SYSTEM_PROGRAM,
    5: TOKEN_PROGRAM,
  },
})

export const depositSolRule = (account: string, pool: string, mint: string): InstructionRule => {
  const own = associatedTokenAccount(account, mint)
  return {
    program: STAKE_POOL_PROGRAM,
    prefix: DEPOSIT_SOL_WITH_SLIPPAGE.toString(16).padStart(2, '0'),
    length: 17,
    accountCount: 10,
    accounts: { 0: pool, 3: account, 4: own, 6: own, 7: mint, 8: SYSTEM_PROGRAM, 9: TOKEN_PROGRAM },
    also: ({ data }) => readU64(data, 1) > BigInt(0) && readU64(data, 9) > BigInt(0),
  }
}

export const withdrawSolRule = (account: string, pool: string, mint: string): InstructionRule => ({
  program: STAKE_POOL_PROGRAM,
  prefix: WITHDRAW_SOL_WITH_SLIPPAGE.toString(16).padStart(2, '0'),
  length: 17,
  accountCount: 12,
  accounts: {
    0: pool,
    2: account,
    3: associatedTokenAccount(account, mint),
    5: account,
    7: mint,
    8: CLOCK_SYSVAR,
    9: STAKE_HISTORY_SYSVAR,
    10: STAKE_PROGRAM,
    11: TOKEN_PROGRAM,
  },
  also: ({ data }) => readU64(data, 1) > BigInt(0) && readU64(data, 9) > BigInt(0),
})

export const withdrawStakeRule = (
  account: string,
  pool: string,
  mint: string
): InstructionRule => ({
  program: STAKE_POOL_PROGRAM,
  prefix: WITHDRAW_STAKE_WITH_SLIPPAGE.toString(16).padStart(2, '0'),
  length: 17,
  accountCount: 13,
  accounts: {
    0: pool,
    5: account,
    6: account,
    7: associatedTokenAccount(account, mint),
    9: mint,
    10: CLOCK_SYSVAR,
    11: TOKEN_PROGRAM,
    12: STAKE_PROGRAM,
  },
  also: ({ data }) => readU64(data, 1) > BigInt(0) && readU64(data, 9) > BigInt(0),
})

/**
 * Only `base = the person`, a stake account, a bounded amount of their own SOL, and a slot's seed.
 * Any other seed would make an account nothing here could find again to pay out.
 */
export const createStakeAccountRule = (account: string): InstructionRule => {
  const prefix = hex(
    Uint8Array.from([...getU32Encoder().encode(CREATE_ACCOUNT_WITH_SEED), ...addressBytes(account)])
  )
  return {
    program: SYSTEM_PROGRAM,
    prefix,
    accountCount: 2,
    accounts: { 0: account },
    also: ({ data, accounts }) => {
      const seedLength = Number(readU64(data, 36))
      if (seedLength < 1 || seedLength > 32 || data.length !== 44 + seedLength + 48) return false
      const seed = new TextDecoder().decode(data.subarray(44, 44 + seedLength))
      const end = 44 + seedLength
      return (
        STAKE_EXIT_SEEDS.has(seed) &&
        accounts[1] === addressWithSeed(account, seed, STAKE_PROGRAM) &&
        readU64(data, end) <= MAX_STAKE_ACCOUNT_LAMPORTS &&
        readU64(data, end + 8) === STAKE_ACCOUNT_SPACE &&
        readAddress(data, end + 16) === STAKE_PROGRAM
      )
    },
  }
}

export const deactivateStakeRule = (account: string): InstructionRule => ({
  program: STAKE_PROGRAM,
  prefix: hex(Uint8Array.from(getU32Encoder().encode(STAKE_DEACTIVATE))),
  length: 4,
  accountCount: 3,
  accounts: { 1: CLOCK_SYSVAR, 2: account },
})

function refuse(sentence: string): never {
  throw new ChainActionRefused(`${sentence} Nothing was signed or sent.`)
}

function checkComputeBudget(instructions: readonly ReadInstruction[]): void {
  const [limit, price] = instructions
  const valid =
    instructions.length === 2 &&
    limit?.data.length === 5 &&
    limit.data[0] === 2 &&
    price?.data.length === 9 &&
    price.data[0] === 3
  if (!valid) return refuse('This transaction sets a compute budget I didn’t build.')
  const units = BigInt(readU32(limit.data, 1))
  if ((readU64(price.data, 1) * units) / BigInt(1_000_000) > MAX_PRIORITY_FEE_LAMPORTS) {
    refuse('This transaction would pay an unusually large priority fee from your SOL.')
  }
}

function unexpectedProgram(venueName: string, program: string): string {
  if (program === SYSTEM_PROGRAM) {
    return `This transaction includes a SOL transfer or account change ${venueName} doesn’t need.`
  }
  if (program === TOKEN_PROGRAM) {
    return `This transaction moves or approves tokens outside what ${venueName} needs.`
  }
  return `This transaction calls a program ${venueName} should not need.`
}

function ruleFailure(
  venueName: string,
  rule: InstructionRule,
  instruction: ReadInstruction
): string | undefined {
  if (instruction.program !== rule.program) return unexpectedProgram(venueName, instruction.program)
  const prefix = hex(instruction.data.subarray(0, rule.prefix.length / 2))
  const lengthOk = rule.length === undefined || instruction.data.length === rule.length
  if (prefix !== rule.prefix || !lengthOk) {
    return `This transaction asks ${venueName} for an instruction I didn’t expect.`
  }
  const accountsOk =
    instruction.accounts.length === rule.accountCount &&
    Object.entries(rule.accounts).every(
      ([position, address]) => instruction.accounts[Number(position)] === address
    )
  if (!accountsOk || (rule.also !== undefined && !rule.also(instruction))) {
    return `This transaction names an account or amount that isn’t what ${venueName} should get from you.`
  }
  return undefined
}

/** How far a transaction gets through a shape, so a refusal names the nearest thing wrong. */
function shapeFailure(
  venueName: string,
  shape: StakeShape,
  instructions: readonly ReadInstruction[]
): { matched: number; reason: string } | undefined {
  const { rules } = shape
  for (let i = 0; i < Math.max(rules.length, instructions.length); i += 1) {
    const rule = rules[i]
    const instruction = instructions[i]
    if (instruction === undefined) {
      return {
        matched: i,
        reason: `This transaction is missing a step of the ${venueName} action.`,
      }
    }
    if (rule === undefined) {
      return { matched: i, reason: unexpectedProgram(venueName, instruction.program) }
    }
    const reason = ruleFailure(venueName, rule, instruction)
    if (reason !== undefined) {
      return { matched: i + (instruction.program === rule.program ? 0.5 : 0), reason }
    }
  }
  const across = shape.also?.(instructions)
  return across === undefined ? undefined : { matched: rules.length, reason: across }
}

/**
 * Refuses a transaction unless it is exactly one of the shapes a venue builds: the person alone
 * signs and pays, every program, instruction and step is expected and in order, each carries the
 * exact data length, and every account that decides whose funds these are is the person's.
 *
 * What this can't see is what an allowed program does inside. Amounts stay the person's choice:
 * the build fixes them, and a change to one still pays only the person.
 */
export function assertStakeShape(
  payload: SigningPayload,
  account: string,
  venueName: string,
  shapes: readonly StakeShape[]
): void {
  if (payload.family !== 'solana') return refuse('That is not a Solana transaction.')
  if (!isAddress(account)) return refuse('That is not a Solana wallet address.')

  const transaction = decodeSolanaTransaction(payload.transaction)
  if (transaction.feePayer !== account) {
    refuse(`This transaction’s network fee would not be paid by your wallet, ${account}.`)
  }
  if (transaction.signerCount !== 1 || transaction.readonlySignerCount !== 0) {
    refuse('This transaction needs a signature from someone other than you.')
  }

  const budget: ReadInstruction[] = []
  const rest: ReadInstruction[] = []
  for (const instruction of transaction.instructions) {
    const program = transaction.staticAccounts[instruction.programIndex]
    const accounts = instruction.accounts.map((index) => transaction.staticAccounts[index])
    if (program === undefined || accounts.some((address) => address === undefined)) {
      return refuse('This transaction hides an account in a lookup table, so I can’t check it.')
    }
    const read = { program, data: instruction.data, accounts: accounts as string[] }
    if (program === COMPUTE_BUDGET_PROGRAM) budget.push(read)
    else rest.push(read)
  }
  checkComputeBudget(budget)

  let nearest: { matched: number; reason: string } | undefined
  for (const shape of shapes) {
    const failure = shapeFailure(venueName, shape, rest)
    if (failure === undefined) return
    if (nearest === undefined || failure.matched > nearest.matched) nearest = failure
  }
  refuse(nearest?.reason ?? `This transaction isn’t a ${venueName} action I build.`)
}

/** Refuses anything but a stake of SOL or an unstake of the venue's own token. */
export function stakedTokenOrRefuse(
  venueName: string,
  kind: string,
  tokenIn: string,
  expected: string,
  example: string
): void {
  if (tokenIn.trim().toUpperCase() !== expected.toUpperCase()) {
    throw new ChainActionRefused(
      `${venueName} takes ${expected} to ${kind} here, not ${tokenIn}. Try "${example}". Nothing was signed or sent.`
    )
  }
}
