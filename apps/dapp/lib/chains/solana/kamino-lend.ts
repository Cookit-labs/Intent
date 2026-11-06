import { isAddress, type Instruction } from '@solana/kit'
import { z } from 'zod'

import { bytesFromBase64 } from '../base64'
import {
  ChainActionRefused,
  quotedApy,
  takesOnly,
  toBaseUnits,
  type ChainActionRequest,
  type ChainVenue,
  type PreparedAction,
  type VenuePosition,
  type VenueQuote,
} from '../types'
import { ownWrappedSolAccount, SYSTEM_PROGRAM, TOKEN_PROGRAM } from './assert-safe'
import {
  assertKaminoLendSafe,
  borrow,
  decodeObligation,
  decodeReserve,
  deposit,
  FARM_COLLATERAL,
  FARM_DEBT,
  farmUserStateAddress,
  initObligation,
  initObligationFarms,
  initUserMetadata,
  KAMINO_LEND_RESERVES,
  KAMINO_MAIN_MARKET,
  KLEND_PROGRAM,
  obligationAddress,
  referrerTokenStateAddress,
  refreshObligation,
  refreshReserve,
  repay,
  reserveByAddress,
  reserveListing,
  U64_MAX,
  userMetadataAddress,
  withdraw,
  type ObligationBorrow,
  type ObligationState,
  type ReserveListing,
  type ReserveState,
} from './kamino-lend-rules'
import {
  accountRoles,
  compileForSigning,
  computeBudget,
  createTokenAccount,
  readOnlyRpc,
  type ChainAccount,
  type SolanaRpc,
} from './stake-pool'
import { fromBaseUnits } from './tokens'

const NAME = 'Kamino Lend'
const SF_BITS = BigInt(60)
const SF = BigInt(1) << SF_BITS
const SECONDS_PER_YEAR = 31_536_000
const SOL = 'SOL'
const ZERO = BigInt(0)

/** A first SOL deposit measured 184,367 units on 5 November 2026. Each extra token adds a refresh. */
const COMPUTE_UNITS = 600_000
/** What the network takes as one transaction. Past this it won't even be simulated. */
const MAX_TRANSACTION_BYTES = 1232

/** Rent on the accounts a first deposit opens, read from live accounts on 5 November 2026. */
const OBLIGATION_RENT_LAMPORTS = BigInt(24_165_120)
const USER_METADATA_RENT_LAMPORTS = BigInt(8_073_600)
const FARM_USER_RENT_LAMPORTS = BigInt(7_294_080)

/** Interest can land between the read and the signature, so a whole SOL repay wraps a little more. */
const WHOLE_REPAY_MARGIN_DIVISOR = BigInt(1000)
const WHOLE_REPAY_MARGIN_LAMPORTS = BigInt(10_000)

function refuse(sentence: string): never {
  throw new ChainActionRefused(`${sentence} Nothing was signed or sent.`)
}

function unreadable(): never {
  throw new ChainActionRefused(
    'Solana’s network could not be read just now. Nothing was signed or sent, so try again in a moment.'
  )
}

const unexpected = (): never =>
  refuse('Kamino Lend doesn’t look as expected on chain, so I stopped.')

const AccountsReply = z.object({
  value: z.array(
    z
      .object({
        owner: z.string(),
        lamports: z.number().int().nonnegative(),
        data: z.tuple([z.string(), z.literal('base64')]),
      })
      .nullable()
  ),
})

/** Null only where the chain says no such account exists. A failed read throws. */
async function readAccounts(
  rpc: SolanaRpc,
  addresses: readonly string[]
): Promise<(ChainAccount | null)[]> {
  const reply = AccountsReply.safeParse(
    await rpc('getMultipleAccounts', [addresses, { encoding: 'base64', commitment: 'confirmed' }])
  )
  if (!reply.success || reply.data.value.length !== addresses.length) return unreadable()
  return reply.data.value.map((account) =>
    account === null
      ? null
      : {
          owner: account.owner,
          lamports: BigInt(account.lamports),
          data: bytesFromBase64(account.data[0]),
        }
  )
}

async function readReserves(
  rpc: SolanaRpc,
  addresses: readonly string[]
): Promise<Map<string, ReserveState>> {
  const accounts = addresses.length === 0 ? [] : await readAccounts(rpc, addresses)
  const reserves = new Map<string, ReserveState>()
  addresses.forEach((address, i) => {
    const account = accounts[i]
    const state =
      account === null || account === undefined || account.owner !== KLEND_PROGRAM
        ? undefined
        : decodeReserve(account.data)
    if (state === undefined || state.market !== KAMINO_MAIN_MARKET) unexpected()
    else reserves.set(address, state)
  })
  return reserves
}

interface Position {
  obligation: ObligationState | undefined
  hasMetadata: boolean
}

async function readPosition(rpc: SolanaRpc, account: string): Promise<Position> {
  const [obligation, metadata] = await readAccounts(rpc, [
    obligationAddress(account),
    userMetadataAddress(account),
  ])
  if (obligation === undefined || metadata === undefined) return unreadable()
  if (obligation === null) return { obligation: undefined, hasMetadata: metadata !== null }
  const state = obligation.owner === KLEND_PROGRAM ? decodeObligation(obligation.data) : undefined
  if (state === undefined || state.market !== KAMINO_MAIN_MARKET || state.owner !== account) {
    return unexpected()
  }
  return { obligation: state, hasMetadata: metadata !== null }
}

const reservesOf = (obligation: ObligationState | undefined): string[] => [
  ...(obligation?.deposits ?? []).map((d) => d.reserve),
  ...(obligation?.borrows ?? []).map((b) => b.reserve),
]

const uniques = (addresses: readonly string[]): string[] => [...new Set(addresses)]

/** A listed reserve as the chain has it now, refused if it isn't the token this code thinks it is. */
function checkedListing(state: ReserveState | undefined, listing: ReserveListing): ReserveState {
  if (
    state === undefined ||
    state.mint !== listing.mint ||
    state.decimals !== listing.decimals ||
    state.tokenProgram !== TOKEN_PROGRAM
  ) {
    return unexpected()
  }
  return state
}

/** Everything in the reserve that belongs to depositors, scaled. */
function depositorsSf(reserve: ReserveState): bigint {
  const total = (reserve.available << SF_BITS) + reserve.borrowedSf
  return total > reserve.feesSf ? total - reserve.feesSf : ZERO
}

function collateralToLiquiditySf(reserve: ReserveState, cTokens: bigint): bigint {
  if (reserve.collateralSupply === ZERO) return cTokens << SF_BITS
  return (cTokens * depositorsSf(reserve)) / reserve.collateralSupply
}

function liquidityToCollateralCeil(reserve: ReserveState, amount: bigint): bigint {
  const total = depositorsSf(reserve)
  if (total === ZERO || reserve.collateralSupply === ZERO) return amount
  const top = (amount << SF_BITS) * reserve.collateralSupply
  return (top + total - BigInt(1)) / total
}

/** What can leave now: the pool's cash, less what is already queued to leave. */
function readyLiquidity(reserve: ReserveState): bigint {
  const queued = collateralToLiquiditySf(reserve, reserve.queuedCollateral) >> SF_BITS
  return reserve.available > queued ? reserve.available - queued : ZERO
}

function utilization(reserve: ReserveState): number {
  const total = depositorsSf(reserve)
  if (total === ZERO) return 0
  return Number((reserve.borrowedSf * BigInt(1_000_000)) / total) / 1_000_000
}

/** The rate from the reserve's own curve, as a yearly fraction, before the fixed part on top. */
function curveRate(reserve: ReserveState): number {
  const used = Math.min(utilization(reserve), 1) * 10_000
  for (let i = 1; i < reserve.curve.length; i += 1) {
    const [startUsed, startRate] = reserve.curve[i - 1] as readonly [number, number]
    const [endUsed, endRate] = reserve.curve[i] as readonly [number, number]
    if (used <= endUsed) {
      if (endUsed === startUsed) return endRate / 10_000
      return (
        (startRate + ((used - startUsed) / (endUsed - startUsed)) * (endRate - startRate)) / 10_000
      )
    }
  }
  return (reserve.curve.at(-1)?.[1] ?? 0) / 10_000
}

const borrowApr = (reserve: ReserveState): number =>
  curveRate(reserve) + reserve.hostFixedBps / 10_000

/** Interest compounds on every update, close enough to continuously for a yearly figure. */
const yearly = (apr: number): number => (Math.exp(apr) - 1) * 100

function supplyPercent(reserve: ReserveState): number {
  return yearly(curveRate(reserve) * utilization(reserve) * (1 - reserve.takeRatePct / 100))
}

/** The debt now: the record grown by the reserve's running rate, then by the time since its update. */
function owedSf(borrowed: ObligationBorrow, reserve: ReserveState): bigint {
  const recorded =
    borrowed.cumulativeBorrowRateBsf === ZERO
      ? borrowed.borrowedSf
      : (borrowed.borrowedSf * reserve.cumulativeBorrowRateBsf) / borrowed.cumulativeBorrowRateBsf
  const elapsed = Math.max(Date.now() / 1000 - reserve.lastUpdateSeconds, 0)
  const growth = Math.ceil((borrowApr(reserve) * elapsed * 1e12) / SECONDS_PER_YEAR)
  return recorded + (recorded * BigInt(growth)) / BigInt(1e12)
}

const ceilToUnits = (sf: bigint): bigint => (sf + SF - BigInt(1)) >> SF_BITS

/** Dollars, scaled, for an amount in base units, also scaled. */
function valueSf(amountSf: bigint, reserve: ReserveState): bigint {
  return (amountSf * reserve.priceSf) / ((BigInt(10) ** BigInt(reserve.decimals)) << SF_BITS)
}

const dollars = (sf: bigint): number => Number((sf * BigInt(100)) >> SF_BITS) / 100

const money = (sf: bigint): string =>
  `$${dollars(sf).toLocaleString('en-US', { maximumFractionDigits: 2 })}`

function displayDown(amount: bigint, decimals: number): string {
  const places = Math.min(decimals, 2)
  const step = BigInt(10) ** BigInt(decimals - places)
  return fromBaseUnits(((amount / step) * step).toString(), decimals)
}

const percentText = (value: number): string =>
  `${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}%`

interface Health {
  depositedSf: bigint
  /** What the chain lets this position owe when borrowing, risk weight included. */
  allowedSf: bigint
  /** What it may owe before anyone can sell its collateral. */
  liquidationSf: bigint
  /** What it owes now, risk weight included. */
  weightedDebtSf: bigint
  plainDebtSf: bigint
}

/** The sums `refresh_obligation` does on chain, from what the reserves last recorded. */
function healthOf(
  obligation: ObligationState,
  reserves: ReadonlyMap<string, ReserveState>
): Health {
  let depositedSf = ZERO
  let allowedSf = ZERO
  let liquidationSf = ZERO
  for (const { reserve: address, cTokens } of obligation.deposits) {
    const reserve = reserves.get(address)
    if (reserve === undefined) return unexpected()
    const value = valueSf(collateralToLiquiditySf(reserve, cTokens), reserve)
    depositedSf += value
    allowedSf += (value * BigInt(reserve.ltvPct)) / BigInt(100)
    liquidationSf += (value * BigInt(reserve.liquidationPct)) / BigInt(100)
  }
  let weightedDebtSf = ZERO
  let plainDebtSf = ZERO
  for (const borrowed of obligation.borrows) {
    const reserve = reserves.get(borrowed.reserve)
    if (reserve === undefined) return unexpected()
    const value = valueSf(owedSf(borrowed, reserve), reserve)
    plainDebtSf += value
    weightedDebtSf += (value * reserve.borrowFactorPct) / BigInt(100)
  }
  return { depositedSf, allowedSf, liquidationSf, weightedDebtSf, plainDebtSf }
}

function originationFee(reserve: ReserveState, amount: bigint): bigint {
  return (amount * reserve.originationSf) >> SF_BITS
}

/** Whole base units of the token that fit in what this position may still borrow. */
function maxBorrow(health: Health, reserve: ReserveState): bigint {
  if (health.allowedSf <= health.weightedDebtSf) return ZERO
  if (reserve.priceSf === ZERO || reserve.borrowFactorPct === ZERO) return ZERO
  const roomSf = health.allowedSf - health.weightedDebtSf
  const withWeight = (roomSf * BigInt(100)) / reserve.borrowFactorPct
  const base = (withWeight * BigInt(10) ** BigInt(reserve.decimals)) / reserve.priceSf
  return (base * SF) / (SF + reserve.originationSf)
}

/** The program's error names, as a person needs to hear them. */
const WHY_IT_FAILED: Readonly<Record<string, string>> = {
  BorrowTooLarge: 'That is more than this position can support at the prices on chain right now.',
  WorseLtvThanUnhealthyLtv:
    'That is more than this position can support at the prices on chain right now.',
  LiabilitiesBiggerThanAssets:
    'That is more than this position can support at the prices on chain right now.',
  BorrowLimitExceeded: 'Kamino has reached its limit on lending this token.',
  ElevationGroupBorrowLimitExceeded: 'Kamino has reached its limit on lending this token.',
  BorrowingAboveUtilizationRateDisabled:
    'So much of this token is already lent out that Kamino has stopped new loans of it for now.',
  BorrowTooSmall: 'That loan is too small for Kamino to open.',
  NetValueRemainingTooSmall: 'Kamino won’t leave a loan or position that small.',
  BorrowingDisabled: 'Kamino has stopped new loans on this market for now.',
  BorrowingDisabledOutsideElevationGroup: 'Kamino has stopped new loans of this kind for now.',
  ObligationCurrentlyMarkedForDeleveraging:
    'Kamino has marked this position to be reduced, so it won’t lend more against it.',
  ObligationInObsoleteReserve:
    'This position holds a token Kamino is retiring. Take that out first.',
  WithdrawTooLarge: 'That would leave your loan above what the rest of the position can support.',
  MaximumWithdrawValueZero: 'Your loan needs everything you have supplied here right now.',
  WithdrawalCapReached: 'Kamino has hit its limit on money leaving this pool for now.',
  InsufficientLiquidity: 'The pool doesn’t have that much ready right now.',
  DepositLimitExceeded: 'This pool at Kamino is full right now.',
  ObligationReserveLimit: 'This position already holds as many tokens as Kamino allows.',
  ReserveStale: 'Kamino’s price for this token is out of date, so it won’t act on it just now.',
  ObligationStale: 'Kamino’s price for this token is out of date, so it won’t act on it just now.',
  PriceTooOld: 'Kamino’s price for this token is out of date, so it won’t act on it just now.',
  PriceNotValid: 'Kamino’s price for this token is out of date, so it won’t act on it just now.',
  GlobalEmergencyMode: 'Kamino has paused this market.',
}

const SimulationReply = z.object({
  value: z.object({ err: z.unknown().nullable(), logs: z.array(z.string()).nullable().optional() }),
})

function failureText(logs: readonly string[], symbol: string): string {
  for (const log of logs) {
    const named = /Error Code: (\w+)/.exec(log)?.[1]
    const why = named === undefined ? undefined : WHY_IT_FAILED[named]
    if (why !== undefined) return why
  }
  // SPL Token's and the System Program's own words for an empty balance.
  if (
    logs.some((log) =>
      /insufficient funds|insufficient lamports|custom program error: 0x1\b/.test(log)
    )
  ) {
    return `You don’t hold enough ${symbol} for this, with the SOL its fee and setup need.`
  }
  return 'Kamino’s program would reject this right now.'
}

/**
 * The program's own answer, run by the network with nothing signed. The sums above give a person a
 * reason in words, but only the program knows every limit, and a transaction it rejects costs a fee.
 */
async function assertWouldRun(rpc: SolanaRpc, transaction: string, symbol: string): Promise<void> {
  const reply = SimulationReply.safeParse(
    await rpc('simulateTransaction', [
      transaction,
      {
        encoding: 'base64',
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: 'confirmed',
      },
    ])
  )
  if (!reply.success) return unreadable()
  if (reply.data.value.err !== null) {
    refuse(failureText(reply.data.value.logs ?? [], symbol))
  }
}

const SYSTEM_TRANSFER_TAG = 2
const SYNC_NATIVE_TAG = 17
const CLOSE_ACCOUNT_TAG = 9

/** Wrapped SOL is what the reserve holds, so SOL becomes it first, in the person's own account. */
function wrapSol(account: string, lamports: bigint): Instruction[] {
  const own = ownWrappedSolAccount(account)
  const bytes = new Uint8Array(12)
  bytes[0] = SYSTEM_TRANSFER_TAG
  new DataView(bytes.buffer).setBigUint64(4, lamports, true)
  return [
    {
      programAddress: SYSTEM_PROGRAM as never,
      accounts: [accountRoles.signer(account), accountRoles.writable(own)],
      data: bytes,
    },
    {
      programAddress: TOKEN_PROGRAM as never,
      accounts: [accountRoles.writable(own)],
      data: Uint8Array.of(SYNC_NATIVE_TAG),
    },
  ]
}

function unwrapSol(account: string): Instruction {
  return {
    programAddress: TOKEN_PROGRAM as never,
    accounts: [
      accountRoles.writable(ownWrappedSolAccount(account)),
      accountRoles.writable(account),
      accountRoles.signer(account),
    ],
    data: Uint8Array.of(CLOSE_ACCOUNT_TAG),
  }
}

const KINDS = ['supply', 'withdraw', 'borrow', 'repay'] as const

export interface KaminoLendOptions {
  env?: Record<string, string | undefined>
  rpc?: SolanaRpc
}

export function createKaminoLendVenue(options: KaminoLendOptions = {}): ChainVenue {
  const rpc = options.rpc ?? readOnlyRpc(options.env)

  /** The reward farm record this step needs, opened in the same transaction if it isn't yet. */
  async function farmSetup(
    account: string,
    reserve: string,
    farm: string,
    mode: number
  ): Promise<{ farm: string | undefined; setup: Instruction[]; opened: boolean }> {
    if (farm === SYSTEM_PROGRAM) return { farm: undefined, setup: [], opened: false }
    const [record] = await readAccounts(rpc, [
      farmUserStateAddress(farm, obligationAddress(account)),
    ])
    if (record === undefined) return unreadable()
    return record === null
      ? { farm, setup: [initObligationFarms(account, reserve, farm, mode)], opened: true }
      : { farm, setup: [], opened: false }
  }

  /** Every reserve refreshed in this slot, then the position, since each step refuses stale figures. */
  function refreshes(
    account: string,
    obligation: ObligationState | undefined,
    reserves: ReadonlyMap<string, ReserveState>,
    actionReserve: string
  ): Instruction[] {
    const refreshed = uniques([...reservesOf(obligation), actionReserve]).map((address) => {
      const reserve = reserves.get(address)
      return reserve === undefined ? unexpected() : refreshReserve(address, reserve)
    })
    const referrer = obligation?.referrer
    const records =
      referrer === undefined
        ? []
        : (obligation?.borrows ?? []).map((b) => referrerTokenStateAddress(referrer, b.reserve))
    return [...refreshed, refreshObligation(account, [...reservesOf(obligation), ...records])]
  }

  async function compile(
    account: string,
    instructions: readonly Instruction[],
    symbol: string
  ): Promise<string> {
    const transaction = await compileForSigning(rpc, account, [
      ...computeBudget(COMPUTE_UNITS),
      ...instructions,
    ])
    if (bytesFromBase64(transaction).length > MAX_TRANSACTION_BYTES) {
      refuse(
        'This position holds too many tokens to fit in one transaction. Use Kamino’s own site for this one.'
      )
    }
    await assertWouldRun(rpc, transaction, symbol)
    return transaction
  }

  function exitNote(reserve: ReserveState): string {
    return `Today about ${percentText(utilization(reserve) * 100)} of this pool is lent out. What isn’t lent comes back at once. Past that, you wait until borrowers repay or others deposit.`
  }

  function risksNote(): string {
    return 'Your money sits in Kamino’s lending program, which Kamino can upgrade, and prices come from an oracle Kamino runs. A market failure or a program fault could lose you money, and Kamino can change this market’s limits.'
  }

  /** A person can't tell from a figure that a step also costs rent, so each step that does says so. */
  function setupNotes(opened: boolean, opensTokenAccount: boolean): string[] {
    return [
      ...(opened
        ? [
            'This also pays about 0.0073 SOL for a reward record on this pool, which stays in Kamino’s records.',
          ]
        : []),
      ...(opensTokenAccount
        ? ['If your wallet has no account for this token yet, opening one costs about 0.002 SOL.']
        : []),
    ]
  }

  /** SOL goes through the person's own wrapped account, and closing it returns all it holds. */
  const WRAPPED_NOTE =
    'Any wrapped SOL already in your wallet comes back as plain SOL in the same step.'

  async function prepareSupply(
    request: ChainActionRequest,
    account: string,
    listing: ReserveListing
  ): Promise<PreparedAction> {
    const amount = BigInt(toBaseUnits(request.amount, listing.decimals))
    const { obligation, hasMetadata } = await readPosition(rpc, account)
    const reserves = await readReserves(rpc, uniques([...reservesOf(obligation), listing.reserve]))
    const reserve = checkedListing(reserves.get(listing.reserve), listing)
    if (reserve.status !== 0) {
      return refuse(`Kamino Lend isn’t taking ${listing.symbol} any more.`)
    }

    const isSol = listing.symbol === SOL
    const { farm, setup, opened } = await farmSetup(
      account,
      listing.reserve,
      reserve.farmCollateral,
      FARM_COLLATERAL
    )
    const transaction = await compile(
      account,
      [
        ...(isSol ? [createTokenAccount(account, listing.mint), ...wrapSol(account, amount)] : []),
        ...(hasMetadata ? [] : [initUserMetadata(account)]),
        ...(obligation === undefined ? [initObligation(account)] : []),
        ...setup,
        ...refreshes(account, obligation, reserves, listing.reserve),
        deposit({ account, reserve: listing.reserve, state: reserve, farm, amount }),
        ...(isSol ? [unwrapSol(account)] : []),
      ],
      listing.symbol
    )

    const rent =
      (hasMetadata ? ZERO : USER_METADATA_RENT_LAMPORTS) +
      (obligation === undefined ? OBLIGATION_RENT_LAMPORTS : ZERO) +
      (opened ? FARM_USER_RENT_LAMPORTS : ZERO)
    const percent = supplyPercent(reserve)
    return {
      venueId: 'kamino-lend',
      venueName: NAME,
      kind: 'supply',
      summary: `Supply ${request.amount} ${listing.symbol} to Kamino Lend, where it earns from borrowers and can back a loan you take.`,
      pay: { amount: request.amount, symbol: listing.symbol },
      ...(percent > 0 ? { apy: { basePercent: percent } } : {}),
      notes: [
        reserve.ltvPct > 0
          ? `This is Kamino Lend, not Kamino Earn. ${listing.symbol} supplied here can back a loan, for up to ${reserve.ltvPct}% of its value. Money in a Kamino Earn vault can’t back a loan.`
          : `This is Kamino Lend, not Kamino Earn. Kamino doesn’t let ${listing.symbol} back a loan today, so this only earns.`,
        'The rate is today’s, worked out from the pool’s own settings on chain. It moves with borrowing and leaves out any reward programs.',
        `${exitNote(reserve)} While you have a loan, you can only take out what keeps the loan within its limits.`,
        ...(isSol ? [WRAPPED_NOTE] : []),
        ...(rent === ZERO
          ? []
          : [
              `This opens your position, which holds about ${fromBaseUnits(rent.toString(), 9).slice(0, 6)} SOL as account rent. ${obligation === undefined ? 'About 0.0242 SOL of it comes back when you empty the position. The rest stays in Kamino’s records.' : 'It stays in Kamino’s records.'}`,
            ]),
        risksNote(),
      ],
      signing: { family: 'solana', transaction },
    }
  }

  async function prepareWithdraw(
    request: ChainActionRequest,
    account: string,
    listing: ReserveListing
  ): Promise<PreparedAction> {
    const asked = BigInt(toBaseUnits(request.amount, listing.decimals))
    const { obligation } = await readPosition(rpc, account)
    const held = obligation?.deposits.find((d) => d.reserve === listing.reserve)
    if (obligation === undefined || held === undefined) {
      return refuse(`You have no ${listing.symbol} on Kamino Lend to withdraw.`)
    }
    const reserves = await readReserves(rpc, reservesOf(obligation))
    const reserve = checkedListing(reserves.get(listing.reserve), listing)
    const heldUnits = collateralToLiquiditySf(reserve, held.cTokens) >> SF_BITS
    const whole = request.wholePosition === true

    if (whole && obligation.borrows.length > 0) {
      const owed = obligation.borrows
        .map((b) => {
          const debtReserve = reserves.get(b.reserve)
          if (debtReserve === undefined) return unexpected()
          const units = ceilToUnits(owedSf(b, debtReserve)).toString()
          const symbol = reserveByAddress(b.reserve)?.symbol ?? debtReserve.name
          return `${fromBaseUnits(units, debtReserve.decimals)} ${symbol}`
        })
        .join(' and ')
      return refuse(
        `You still owe ${owed} on Kamino Lend, and what you supplied backs that loan. Repay it first, or name a smaller amount to withdraw.`
      )
    }
    if (!whole && asked > heldUnits) {
      return refuse(
        `You have ${fromBaseUnits(heldUnits.toString(), listing.decimals)} ${listing.symbol} on Kamino Lend, which is less than ${request.amount}. Say "withdraw all ${listing.symbol}" for all of it.`
      )
    }
    const leaving = whole ? heldUnits : asked
    const ready = readyLiquidity(reserve)
    if (leaving > ready) {
      return refuse(
        `Kamino’s ${listing.symbol} pool has only ${displayDown(ready, listing.decimals)} ${listing.symbol} ready right now, since the rest is lent out. More comes back as borrowers repay. Try a smaller amount or try again later.`
      )
    }

    const cTokens = whole
      ? U64_MAX
      : (() => {
          const needed = liquidityToCollateralCeil(reserve, asked)
          return needed > held.cTokens ? held.cTokens : needed
        })()
    const isSol = listing.symbol === SOL
    const { farm, setup, opened } = await farmSetup(
      account,
      listing.reserve,
      reserve.farmCollateral,
      FARM_COLLATERAL
    )
    const transaction = await compile(
      account,
      [
        createTokenAccount(account, listing.mint),
        ...setup,
        ...refreshes(account, obligation, reserves, listing.reserve),
        withdraw({ account, reserve: listing.reserve, state: reserve, farm, amount: cTokens }),
        ...(isSol ? [unwrapSol(account)] : []),
      ],
      listing.symbol
    )

    const emptied = whole && obligation.borrows.length === 0 && obligation.deposits.length === 1
    return {
      venueId: 'kamino-lend',
      venueName: NAME,
      kind: 'withdraw',
      summary: whole
        ? `Withdraw all your ${listing.symbol} from Kamino Lend, including interest earned up to the moment it lands, to your wallet.`
        : `Withdraw ${request.amount} ${listing.symbol} from Kamino Lend to your wallet.`,
      pay: { amount: request.amount, symbol: listing.symbol },
      receive: { amount: request.amount, symbol: listing.symbol, approximate: true },
      notes: [
        whole
          ? 'This empties the position exactly, so no interest is left behind. The figure above was read a moment ago and will be a little higher when it lands.'
          : 'What you get can be a tiny bit over this figure, since it is worked out from the pool’s rate when this lands.',
        ...(emptied
          ? [
              'This closes your Kamino Lend position, and about 0.0242 SOL of account rent comes back to you.',
            ]
          : []),
        ...setupNotes(opened, !isSol),
        ...(isSol ? [WRAPPED_NOTE] : []),
        exitNote(reserve),
      ],
      signing: { family: 'solana', transaction },
    }
  }

  async function prepareBorrow(
    request: ChainActionRequest,
    account: string,
    listing: ReserveListing
  ): Promise<PreparedAction> {
    const amount = BigInt(toBaseUnits(request.amount, listing.decimals))
    const { obligation } = await readPosition(rpc, account)
    const reserves = await readReserves(rpc, uniques([...reservesOf(obligation), listing.reserve]))
    const reserve = checkedListing(reserves.get(listing.reserve), listing)
    if (reserve.status !== 0 || reserve.borrowLimit === ZERO) {
      return refuse(`${listing.symbol} can’t be borrowed on Kamino Lend.`)
    }
    if (obligation === undefined || obligation.deposits.length === 0) {
      return refuse(
        `A loan needs something behind it first, and you have nothing supplied on Kamino Lend. Say "supply 100 USDC on Kamino Lend", then borrow against it. Money in a Kamino Earn vault can’t back a loan.`
      )
    }
    if (obligation.elevationGroup !== 0) {
      return refuse(
        'This position uses one of Kamino’s special modes, whose limits I don’t check here, so I won’t size a loan on it. Use Kamino’s own site for this one.'
      )
    }

    const health = healthOf(obligation, reserves)
    const most = maxBorrow(health, reserve)
    if (amount > most) {
      return refuse(
        most === ZERO
          ? 'What you have supplied can’t support any more borrowing at today’s prices.'
          : `What you have supplied can support at most about ${displayDown(most, listing.decimals)} ${listing.symbol} more at today’s prices, which is less than ${request.amount}.`
      )
    }
    const fee = originationFee(reserve, amount)
    const taken = amount + fee
    if (taken > readyLiquidity(reserve)) {
      return refuse(
        `Kamino has only ${displayDown(readyLiquidity(reserve), listing.decimals)} ${listing.symbol} ready to lend right now.`
      )
    }
    const room = reserve.borrowLimit - (reserve.borrowedSf >> SF_BITS)
    if (taken > room) {
      return refuse(`Kamino has reached its limit on lending ${listing.symbol} for now.`)
    }

    const isSol = listing.symbol === SOL
    const { farm, setup, opened } = await farmSetup(
      account,
      listing.reserve,
      reserve.farmDebt,
      FARM_DEBT
    )
    const transaction = await compile(
      account,
      [
        createTokenAccount(account, listing.mint),
        ...setup,
        ...refreshes(account, obligation, reserves, listing.reserve),
        borrow(
          { account, reserve: listing.reserve, state: reserve, farm, amount },
          obligation.referrer
        ),
        ...(isSol ? [unwrapSol(account)] : []),
      ],
      listing.symbol
    )

    const addedSf = valueSf(taken << SF_BITS, reserve)
    const plainDebtSf = health.plainDebtSf + addedSf
    const weightedDebtSf = health.weightedDebtSf + (addedSf * reserve.borrowFactorPct) / BigInt(100)
    const fall =
      health.liquidationSf === ZERO
        ? 0
        : Number(
            ((health.liquidationSf - weightedDebtSf) * BigInt(10_000)) / health.liquidationSf
          ) / 100
    const deposits = obligation.deposits.flatMap((d) => {
      const state = reserves.get(d.reserve)
      return state === undefined ? [] : [state]
    })
    const bonusLow = Math.min(...deposits.map((d) => d.minBonusBps)) / 100
    const bonusHigh = Math.max(...deposits.map((d) => d.maxBonusBps)) / 100
    const weighted = weightedDebtSf !== plainDebtSf
    return {
      venueId: 'kamino-lend',
      venueName: NAME,
      kind: 'borrow',
      summary: `Borrow ${request.amount} ${listing.symbol} from Kamino Lend against what you have supplied there, paid to your own wallet.`,
      pay: { amount: request.amount, symbol: listing.symbol },
      notes: [
        `After this you would owe about ${money(plainDebtSf)} against ${money(health.depositedSf)} of collateral. ${weighted ? `Kamino counts some debts at more than their value when it checks a loan, which makes this ${money(weightedDebtSf)} by its count. If that count reaches` : 'If what you owe reaches'} ${money(health.liquidationSf)}, anyone can sell your collateral to clear part of it, and you lose what is sold plus a bonus of about ${percentText(bonusLow)} to ${percentText(bonusHigh)} paid to whoever does it. At today’s prices that happens if your collateral falls about ${percentText(Math.max(fall, 0))} against what you owe.`,
        `You would pay about ${percentText(yearly(borrowApr(reserve)))} a year today, read from the pool on chain. The rate rises as more of the pool is lent out, and interest keeps adding to what you owe, which moves you closer to that line.`,
        fee > ZERO
          ? `Kamino adds an opening fee of ${fromBaseUnits(fee.toString(), listing.decimals)} ${listing.symbol} to your debt.`
          : 'Kamino charges no opening fee on this loan today.',
        ...setupNotes(opened, !isSol),
        ...(isSol ? [WRAPPED_NOTE] : []),
        `To pay it back, say "repay ${request.amount} ${listing.symbol} on Kamino Lend" or "repay all ${listing.symbol}". Kamino’s market owner can also mark a loan to be reduced by force after a warning period.`,
        risksNote(),
      ],
      signing: { family: 'solana', transaction },
    }
  }

  async function prepareRepay(
    request: ChainActionRequest,
    account: string,
    listing: ReserveListing
  ): Promise<PreparedAction> {
    const asked = BigInt(toBaseUnits(request.amount, listing.decimals))
    const { obligation } = await readPosition(rpc, account)
    const debt = obligation?.borrows.find((b) => b.reserve === listing.reserve)
    if (obligation === undefined || debt === undefined) {
      return refuse(`You have no ${listing.symbol} loan on Kamino Lend to repay.`)
    }
    const reserves = await readReserves(rpc, reservesOf(obligation))
    const reserve = checkedListing(reserves.get(listing.reserve), listing)
    const owed = ceilToUnits(owedSf(debt, reserve))
    const whole = request.wholePosition === true
    if (!whole && asked > owed) {
      return refuse(
        `You owe ${fromBaseUnits(owed.toString(), listing.decimals)} ${listing.symbol} on Kamino Lend, which is less than ${request.amount}. Say "repay all ${listing.symbol}" to clear it.`
      )
    }

    const isSol = listing.symbol === SOL
    const wrap = whole
      ? owed + owed / WHOLE_REPAY_MARGIN_DIVISOR + WHOLE_REPAY_MARGIN_LAMPORTS
      : asked
    const { farm, setup, opened } = await farmSetup(
      account,
      listing.reserve,
      reserve.farmDebt,
      FARM_DEBT
    )
    const transaction = await compile(
      account,
      [
        ...(isSol ? [createTokenAccount(account, listing.mint), ...wrapSol(account, wrap)] : []),
        ...setup,
        ...refreshes(account, obligation, reserves, listing.reserve),
        repay(
          {
            account,
            reserve: listing.reserve,
            state: reserve,
            farm,
            amount: whole ? U64_MAX : asked,
          },
          obligation.elevationGroup === 0 ? [] : obligation.deposits.map((d) => d.reserve)
        ),
        ...(isSol ? [unwrapSol(account)] : []),
      ],
      listing.symbol
    )

    return {
      venueId: 'kamino-lend',
      venueName: NAME,
      kind: 'repay',
      summary: whole
        ? `Repay all of your ${listing.symbol} loan on Kamino Lend, with the interest owed up to the moment it lands.`
        : `Repay ${request.amount} ${listing.symbol} of your loan on Kamino Lend.`,
      pay: { amount: request.amount, symbol: listing.symbol },
      notes: [
        whole
          ? `This clears the debt exactly, interest included, so your wallet needs a little over the figure above.${isSol ? ' Any SOL set aside and not needed comes straight back.' : ''}`
          : 'What you still owe keeps earning interest, and your collateral stays locked behind it.',
        'What you supplied doesn’t come back by itself. Say "withdraw" when you want it out.',
        ...setupNotes(opened, false),
        ...(isSol ? [WRAPPED_NOTE] : []),
      ],
      signing: { family: 'solana', transaction },
    }
  }

  async function quote(request: ChainActionRequest, account: string): Promise<VenueQuote> {
    if (!isAddress(account)) throw new ChainActionRefused('That is not a Solana wallet address.')
    if (request.kind !== 'supply') {
      return refuse(`Kamino Lend can only price a supply here, not a ${request.kind}.`)
    }
    const listing = reserveListing(request.tokenIn)
    const reserves = await readReserves(rpc, [listing.reserve])
    const percent = supplyPercent(checkedListing(reserves.get(listing.reserve), listing))
    return quotedApy(percent > 0 ? { basePercent: percent } : undefined)
  }

  async function positions(account: string): Promise<VenuePosition[]> {
    const { obligation } = await readPosition(rpc, account)
    if (obligation === undefined) return []
    const reserves = await readReserves(rpc, uniques(reservesOf(obligation)))
    const label = (address: string, reserve: ReserveState): string =>
      reserveByAddress(address)?.symbol ?? `${reserve.name} (not listed here)`
    const read = (address: string): ReserveState => reserves.get(address) ?? unexpected()
    return [
      ...obligation.deposits.map(({ reserve: address, cTokens }): VenuePosition => {
        const reserve = read(address)
        const units = collateralToLiquiditySf(reserve, cTokens) >> SF_BITS
        return {
          slot: 'supplied',
          symbol: label(address, reserve),
          amount: fromBaseUnits(units.toString(), reserve.decimals),
        }
      }),
      ...obligation.borrows.map((borrowed): VenuePosition => {
        const reserve = read(borrowed.reserve)
        return {
          slot: 'borrowed',
          symbol: label(borrowed.reserve, reserve),
          amount: fromBaseUnits(
            ceilToUnits(owedSf(borrowed, reserve)).toString(),
            reserve.decimals
          ),
        }
      }),
    ]
  }

  return {
    id: 'kamino-lend',
    name: NAME,
    kinds: KINDS,
    assertCanFollow: takesOnly(
      NAME,
      KAMINO_LEND_RESERVES.map((r) => r.symbol)
    ),
    quote,
    positions,
    prepare: async (request, account) => {
      if (!isAddress(account)) throw new ChainActionRefused('That is not a Solana wallet address.')
      const listing = reserveListing(request.tokenIn)
      switch (request.kind) {
        case 'supply':
          return prepareSupply(request, account, listing)
        case 'withdraw':
          return prepareWithdraw(request, account, listing)
        case 'borrow':
          return prepareBorrow(request, account, listing)
        case 'repay':
          return prepareRepay(request, account, listing)
        default:
          return refuse(
            `Kamino Lend here can supply, withdraw, borrow and repay, not ${request.kind}.`
          )
      }
    },
    assertSafe: assertKaminoLendSafe,
  }
}
