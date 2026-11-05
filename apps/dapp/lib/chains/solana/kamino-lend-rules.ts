import { createHash } from 'node:crypto'

import {
  getAddressDecoder,
  getAddressEncoder,
  isAddress,
  isOffCurveAddress,
  type Address,
  type Instruction,
} from '@solana/kit'

import { ChainActionRefused, tokenBySymbol, type SigningPayload } from '../types'
import {
  associatedTokenAccount,
  decodeSolanaTransaction,
  ownWrappedSolAccount,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  ASSOCIATED_TOKEN_PROGRAM,
} from './assert-safe'
import { KFARMS_PROGRAM } from './programs'
import {
  accountRoles,
  anchorAmountData,
  assertStakeShape,
  createTokenAccountRule,
  readAddress,
  readU64,
  type InstructionRule,
  type ReadInstruction,
} from './stake-pool'
import { SOLANA_TOKENS } from './tokens'

/**
 * Kamino Lend's program, its instructions, its accounts, and a check that a transaction is exactly
 * what this venue builds. All of it comes from the program's public source,
 * https://github.com/Kamino-Finance/klend, and was seen working against the chain on 5 November
 * 2026: `programs/klend/src/handlers/` for accounts, `libs/klend-interface/src/state/` for layouts.
 *
 * Accounts a rule leaves open are the ones the program checks against the reserve itself, such as
 * its vaults and oracles, so naming one wrongly fails and diverts nothing.
 */

/** https://kamino.com/docs/build/resources/program-addresses.md, "Klend" on mainnet. */
export const KLEND_PROGRAM = 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD'
/** Listed as primary by https://api.kamino.finance/v2/kamino-market, and owned by the program on chain. */
export const KAMINO_MAIN_MARKET = '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF'

const INSTRUCTIONS_SYSVAR = 'Sysvar1nstructions1111111111111111111111111'
const RENT_SYSVAR = 'SysvarRent111111111111111111111111111111111'
const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111'

export const U64_MAX = BigInt('18446744073709551615')
const WRAPPED_SOL_SYMBOL = 'SOL'

/** Anchor's hash of each instruction's name, first eight bytes. */
const DISCRIMINATOR = {
  initUserMetadata: '75a9b045c5170fa2',
  initObligation: 'fb0ae74c1b0b9f60',
  initObligationFarms: '883f0fbad398a8a4',
  refreshReserve: '02da8aeb4fc91966',
  refreshObligation: '218493e497c04859',
  deposit: 'd8e0bf1bcc9766af',
  withdraw: 'eb34779895c51407',
  borrow: 'a1808ff5abc7c206',
  repay: '74aed54cb435d290',
} as const

const ACCOUNT_DISCRIMINATOR = {
  reserve: '2bf2ccca1af73b7f',
  obligation: 'a8ce8d6a584caca7',
} as const

export interface ReserveListing {
  symbol: string
  reserve: string
  mint: string
  decimals: number
}

/**
 * The main market's reserve for each token. Each is checked on chain against its market and mint at
 * every build. The market also holds fixed-term USDC reserves, which are not these.
 */
const PINNED_RESERVES: readonly (readonly [symbol: string, reserve: string])[] = [
  ['SOL', 'd4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q'],
  ['USDC', 'D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59'],
  ['USDT', 'H3t6qZ1JkguCNTi9uzVKqQ7dvt2cum4XiXWom6Gn5e5S'],
  ['JitoSOL', 'EVbyPKrHG6WBfm4dLxLMJpUDY43cCAcHSpV3KYjKsktW'],
  ['mSOL', 'FBSyPnxtHKLBZ4UeeUyAnbtFuAmTHLtso9YtsqRDRWpM'],
]

export const KAMINO_LEND_RESERVES: readonly ReserveListing[] = PINNED_RESERVES.map(
  ([symbol, reserve]) => {
    const token = tokenBySymbol(SOLANA_TOKENS, symbol)
    if (token === undefined) throw new Error(`${symbol} is not in the Solana token table.`)
    return { symbol, reserve, mint: token.id, decimals: token.decimals }
  }
)

const BY_RESERVE = new Map(KAMINO_LEND_RESERVES.map((listing) => [listing.reserve, listing]))
const BY_MINT = new Map(KAMINO_LEND_RESERVES.map((listing) => [listing.mint, listing]))

export function reserveListing(symbol: string): ReserveListing {
  const wanted = symbol.trim().toUpperCase()
  const listing = KAMINO_LEND_RESERVES.find((r) => r.symbol.toUpperCase() === wanted)
  if (listing === undefined) {
    throw new ChainActionRefused(
      `Kamino Lend here takes ${KAMINO_LEND_RESERVES.map((r) => r.symbol).join(', ')}, not ${symbol}. Nothing was signed or sent.`
    )
  }
  return listing
}

export function reserveByAddress(reserve: string): ReserveListing | undefined {
  return BY_RESERVE.get(reserve)
}

function addressBytes(address: string): Uint8Array {
  return Uint8Array.from(getAddressEncoder().encode(address as Address))
}

/** Written out because `assertSafe` is synchronous and the kit's derivation is not. */
function programAddress(seeds: readonly (string | Uint8Array)[], program: string): string {
  const decoder = getAddressDecoder()
  const programBytes = addressBytes(program)
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

export function lendingMarketAuthority(): string {
  return programAddress(['lma', addressBytes(KAMINO_MAIN_MARKET)], KLEND_PROGRAM)
}

export function userMetadataAddress(owner: string): string {
  return programAddress(['user_meta', addressBytes(owner)], KLEND_PROGRAM)
}

/** The plain position: tag 0, id 0, no seed accounts. Kamino's own app opens the same one. */
export function obligationAddress(owner: string): string {
  const none = addressBytes(SYSTEM_PROGRAM)
  return programAddress(
    [
      Uint8Array.of(0),
      Uint8Array.of(0),
      addressBytes(owner),
      addressBytes(KAMINO_MAIN_MARKET),
      none,
      none,
    ],
    KLEND_PROGRAM
  )
}

export function farmUserStateAddress(farm: string, obligation: string): string {
  return programAddress(['user', addressBytes(farm), addressBytes(obligation)], KFARMS_PROGRAM)
}

export function referrerTokenStateAddress(referrer: string, reserve: string): string {
  return programAddress(
    ['referrer_acc', addressBytes(referrer), addressBytes(reserve)],
    KLEND_PROGRAM
  )
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Little-endian, any length: a u128 fraction, or a 256-bit one. */
function readWide(data: Uint8Array, offset: number, length: number): bigint {
  let value = BigInt(0)
  for (let i = length - 1; i >= 0; i -= 1) {
    value = (value << BigInt(8)) | BigInt(data[offset + i] ?? 0)
  }
  return value
}

const readU16 = (data: Uint8Array, offset: number): number =>
  (data[offset] ?? 0) | ((data[offset + 1] ?? 0) << 8)
const readU32 = (data: Uint8Array, offset: number): number => Number(readWide(data, offset, 4))

export interface ReserveState {
  market: string
  farmCollateral: string
  farmDebt: string
  mint: string
  supplyVault: string
  feeVault: string
  available: bigint
  borrowedSf: bigint
  /** Interest kept for the protocol and referrers, which is not depositors' money. */
  feesSf: bigint
  priceSf: bigint
  decimals: number
  cumulativeBorrowRateBsf: bigint
  tokenProgram: string
  collateralMint: string
  collateralSupply: bigint
  collateralVault: string
  status: number
  hostFixedBps: number
  takeRatePct: number
  ltvPct: number
  liquidationPct: number
  minBonusBps: number
  maxBonusBps: number
  originationSf: bigint
  curve: readonly (readonly [utilizationBps: number, rateBps: number])[]
  borrowFactorPct: bigint
  borrowLimit: bigint
  name: string
  scopePrices: string
  switchboardPrice: string
  switchboardTwap: string
  pyth: string
  queuedCollateral: bigint
  lastUpdateSeconds: number
}

const RESERVE_BYTES = 8624
const OBLIGATION_BYTES = 3344

export function decodeReserve(data: Uint8Array): ReserveState | undefined {
  if (data.length !== RESERVE_BYTES) return undefined
  if (hex(data.subarray(0, 8)) !== ACCOUNT_DISCRIMINATOR.reserve) return undefined
  const curve: [number, number][] = []
  for (let i = 0; i < 11; i += 1) {
    curve.push([readU32(data, 4920 + i * 8), readU32(data, 4924 + i * 8)])
  }
  return {
    market: readAddress(data, 32),
    farmCollateral: readAddress(data, 64),
    farmDebt: readAddress(data, 96),
    mint: readAddress(data, 128),
    supplyVault: readAddress(data, 160),
    feeVault: readAddress(data, 192),
    available: readU64(data, 224),
    borrowedSf: readWide(data, 232, 16),
    feesSf: readWide(data, 344, 16) + readWide(data, 360, 16) + readWide(data, 376, 16),
    priceSf: readWide(data, 248, 16),
    decimals: Number(readU64(data, 272)),
    cumulativeBorrowRateBsf: readWide(data, 296, 32),
    tokenProgram: readAddress(data, 408),
    collateralMint: readAddress(data, 2560),
    collateralSupply: readU64(data, 2592),
    collateralVault: readAddress(data, 2600),
    status: data[4856] ?? 0,
    hostFixedBps: readU16(data, 4858),
    takeRatePct: data[4870] ?? 0,
    ltvPct: data[4872] ?? 0,
    liquidationPct: data[4873] ?? 0,
    minBonusBps: readU16(data, 4874),
    maxBonusBps: readU16(data, 4876),
    originationSf: readU64(data, 4896),
    curve,
    borrowFactorPct: readU64(data, 5008),
    borrowLimit: readU64(data, 5024),
    name: new TextDecoder()
      .decode(data.subarray(5032, 5064))
      .replace(/\0+$/, '')
      .replace(/[^\p{L}\p{N} ._+-]/gu, '')
      .trim(),
    scopePrices: readAddress(data, 5112),
    switchboardPrice: readAddress(data, 5160),
    switchboardTwap: readAddress(data, 5192),
    pyth: readAddress(data, 5224),
    queuedCollateral: readU64(data, 6968),
    lastUpdateSeconds: readU32(data, 28),
  }
}

export interface ObligationDeposit {
  reserve: string
  cTokens: bigint
}

export interface ObligationBorrow {
  reserve: string
  cumulativeBorrowRateBsf: bigint
  borrowedSf: bigint
}

export interface ObligationState {
  market: string
  owner: string
  deposits: readonly ObligationDeposit[]
  borrows: readonly ObligationBorrow[]
  elevationGroup: number
  /** Undefined where no one referred this position. */
  referrer: string | undefined
}

export function decodeObligation(data: Uint8Array): ObligationState | undefined {
  if (data.length !== OBLIGATION_BYTES) return undefined
  if (hex(data.subarray(0, 8)) !== ACCOUNT_DISCRIMINATOR.obligation) return undefined
  const deposits: ObligationDeposit[] = []
  for (let i = 0; i < 8; i += 1) {
    const at = 96 + i * 136
    const reserve = readAddress(data, at)
    if (reserve !== SYSTEM_PROGRAM) deposits.push({ reserve, cTokens: readU64(data, at + 32) })
  }
  const borrows: ObligationBorrow[] = []
  for (let i = 0; i < 5; i += 1) {
    const at = 1208 + i * 200
    const reserve = readAddress(data, at)
    if (reserve !== SYSTEM_PROGRAM) {
      borrows.push({
        reserve,
        cumulativeBorrowRateBsf: readWide(data, at + 32, 32),
        borrowedSf: readWide(data, at + 88, 16),
      })
    }
  }
  const referrer = readAddress(data, 2288)
  return {
    market: readAddress(data, 32),
    owner: readAddress(data, 64),
    deposits,
    borrows,
    elevationGroup: data[2285] ?? 0,
    referrer: referrer === SYSTEM_PROGRAM ? undefined : referrer,
  }
}

const { readonly, signer, writable } = accountRoles

/** An optional account the program takes as absent when it is given its own address. */
const orNone = (address: string | undefined): string =>
  address === undefined || address === SYSTEM_PROGRAM ? KLEND_PROGRAM : address

const noData = (discriminator: string): Uint8Array =>
  Uint8Array.from(Buffer.from(discriminator, 'hex'))

export function initUserMetadata(account: string): Instruction {
  return {
    programAddress: KLEND_PROGRAM as Address,
    accounts: [
      signer(account),
      signer(account),
      writable(userMetadataAddress(account)),
      readonly(KLEND_PROGRAM),
      readonly(RENT_SYSVAR),
      readonly(SYSTEM_PROGRAM),
    ],
    data: Uint8Array.from([...noData(DISCRIMINATOR.initUserMetadata), ...new Uint8Array(32)]),
  }
}

export function initObligation(account: string): Instruction {
  return {
    programAddress: KLEND_PROGRAM as Address,
    accounts: [
      signer(account),
      signer(account),
      writable(obligationAddress(account)),
      readonly(KAMINO_MAIN_MARKET),
      readonly(SYSTEM_PROGRAM),
      readonly(SYSTEM_PROGRAM),
      readonly(userMetadataAddress(account)),
      readonly(RENT_SYSVAR),
      readonly(SYSTEM_PROGRAM),
    ],
    data: Uint8Array.from([...noData(DISCRIMINATOR.initObligation), 0, 0]),
  }
}

export const FARM_COLLATERAL = 0
export const FARM_DEBT = 1

export function initObligationFarms(
  account: string,
  reserve: string,
  farm: string,
  mode: number
): Instruction {
  const obligation = obligationAddress(account)
  return {
    programAddress: KLEND_PROGRAM as Address,
    accounts: [
      signer(account),
      readonly(account),
      writable(obligation),
      readonly(lendingMarketAuthority()),
      writable(reserve),
      writable(farm),
      writable(farmUserStateAddress(farm, obligation)),
      readonly(KAMINO_MAIN_MARKET),
      readonly(KFARMS_PROGRAM),
      readonly(RENT_SYSVAR),
      readonly(SYSTEM_PROGRAM),
    ],
    data: Uint8Array.from([...noData(DISCRIMINATOR.initObligationFarms), mode]),
  }
}

/** Anyone may call this, and it only brings the reserve's own figures up to date. */
export function refreshReserve(reserve: string, state: ReserveState): Instruction {
  return {
    programAddress: KLEND_PROGRAM as Address,
    accounts: [
      writable(reserve),
      readonly(KAMINO_MAIN_MARKET),
      readonly(orNone(state.pyth)),
      readonly(orNone(state.switchboardPrice)),
      readonly(orNone(state.switchboardTwap)),
      readonly(orNone(state.scopePrices)),
    ],
    data: noData(DISCRIMINATOR.refreshReserve),
  }
}

/** The program reads what follows as the position's deposit reserves, borrow reserves, then referrer records. */
export function refreshObligation(account: string, others: readonly string[]): Instruction {
  return {
    programAddress: KLEND_PROGRAM as Address,
    accounts: [
      readonly(KAMINO_MAIN_MARKET),
      writable(obligationAddress(account)),
      ...others.map(writable),
    ],
    data: noData(DISCRIMINATOR.refreshObligation),
  }
}

interface ActionBase {
  account: string
  reserve: string
  state: ReserveState
  /** The record of this position in the reserve's reward farm, if the reserve has a farm. */
  farm: string | undefined
  amount: bigint
}

function farmAccounts(account: string, farm: string | undefined) {
  if (farm === undefined || farm === SYSTEM_PROGRAM) {
    return [readonly(KLEND_PROGRAM), readonly(KLEND_PROGRAM)]
  }
  const user = farmUserStateAddress(farm, obligationAddress(account))
  return [writable(user), writable(farm)]
}

export function deposit({ account, reserve, state, farm, amount }: ActionBase): Instruction {
  return {
    programAddress: KLEND_PROGRAM as Address,
    accounts: [
      signer(account),
      writable(obligationAddress(account)),
      readonly(KAMINO_MAIN_MARKET),
      readonly(lendingMarketAuthority()),
      writable(reserve),
      readonly(state.mint),
      writable(state.supplyVault),
      writable(state.collateralMint),
      writable(state.collateralVault),
      writable(associatedTokenAccount(account, state.mint)),
      readonly(KLEND_PROGRAM),
      readonly(TOKEN_PROGRAM),
      readonly(TOKEN_PROGRAM),
      readonly(INSTRUCTIONS_SYSVAR),
      ...farmAccounts(account, farm),
      readonly(KFARMS_PROGRAM),
    ],
    data: anchorAmountData(DISCRIMINATOR.deposit, amount),
  }
}

export function withdraw({ account, reserve, state, farm, amount }: ActionBase): Instruction {
  return {
    programAddress: KLEND_PROGRAM as Address,
    accounts: [
      signer(account),
      writable(obligationAddress(account)),
      readonly(KAMINO_MAIN_MARKET),
      readonly(lendingMarketAuthority()),
      writable(reserve),
      readonly(state.mint),
      writable(state.collateralVault),
      writable(state.collateralMint),
      writable(state.supplyVault),
      writable(associatedTokenAccount(account, state.mint)),
      readonly(KLEND_PROGRAM),
      readonly(TOKEN_PROGRAM),
      readonly(TOKEN_PROGRAM),
      readonly(INSTRUCTIONS_SYSVAR),
      ...farmAccounts(account, farm),
      readonly(KFARMS_PROGRAM),
    ],
    data: anchorAmountData(DISCRIMINATOR.withdraw, amount),
  }
}

export function borrow(
  { account, reserve, state, farm, amount }: ActionBase,
  referrer: string | undefined
): Instruction {
  return {
    programAddress: KLEND_PROGRAM as Address,
    accounts: [
      signer(account),
      writable(obligationAddress(account)),
      readonly(KAMINO_MAIN_MARKET),
      readonly(lendingMarketAuthority()),
      writable(reserve),
      readonly(state.mint),
      writable(state.supplyVault),
      writable(state.feeVault),
      writable(associatedTokenAccount(account, state.mint)),
      referrer === undefined
        ? readonly(KLEND_PROGRAM)
        : writable(referrerTokenStateAddress(referrer, reserve)),
      readonly(TOKEN_PROGRAM),
      readonly(INSTRUCTIONS_SYSVAR),
      ...farmAccounts(account, farm),
      readonly(KFARMS_PROGRAM),
    ],
    data: anchorAmountData(DISCRIMINATOR.borrow, amount),
  }
}

/** `depositReserves` is only for a position in a special mode, whose debt is tracked on each one. */
export function repay(
  { account, reserve, state, farm, amount }: ActionBase,
  depositReserves: readonly string[]
): Instruction {
  return {
    programAddress: KLEND_PROGRAM as Address,
    accounts: [
      signer(account),
      writable(obligationAddress(account)),
      readonly(KAMINO_MAIN_MARKET),
      writable(reserve),
      readonly(state.mint),
      writable(state.supplyVault),
      writable(associatedTokenAccount(account, state.mint)),
      readonly(TOKEN_PROGRAM),
      readonly(INSTRUCTIONS_SYSVAR),
      ...farmAccounts(account, farm),
      readonly(lendingMarketAuthority()),
      readonly(KFARMS_PROGRAM),
      ...depositReserves.map(writable),
    ],
    data: anchorAmountData(DISCRIMINATOR.repay, amount),
  }
}

/** Where a money step lists what the rules check, position by position. */
interface MoneyLayout {
  discriminator: string
  accountCount: number
  /** Extra accounts it may carry after the fixed ones, the position's own reserves. */
  extraAccounts: number
  reserve: number
  mint: number
  userToken: number
  farmUser: number
  farmState: number
  /** Accounts that are always the same, by position. */
  fixed: (account: string) => Record<number, string>
  /** Whether "the whole of it", the largest number there is, means anything safe here. */
  takesWhole: boolean
}

const common = (account: string) => ({
  0: account,
  1: obligationAddress(account),
  2: KAMINO_MAIN_MARKET,
})

const MONEY_LAYOUTS: readonly MoneyLayout[] = [
  {
    discriminator: DISCRIMINATOR.deposit,
    accountCount: 17,
    extraAccounts: 0,
    reserve: 4,
    mint: 5,
    userToken: 9,
    farmUser: 14,
    farmState: 15,
    takesWhole: false,
    fixed: (account) => ({
      ...common(account),
      3: lendingMarketAuthority(),
      10: KLEND_PROGRAM,
      11: TOKEN_PROGRAM,
      12: TOKEN_PROGRAM,
      13: INSTRUCTIONS_SYSVAR,
      16: KFARMS_PROGRAM,
    }),
  },
  {
    discriminator: DISCRIMINATOR.withdraw,
    accountCount: 17,
    extraAccounts: 0,
    reserve: 4,
    mint: 5,
    userToken: 9,
    farmUser: 14,
    farmState: 15,
    takesWhole: true,
    fixed: (account) => ({
      ...common(account),
      3: lendingMarketAuthority(),
      10: KLEND_PROGRAM,
      11: TOKEN_PROGRAM,
      12: TOKEN_PROGRAM,
      13: INSTRUCTIONS_SYSVAR,
      16: KFARMS_PROGRAM,
    }),
  },
  {
    // The largest number here would borrow everything the position allows, which nobody asked for.
    discriminator: DISCRIMINATOR.borrow,
    accountCount: 15,
    extraAccounts: 0,
    reserve: 4,
    mint: 5,
    userToken: 8,
    farmUser: 12,
    farmState: 13,
    takesWhole: false,
    fixed: (account) => ({
      ...common(account),
      3: lendingMarketAuthority(),
      10: TOKEN_PROGRAM,
      11: INSTRUCTIONS_SYSVAR,
      14: KFARMS_PROGRAM,
    }),
  },
  {
    discriminator: DISCRIMINATOR.repay,
    accountCount: 13,
    extraAccounts: 8,
    reserve: 3,
    mint: 4,
    userToken: 6,
    farmUser: 9,
    farmState: 10,
    takesWhole: true,
    fixed: (account) => ({
      ...common(account),
      7: TOKEN_PROGRAM,
      8: INSTRUCTIONS_SYSVAR,
      11: lendingMarketAuthority(),
      12: KFARMS_PROGRAM,
    }),
  },
]

const isCalled = (step: ReadInstruction, discriminator: string): boolean =>
  step.program === KLEND_PROGRAM && hex(step.data.subarray(0, 8)) === discriminator

function moneyRule(step: ReadInstruction, account: string): InstructionRule | undefined {
  const layout = MONEY_LAYOUTS.find((candidate) => isCalled(step, candidate.discriminator))
  if (layout === undefined) return undefined
  const listing = BY_RESERVE.get(step.accounts[layout.reserve] ?? '')
  const extra = step.accounts.length - layout.accountCount
  if (listing === undefined || extra < 0 || extra > layout.extraAccounts) return undefined
  const obligation = obligationAddress(account)
  return {
    program: KLEND_PROGRAM,
    prefix: layout.discriminator,
    length: 16,
    accountCount: step.accounts.length,
    accounts: {
      ...layout.fixed(account),
      [layout.reserve]: listing.reserve,
      [layout.mint]: listing.mint,
      [layout.userToken]: associatedTokenAccount(account, listing.mint),
    },
    also: ({ data, accounts }) => {
      const amount = readU64(data, 8)
      if (amount === BigInt(0) || (amount === U64_MAX && !layout.takesWhole)) return false
      const farmUser = accounts[layout.farmUser] ?? ''
      const farmState = accounts[layout.farmState] ?? ''
      if (farmUser === KLEND_PROGRAM && farmState === KLEND_PROGRAM) return true
      return (
        farmState !== KLEND_PROGRAM &&
        isAddress(farmState) &&
        farmUser === farmUserStateAddress(farmState, obligation)
      )
    },
  }
}

const initUserMetadataRule = (account: string): InstructionRule => ({
  program: KLEND_PROGRAM,
  // A referral and a lookup table are both stored at this one chance, and this sets neither.
  prefix: `${DISCRIMINATOR.initUserMetadata}${'00'.repeat(32)}`,
  length: 40,
  accountCount: 6,
  accounts: {
    0: account,
    1: account,
    2: userMetadataAddress(account),
    3: KLEND_PROGRAM,
    4: RENT_SYSVAR,
    5: SYSTEM_PROGRAM,
  },
})

const initObligationRule = (account: string): InstructionRule => ({
  program: KLEND_PROGRAM,
  prefix: `${DISCRIMINATOR.initObligation}0000`,
  length: 10,
  accountCount: 9,
  accounts: {
    0: account,
    1: account,
    2: obligationAddress(account),
    3: KAMINO_MAIN_MARKET,
    4: SYSTEM_PROGRAM,
    5: SYSTEM_PROGRAM,
    6: userMetadataAddress(account),
    7: RENT_SYSVAR,
    8: SYSTEM_PROGRAM,
  },
})

function initFarmsRule(step: ReadInstruction, account: string): InstructionRule | undefined {
  const reserve = step.accounts[4] ?? ''
  const farm = step.accounts[5] ?? ''
  if (!BY_RESERVE.has(reserve) || !isAddress(farm)) return undefined
  const obligation = obligationAddress(account)
  return {
    program: KLEND_PROGRAM,
    prefix: DISCRIMINATOR.initObligationFarms,
    length: 9,
    accountCount: 11,
    accounts: {
      0: account,
      1: account,
      2: obligation,
      3: lendingMarketAuthority(),
      6: farmUserStateAddress(farm, obligation),
      7: KAMINO_MAIN_MARKET,
      8: KFARMS_PROGRAM,
      9: RENT_SYSVAR,
      10: SYSTEM_PROGRAM,
    },
    also: ({ data }) => data[8] === FARM_COLLATERAL || data[8] === FARM_DEBT,
  }
}

const refreshReserveRule: InstructionRule = {
  program: KLEND_PROGRAM,
  prefix: DISCRIMINATOR.refreshReserve,
  length: 8,
  accountCount: 6,
  accounts: { 1: KAMINO_MAIN_MARKET },
}

/** Two fixed accounts, up to 8 deposits, 5 borrows, and a referrer record for each borrow. */
const MAX_REFRESH_OBLIGATION_ACCOUNTS = 20

function refreshObligationRule(
  step: ReadInstruction,
  account: string
): InstructionRule | undefined {
  if (step.accounts.length < 2 || step.accounts.length > MAX_REFRESH_OBLIGATION_ACCOUNTS) {
    return undefined
  }
  return {
    program: KLEND_PROGRAM,
    prefix: DISCRIMINATOR.refreshObligation,
    length: 8,
    accountCount: step.accounts.length,
    accounts: { 0: KAMINO_MAIN_MARKET, 1: obligationAddress(account) },
  }
}

/** Reads a transaction through the only order this venue builds, and gives each step its rule. */
function rulesFor(steps: readonly ReadInstruction[], account: string): InstructionRule[] {
  const rules: InstructionRule[] = []
  let at = 0
  const take = (rule: (step: ReadInstruction) => InstructionRule | undefined): boolean => {
    const step = steps[at]
    const found = step === undefined ? undefined : rule(step)
    if (found === undefined) return false
    rules.push(found)
    at += 1
    return true
  }
  const wrapped = ownWrappedSolAccount(account)

  take((step) => {
    if (step.program !== ASSOCIATED_TOKEN_PROGRAM) return undefined
    return BY_MINT.has(step.accounts[3] ?? '')
      ? createTokenAccountRule(account, step.accounts[3] as string)
      : undefined
  })
  const wraps = take((step) =>
    step.program === SYSTEM_PROGRAM
      ? {
          program: SYSTEM_PROGRAM,
          prefix: '02000000',
          length: 12,
          accountCount: 2,
          accounts: { 0: account, 1: wrapped },
        }
      : undefined
  )
  if (wraps) {
    take((step) =>
      step.program === TOKEN_PROGRAM
        ? {
            program: TOKEN_PROGRAM,
            prefix: '11',
            length: 1,
            accountCount: 1,
            accounts: { 0: wrapped },
          }
        : undefined
    )
  }
  take((step) =>
    isCalled(step, DISCRIMINATOR.initUserMetadata) ? initUserMetadataRule(account) : undefined
  )
  take((step) =>
    isCalled(step, DISCRIMINATOR.initObligation) ? initObligationRule(account) : undefined
  )
  take((step) =>
    isCalled(step, DISCRIMINATOR.initObligationFarms) ? initFarmsRule(step, account) : undefined
  )
  while (
    take((step) => (isCalled(step, DISCRIMINATOR.refreshReserve) ? refreshReserveRule : undefined))
  ) {
    // Each pass takes one reserve's refresh.
  }
  take((step) =>
    isCalled(step, DISCRIMINATOR.refreshObligation)
      ? refreshObligationRule(step, account)
      : undefined
  )
  take((step) => moneyRule(step, account))
  take((step) =>
    step.program === TOKEN_PROGRAM
      ? {
          program: TOKEN_PROGRAM,
          prefix: '09',
          length: 1,
          accountCount: 3,
          accounts: { 0: wrapped, 1: account, 2: account },
        }
      : undefined
  )
  return rules
}

const moneyLayoutOf = (step: ReadInstruction): MoneyLayout | undefined =>
  MONEY_LAYOUTS.find((candidate) => isCalled(step, candidate.discriminator))

/**
 * What the single steps can't say: that the transaction does one money step, on reserves refreshed
 * just before it, and that any token account it opens or wrapped SOL it handles is for that token.
 */
function acrossSteps(steps: readonly ReadInstruction[]): string | undefined {
  const money = steps.filter((step) => moneyLayoutOf(step) !== undefined)
  const [only] = money
  const layout = only === undefined ? undefined : moneyLayoutOf(only)
  const missing = 'This transaction is missing a step of the Kamino Lend action.'
  if (money.length !== 1 || only === undefined || layout === undefined) return missing
  if (!steps.some((step) => isCalled(step, DISCRIMINATOR.refreshObligation))) return missing

  const reserve = only.accounts[layout.reserve] ?? ''
  const refreshed = steps.some(
    (step) => isCalled(step, DISCRIMINATOR.refreshReserve) && step.accounts[0] === reserve
  )
  if (!refreshed) return missing

  const listing = BY_RESERVE.get(reserve)
  const isSol = listing?.symbol === WRAPPED_SOL_SYMBOL
  const opens = steps.find((step) => step.program === ASSOCIATED_TOKEN_PROGRAM)
  const wraps = steps.some((step) => step.program === SYSTEM_PROGRAM)
  const closes = steps.some((step) => step.program === TOKEN_PROGRAM && step.data[0] === 9)
  const takesIn =
    layout.discriminator === DISCRIMINATOR.deposit || layout.discriminator === DISCRIMINATOR.repay
  const wrong = 'This transaction handles a token the Kamino Lend action doesn’t need.'
  if (opens !== undefined && opens.accounts[3] !== listing?.mint) return wrong
  if ((wraps || closes) && !isSol) return wrong
  if (wraps && (!takesIn || !closes)) return wrong
  return undefined
}

/**
 * Refuses a transaction unless it is exactly what this venue builds: the person alone signs and
 * pays, and the only money step takes from or pays to their own token account, on their own
 * position, in a reserve listed here. Interest and limits stay the program's to enforce.
 */
export function assertKaminoLendSafe(payload: SigningPayload, account: string): void {
  let steps: ReadInstruction[] = []
  if (payload.family === 'solana' && isAddress(account)) {
    const transaction = decodeSolanaTransaction(payload.transaction)
    steps = transaction.instructions
      .map((instruction) => ({
        program: transaction.staticAccounts[instruction.programIndex] ?? '',
        data: instruction.data,
        accounts: instruction.accounts.map((index) => transaction.staticAccounts[index] ?? ''),
      }))
      .filter((step) => step.program !== COMPUTE_BUDGET_PROGRAM)
  }
  const rules = steps.length === 0 ? [] : rulesFor(steps, account)
  assertStakeShape(payload, account, 'Kamino Lend', [
    { rules, also: (instructions) => acrossSteps(instructions) },
  ])
}
