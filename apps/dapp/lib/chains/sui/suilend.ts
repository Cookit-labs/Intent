import { coinWithBalance, Transaction } from '@mysten/sui/transactions'
import { fromBase64 } from '@mysten/sui/utils'

import {
  quotedApy,
  takesOnly,
  tokenBySymbol,
  toBaseUnits,
  type ChainActionRequest,
  type ChainToken,
  type ChainVenue,
  type PreparedAction,
  type SigningPayload,
  type VenuePosition,
  type VenueQuote,
} from '../types'
import { assertSuiAccount, buildUnsigned, suiClient } from './client'
import {
  assertBorrowFits,
  assertCallsPinned,
  assertPricesFresh,
  assertWithdrawFits,
  borrowNotes,
  coinTypeName,
  dryRunChange,
  gaveWhatWasAsked,
  pinnedPolicy,
  pythObjectForFeed,
  readPythObject,
  refuse,
  repayCoinAmount,
  u64Bytes,
  walletBalance,
  withdrawLoanNote,
  type LoanStanding,
  type PinnedCall,
  type PinnedCalls,
  type PythReading,
} from './lending-calls'
import { poolNotes } from './navi-rules'
import { assertPtbSafe, moveTarget } from './safety'
import { displayAmount, SUI_TOKENS } from './tokens'

/**
 * `_generated/_envs/mainnet.js` and `client.js` of @suilend/sdk 14.2.1. On chain, the
 * UpgradeCap below names this package at version 25, and `lending_market`'s signatures
 * were read from it. The market's `version` field is 7, the version this package was
 * built for. The SDK says market version 8 will follow: then every call here aborts,
 * so the dry run refuses until someone checks the new package.
 */
export const SUILEND_PACKAGE = '0x59672975e15c58ffc9450f5236b6aa9fa2407d94b8081e634778aa01957d8c6f'
export const SUILEND_ORIGINAL_PACKAGE =
  '0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf'
export const SUILEND_UPGRADE_CAP =
  '0x3d4ef1859c3ee9fc72858f588b56a09da5466e64f8cc4e90a7b3b909fba8a7ae'
/** `LENDING_MARKET_ID` in the SDK. On chain, a shared `LendingMarket<MAIN_POOL>`. */
export const SUILEND_MARKET = '0x84030d26d85eaa7035084a057f2f11f701b7e2e4eda87551becbc7c97505ece1'
export const SUILEND_MAIN_POOL = `${SUILEND_ORIGINAL_PACKAGE}::suilend::MAIN_POOL`
/** Read from the market's `reserves`: the entry whose `coin_type` is native USDC. Reserves only append. */
export const SUILEND_USDC_RESERVE = 7
/** The listed tokens, at the index of the entry in `reserves` whose `coin_type` is that token. */
export const SUILEND_RESERVES: Readonly<Record<string, number>> = {
  SUI: 0,
  USDC: SUILEND_USDC_RESERVE,
  sSUI: 10,
  USDT: 19,
  WAL: 28,
  USDsui: 44,
}

const SUI_SYSTEM = '0x0000000000000000000000000000000000000000000000000000000000000005'
const CAP_TYPE = `${SUILEND_ORIGINAL_PACKAGE}::lending_market::ObligationOwnerCap<${SUILEND_MAIN_POOL}>`
const WAD = BigInt('1000000000000000000')
const MAX_CAP_PAGES = 5
const SECONDS_PER_YEAR = 31_536_000
/** `MAX_STALENESS_SECONDS` in Suilend's `oracles.move`. */
const PRICE_LIMIT_SECONDS = 60

const USDC = SUI_TOKENS.find((t) => t.symbol === 'USDC')
if (USDC === undefined) throw new Error('USDC is missing from the Sui token table.')
const USDC_TYPE = USDC.id
const USDC_NAME = coinTypeName(USDC_TYPE)
const USDC_TYPES = [SUILEND_MAIN_POOL, USDC_TYPE]
const USDC_RESERVE_BYTES = u64Bytes(SUILEND_USDC_RESERVE)

function fn(name: string): string {
  return moveTarget(SUILEND_PACKAGE, 'lending_market', name)
}

function listedToken(symbol: string): ChainToken {
  const token = SUI_TOKENS.find((t) => t.symbol === symbol)
  if (token === undefined) throw new Error(`${symbol} is missing from the Sui token table.`)
  return token
}

const LISTED = Object.entries(SUILEND_RESERVES).map(([symbol, reserve]) => ({
  symbol,
  reserve,
  type: listedToken(symbol).id,
}))

function exemptionType(coinType: string): string {
  return `${SUILEND_ORIGINAL_PACKAGE}::lending_market::RateLimiterExemption<${SUILEND_MAIN_POOL}, ${coinType}>`
}

function perToken(argumentCount: number): readonly PinnedCall[] {
  return LISTED.map(({ reserve, type }) => ({
    typeArguments: [SUILEND_MAIN_POOL, type],
    argumentCount,
    objects: { 0: SUILEND_MARKET },
    pure: { 1: u64Bytes(reserve) },
  }))
}

const marketOnly = (argumentCount: number): PinnedCall => ({
  typeArguments: [SUILEND_MAIN_POOL],
  argumentCount,
  objects: { 0: SUILEND_MARKET },
})

const REPAY = fn('repay')
const OBLIGATION_ID = fn('obligation_id')

/**
 * Nothing here can credit anyone but the signer: every call that touches a position
 * takes the owner cap, which only its holder can pass. `repay` takes a bare obligation
 * id, so it could pay down a stranger's loan: `assertRepaysOwnLoan` requires that id to
 * come from the signer's own cap. A price refresh moves no money, and the contract checks
 * the object against the reserve's feed, so the price object itself isn't pinned.
 */
const PINS: PinnedCalls = new Map<string, PinnedCall | readonly PinnedCall[]>([
  [fn('create_obligation'), marketOnly(1)],
  [
    fn('deposit_liquidity_and_mint_ctokens'),
    {
      typeArguments: USDC_TYPES,
      argumentCount: 4,
      objects: { 0: SUILEND_MARKET },
      pure: { 1: USDC_RESERVE_BYTES },
    },
  ],
  [
    fn('deposit_ctokens_into_obligation'),
    {
      typeArguments: USDC_TYPES,
      argumentCount: 5,
      objects: { 0: SUILEND_MARKET },
      pure: { 1: USDC_RESERVE_BYTES },
    },
  ],
  [fn('withdraw_ctokens'), perToken(5)],
  [fn('redeem_ctokens_and_withdraw_liquidity_request'), perToken(5)],
  [fn('fulfill_liquidity_request'), perToken(3)],
  [fn('borrow_request'), perToken(5)],
  [REPAY, perToken(5)],
  [OBLIGATION_ID, { typeArguments: [SUILEND_MAIN_POOL], argumentCount: 1 }],
  [fn('refresh_reserve_price_pro_compatible'), marketOnly(4)],
  // A lending pool's SUI can be staked, and this brings back what a request needs.
  [
    fn('unstake_sui_from_staker'),
    {
      typeArguments: [SUILEND_MAIN_POOL],
      argumentCount: 4,
      objects: { 0: SUILEND_MARKET, 3: SUI_SYSTEM },
      pure: { 1: u64Bytes(SUILEND_RESERVES['SUI'] ?? 0) },
    },
  ],
  // The redeem's rate-limit exemption, as none. A real one only comes from a liquidation.
  [
    moveTarget('0x1', 'option', 'none'),
    LISTED.map(({ type }) => ({ typeArguments: [exemptionType(type)], argumentCount: 0 })),
  ],
])

export const SUILEND_POLICY = pinnedPolicy('Suilend', PINS)

/** A repay's obligation id must be the result of reading the signer's own cap, in this transaction. */
export function assertRepaysOwnLoan(payload: SigningPayload): void {
  if (payload.family !== 'sui') refuse('That is not a Sui transaction.')
  const { commands } = Transaction.from(fromBase64(payload.transaction)).getData()
  const targetOf = (index: number): string | undefined => {
    const command = commands[index]
    return command?.$kind === 'MoveCall'
      ? moveTarget(command.MoveCall.package, command.MoveCall.module, command.MoveCall.function)
      : undefined
  }
  for (const command of commands) {
    if (command.$kind !== 'MoveCall') continue
    const { package: pkg, module, function: name, arguments: args } = command.MoveCall
    if (moveTarget(pkg, module, name) !== REPAY) continue
    const id = args[2]
    const source =
      id?.$kind === 'Result'
        ? id.Result
        : id?.$kind === 'NestedResult'
          ? id.NestedResult[0]
          : undefined
    if (source === undefined || targetOf(source) !== OBLIGATION_ID) {
      refuse("This transaction repays a loan that isn't shown to be yours.")
    }
  }
}

export interface SuilendReserve {
  coinName: string
  decimals: number
  available: bigint
  ctokenSupply: bigint
  borrowedWad: bigint
  spreadFeesWad: bigint
  depositLimit: bigint
  borrowLimit: bigint
  utilsPercent: readonly number[]
  aprsBps: readonly number[]
  spreadFeeBps: number
  cumulativeBorrowRateWad: bigint
  /** When interest was last added, in seconds. Zero means the figures already include it. */
  interestUpdatedSeconds: number
  openLtvPercent: number
  closeLtvPercent: number
  borrowWeightBps: number
  borrowFeeBps: number
  /** The Pyth feed this reserve is priced by. */
  feed: Uint8Array
}

export interface SuilendDeposit {
  reserve: number
  ctokens: bigint
}

export interface SuilendBorrow {
  reserve: number
  amountWad: bigint
  /** The reserve's cumulative rate when `amountWad` was last brought up to date. */
  rateWad: bigint
}

export interface SuilendPosition {
  capId: string
  obligationId: string
  deposits: readonly SuilendDeposit[]
  borrows: readonly SuilendBorrow[]
}

export type SuilendMarketView = (reserve: number) => SuilendReserve

/** Chain reads, kept apart so the refusals can be tested without a network. */
export interface SuilendReader {
  market: () => Promise<SuilendMarketView>
  positions: (account: string) => Promise<SuilendPosition[]>
  /** The price of each reserve, in the same order. */
  prices: (reserves: readonly SuilendReserve[]) => Promise<PythReading[]>
  walletBalance: (account: string, coinType: string) => Promise<bigint>
}

function unreadable(): never {
  return refuse("I couldn't read Suilend's market, so I stopped. Try again shortly.")
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : unreadable()
}

function whole(value: unknown): bigint {
  return typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : unreadable()
}

function decimalValue(value: unknown): bigint {
  return whole(record(value)['value'])
}

function count(value: unknown): number {
  return typeof value === 'number' ? value : Number(whole(value))
}

/** One reserve of the market. A reserve named at a known index must hold the coin it should. */
export function parseSuilendReserve(
  market: unknown,
  index: number = SUILEND_USDC_RESERVE,
  expectedName: string | null = USDC_NAME
): SuilendReserve {
  const reserves = record(market)['reserves']
  const raw = Array.isArray(reserves) ? record(reserves[index]) : unreadable()
  const coinName = raw['coin_type']
  if (typeof coinName !== 'string') unreadable()
  if (expectedName !== null && coinName !== expectedName) unreadable()
  const config = record(record(raw['config'])['element'])
  const utilsRaw = config['interest_rate_utils']
  const aprsRaw = config['interest_rate_aprs']
  const feedRaw = record(raw['price_identifier'])['bytes']
  if (typeof utilsRaw !== 'string' || !Array.isArray(aprsRaw) || typeof feedRaw !== 'string') {
    unreadable()
  }
  return {
    coinName,
    decimals: count(raw['mint_decimals']),
    available: whole(raw['available_amount']),
    ctokenSupply: whole(raw['ctoken_supply']),
    borrowedWad: decimalValue(raw['borrowed_amount']),
    spreadFeesWad: decimalValue(raw['unclaimed_spread_fees']),
    depositLimit: whole(config['deposit_limit']),
    borrowLimit: whole(config['borrow_limit']),
    utilsPercent: [...fromBase64(utilsRaw)],
    aprsBps: aprsRaw.map((apr) => Number(whole(apr))),
    spreadFeeBps: Number(whole(config['spread_fee_bps'])),
    cumulativeBorrowRateWad: decimalValue(raw['cumulative_borrow_rate']),
    interestUpdatedSeconds: Number(whole(raw['interest_last_update_timestamp_s'])),
    openLtvPercent: count(config['open_ltv_pct']),
    closeLtvPercent: count(config['close_ltv_pct']),
    borrowWeightBps: Number(whole(config['borrow_weight_bps'])),
    borrowFeeBps: Number(whole(config['borrow_fee_bps'])),
    feed: fromBase64(feedRaw),
  }
}

/** Reserve value in base units, as the contract counts it before this block's interest. */
function totalLiquidity(reserve: SuilendReserve): bigint {
  return reserve.available + (reserve.borrowedWad - reserve.spreadFeesWad) / WAD
}

/** Rounded up: interest only moves the share price up, so this never pays out less than asked. */
export function ctokensForAmount(amount: bigint, reserve: SuilendReserve): bigint {
  const total = totalLiquidity(reserve)
  if (total <= BigInt(0) || reserve.ctokenSupply <= BigInt(0)) unreadable()
  return (amount * reserve.ctokenSupply + total - BigInt(1)) / total
}

export function amountForCtokens(ctokens: bigint, reserve: SuilendReserve): bigint {
  if (reserve.ctokenSupply <= BigInt(0)) unreadable()
  return (ctokens * totalLiquidity(reserve)) / reserve.ctokenSupply
}

/** Borrowers' rate from the contract's own curve, at the current use of the pool. */
export function suilendBorrowApr(reserve: SuilendReserve): number | undefined {
  const borrowed = Number(reserve.borrowedWad / WAD)
  const available = Number(reserve.available)
  const { utilsPercent: utils, aprsBps: aprs } = reserve
  if (borrowed + available <= 0 || utils.length !== aprs.length || utils.length < 2) {
    return undefined
  }
  const usedPercent = (borrowed / (borrowed + available)) * 100
  if (usedPercent === 0) return (aprs[0] ?? 0) / 100
  const upper = utils.findIndex((util) => util >= usedPercent)
  if (upper < 1) return undefined
  const [lowUtil, highUtil] = [utils[upper - 1], utils[upper]]
  const [lowApr, highApr] = [aprs[upper - 1], aprs[upper]]
  if (
    lowUtil === undefined ||
    highUtil === undefined ||
    lowApr === undefined ||
    highApr === undefined
  ) {
    return undefined
  }
  const bps = lowApr + ((usedPercent - lowUtil) / (highUtil - lowUtil)) * (highApr - lowApr)
  return Number.isFinite(bps) ? Math.round(bps) / 100 : undefined
}

/**
 * The base rate from the contract's own curve: borrowers' rate at the current use of
 * the pool, shared across all deposits, less Suilend's spread. This is the SDK's
 * `calculateDepositAprPercent`. Rewards are not counted, and no rate is shown if the
 * curve doesn't read.
 */
export function suilendSupplyApr(reserve: SuilendReserve): number | undefined {
  const borrowed = Number(reserve.borrowedWad / WAD)
  const available = Number(reserve.available)
  if (borrowed + available <= 0) return undefined
  const usedPercent = (borrowed / (borrowed + available)) * 100
  if (usedPercent === 0) return 0
  const borrowPercent = suilendBorrowApr(reserve)
  if (borrowPercent === undefined) return undefined
  const percent = (usedPercent / 100) * borrowPercent * (1 - reserve.spreadFeeBps / 10_000)
  return Number.isFinite(percent) ? Math.round(percent * 100) / 100 : undefined
}

function suilendApy(reserve: SuilendReserve): PreparedAction['apy'] {
  const basePercent = suilendSupplyApr(reserve)
  return basePercent === undefined ? undefined : { basePercent }
}

/** A reserve as `compound_interest` would leave it at this moment. */
export function accruedReserve(reserve: SuilendReserve, nowSeconds: number): SuilendReserve {
  const elapsed = nowSeconds - reserve.interestUpdatedSeconds
  const apr = suilendBorrowApr(reserve)
  if (elapsed <= 0 || apr === undefined) return reserve
  const growth = (1 + apr / 100 / SECONDS_PER_YEAR) ** elapsed - 1
  const added = BigInt(Math.round(growth * 1e18))
  const interestWad = (reserve.borrowedWad * added) / WAD
  return {
    ...reserve,
    borrowedWad: reserve.borrowedWad + interestWad,
    spreadFeesWad:
      reserve.spreadFeesWad + (interestWad * BigInt(reserve.spreadFeeBps)) / BigInt(10_000),
    cumulativeBorrowRateWad:
      reserve.cumulativeBorrowRateWad + (reserve.cumulativeBorrowRateWad * added) / WAD,
    interestUpdatedSeconds: nowSeconds,
  }
}

/** A debt now, rounded up. `reserve` must be accrued. */
export function owedOn(borrow: SuilendBorrow, reserve: SuilendReserve): bigint {
  const wad = (borrow.amountWad * reserve.cumulativeBorrowRateWad) / borrow.rateWad
  return (wad + WAD - BigInt(1)) / WAD
}

const chainReader: SuilendReader = {
  market: async () => {
    const { object } = await suiClient().core.getObject({
      objectId: SUILEND_MARKET,
      include: { json: true },
    })
    const now = Math.floor(Date.now() / 1000)
    return (reserve) => accruedReserve(parseSuilendReserve(object.json, reserve, null), now)
  },
  positions: async (account) => {
    const client = suiClient()
    const caps: { capId: string; obligationId: string }[] = []
    let cursor: string | null | undefined
    for (let page = 0; page < MAX_CAP_PAGES; page++) {
      const owned = await client.core.listOwnedObjects({
        owner: account,
        type: CAP_TYPE,
        include: { json: true },
        ...(cursor ? { cursor } : {}),
      })
      for (const { objectId, json } of owned.objects) {
        const obligationId = record(json)['obligation_id']
        if (typeof obligationId !== 'string') unreadable()
        caps.push({ capId: objectId, obligationId })
      }
      if (!owned.hasNextPage) break
      cursor = owned.cursor
    }
    return Promise.all(
      caps.map(async ({ capId, obligationId }) => {
        const { object } = await client.core.getObject({
          objectId: obligationId,
          include: { json: true },
        })
        const obligation = record(object.json)
        const { deposits, borrows } = obligation
        if (!Array.isArray(deposits) || !Array.isArray(borrows)) unreadable()
        return {
          capId,
          obligationId,
          deposits: deposits.map(record).map((d) => ({
            reserve: Number(whole(d['reserve_array_index'])),
            ctokens: whole(d['deposited_ctoken_amount']),
          })),
          borrows: borrows.map(record).map((b) => ({
            reserve: Number(whole(b['reserve_array_index'])),
            amountWad: decimalValue(b['borrowed_amount']),
            rateWad: decimalValue(b['cumulative_borrow_rate']),
          })),
        }
      })
    )
  },
  prices: (reserves) =>
    Promise.all(
      reserves.map(async (reserve) => readPythObject(await pythObjectForFeed(reserve.feed)))
    ),
  walletBalance,
}

function checkedRequest(request: ChainActionRequest, account: string): ChainToken {
  assertSuiAccount(account)
  const token = tokenBySymbol(SUI_TOKENS, request.tokenIn)
  if (token?.symbol !== 'USDC') {
    refuse(`Suilend takes USDC here, not ${request.tokenIn}. Try "supply 10 USDC on Suilend".`)
  }
  return token
}

function checkedListed(
  request: ChainActionRequest,
  account: string
): { token: ChainToken; reserve: number } {
  assertSuiAccount(account)
  const token = tokenBySymbol(SUI_TOKENS, request.tokenIn)
  const reserve = token === undefined ? undefined : SUILEND_RESERVES[token.symbol]
  if (token === undefined || reserve === undefined) {
    refuse(
      `Suilend doesn't take ${request.tokenIn} here. It takes ${Object.keys(SUILEND_RESERVES).join(', ')}.`
    )
  }
  return { token, reserve }
}

function dollars(base: bigint): number {
  return Number(base) / 1e6
}

function sharedNotes(reserve: SuilendReserve): string[] {
  return [
    ...poolNotes({ availableUsdc: dollars(reserve.available) }),
    "Suilend's contract upgrades are controlled by a single key, not a multisig, going by that address's own recent transactions. If that key were stolen, deposits could be at risk. Suilend's team can also change the market's settings.",
    'Bluewater bought Suilend in June 2026, so it now has new owners.',
  ]
}

function ctokensIn(position: SuilendPosition, reserve: number): bigint {
  return position.deposits.find((d) => d.reserve === reserve)?.ctokens ?? BigInt(0)
}

/**
 * Only a position with no loan is reused, so a deposit never becomes collateral by
 * accident and can always leave without a fresh price.
 */
export function positionForSupply(
  positions: readonly SuilendPosition[]
): SuilendPosition | undefined {
  const free = positions.filter((p) => p.borrows.length === 0)
  return free.find((p) => ctokensIn(p, SUILEND_USDC_RESERVE) > BigInt(0)) ?? free[0]
}

/**
 * A position in dollars, the way the contract weighs it: the lower of price and average for what
 * it would lend against, and the higher for what is owed.
 */
export function standingOf(
  position: SuilendPosition,
  market: SuilendMarketView,
  priceOf: (reserve: number) => PythReading
): LoanStanding {
  const standing = { liquidationUsd: 0, limitUsd: 0, owedUsd: 0 }
  for (const deposit of position.deposits) {
    const reserve = market(deposit.reserve)
    const { priceUsd, emaUsd } = priceOf(deposit.reserve)
    const units = Number(amountForCtokens(deposit.ctokens, reserve)) / 10 ** reserve.decimals
    standing.liquidationUsd += units * priceUsd * (reserve.closeLtvPercent / 100)
    standing.limitUsd += units * Math.min(priceUsd, emaUsd) * (reserve.openLtvPercent / 100)
  }
  for (const borrow of position.borrows) {
    const reserve = market(borrow.reserve)
    const { priceUsd, emaUsd } = priceOf(borrow.reserve)
    const units = Number(owedOn(borrow, reserve)) / 10 ** reserve.decimals
    standing.owedUsd += units * Math.max(priceUsd, emaUsd) * (reserve.borrowWeightBps / 10_000)
  }
  return standing
}

function reservesOf(position: SuilendPosition, also: readonly number[] = []): number[] {
  return [
    ...new Set([
      ...position.deposits.map((d) => d.reserve),
      ...position.borrows.map((b) => b.reserve),
      ...also,
    ]),
  ]
}

interface PricedPosition {
  standing: LoanStanding
  refreshes: readonly PriceRefresh[]
  priceOf: (reserve: number) => PythReading
}

export interface PriceRefresh {
  reserve: number
  priceObject: string
}

/** Reads the prices a position's checks and its transaction need, and refuses if they are stale. */
async function priced(
  reader: SuilendReader,
  position: SuilendPosition,
  market: SuilendMarketView,
  also: readonly number[] = []
): Promise<PricedPosition> {
  const indexes = reservesOf(position, also)
  const readings = await reader.prices(indexes.map(market))
  assertPricesFresh(readings, PRICE_LIMIT_SECONDS, 'Suilend')
  const byReserve = new Map(indexes.map((reserve, i) => [reserve, readings[i]]))
  const priceOf = (reserve: number): PythReading => {
    const reading = byReserve.get(reserve)
    if (reading === undefined) throw new Error(`No price was read for reserve ${reserve}.`)
    return reading
  }
  return {
    priceOf,
    standing: standingOf(position, market, priceOf),
    refreshes: indexes.map((reserve) => ({ reserve, priceObject: priceOf(reserve).objectId })),
  }
}

function refreshPrices(tx: Transaction, refreshes: readonly PriceRefresh[]): void {
  for (const { reserve, priceObject } of refreshes) {
    tx.moveCall({
      target: fn('refresh_reserve_price_pro_compatible'),
      typeArguments: [SUILEND_MAIN_POOL],
      arguments: [
        tx.object(SUILEND_MARKET),
        tx.pure.u64(reserve),
        tx.object.clock(),
        tx.object(priceObject),
      ],
    })
  }
}

function typeOfReserve(reserve: number): string {
  const listed = LISTED.find((l) => l.reserve === reserve)
  if (listed === undefined) throw new Error(`Reserve ${reserve} is not a listed token.`)
  return listed.type
}

function isSui(reserve: number): boolean {
  return reserve === SUILEND_RESERVES['SUI']
}

/** A liquidity request turned into the coin it stands for, with SUI brought back from staking. */
function fulfil(
  tx: Transaction,
  reserve: number,
  request: ReturnType<Transaction['moveCall']>[number]
) {
  if (isSui(reserve)) {
    tx.moveCall({
      target: fn('unstake_sui_from_staker'),
      typeArguments: [SUILEND_MAIN_POOL],
      arguments: [tx.object(SUILEND_MARKET), tx.pure.u64(reserve), request, tx.object(SUI_SYSTEM)],
    })
  }
  const [coin] = tx.moveCall({
    target: fn('fulfill_liquidity_request'),
    typeArguments: [SUILEND_MAIN_POOL, typeOfReserve(reserve)],
    arguments: [tx.object(SUILEND_MARKET), tx.pure.u64(reserve), request],
  })
  if (coin === undefined) throw new Error('Withdrawing returned nothing.')
  return coin
}

export function suilendBorrowTransaction(
  account: string,
  reserve: number,
  amount: bigint,
  capId: string,
  refreshes: readonly PriceRefresh[]
): Transaction {
  const tx = new Transaction()
  tx.setSender(account)
  refreshPrices(tx, refreshes)
  const [request] = tx.moveCall({
    target: fn('borrow_request'),
    typeArguments: [SUILEND_MAIN_POOL, typeOfReserve(reserve)],
    arguments: [
      tx.object(SUILEND_MARKET),
      tx.pure.u64(reserve),
      tx.object(capId),
      tx.object.clock(),
      tx.pure.u64(amount),
    ],
  })
  if (request === undefined) throw new Error('Borrowing returned nothing.')
  tx.transferObjects([fulfil(tx, reserve, request)], account)
  return tx
}

export interface SuilendRepayment {
  capId: string
  coin: bigint
}

/**
 * Each loan is named by reading the signer's own cap. The contract takes what is owed and leaves
 * the rest in the coin, which goes back to the signer.
 */
export function suilendRepayTransaction(
  account: string,
  reserve: number,
  repayments: readonly SuilendRepayment[]
): Transaction {
  const tx = new Transaction()
  tx.setSender(account)
  const type = typeOfReserve(reserve)
  for (const { capId, coin: amount } of repayments) {
    const coin = tx.add(
      isSui(reserve)
        ? coinWithBalance({ balance: amount })
        : coinWithBalance({ type, balance: amount, useGasCoin: false })
    )
    const [obligationId] = tx.moveCall({
      target: OBLIGATION_ID,
      typeArguments: [SUILEND_MAIN_POOL],
      arguments: [tx.object(capId)],
    })
    if (obligationId === undefined) throw new Error('Reading the position returned nothing.')
    tx.moveCall({
      target: REPAY,
      typeArguments: [SUILEND_MAIN_POOL, type],
      arguments: [
        tx.object(SUILEND_MARKET),
        tx.pure.u64(reserve),
        obligationId,
        tx.object.clock(),
        coin,
      ],
    })
    tx.transferObjects([coin], account)
  }
  return tx
}

export interface SuilendWithdrawal {
  capId: string
  ctokens: bigint
}

export function suilendWithdrawTransaction(
  account: string,
  reserve: number,
  withdrawals: readonly SuilendWithdrawal[],
  refreshes: readonly PriceRefresh[]
): Transaction {
  const tx = new Transaction()
  tx.setSender(account)
  refreshPrices(tx, refreshes)
  const type = typeOfReserve(reserve)
  const types = [SUILEND_MAIN_POOL, type]
  for (const { capId, ctokens } of withdrawals) {
    const [out] = tx.moveCall({
      target: fn('withdraw_ctokens'),
      typeArguments: types,
      arguments: [
        tx.object(SUILEND_MARKET),
        tx.pure.u64(reserve),
        tx.object(capId),
        tx.object.clock(),
        tx.pure.u64(ctokens),
      ],
    })
    const [exemption] = tx.moveCall({
      target: moveTarget('0x1', 'option', 'none'),
      typeArguments: [exemptionType(type)],
    })
    if (out === undefined || exemption === undefined) throw new Error('A step returned nothing.')
    const [liquidityRequest] = tx.moveCall({
      target: fn('redeem_ctokens_and_withdraw_liquidity_request'),
      typeArguments: types,
      arguments: [
        tx.object(SUILEND_MARKET),
        tx.pure.u64(reserve),
        tx.object.clock(),
        out,
        exemption,
      ],
    })
    if (liquidityRequest === undefined) throw new Error('Redeeming returned nothing.')
    tx.transferObjects([fulfil(tx, reserve, liquidityRequest)], account)
  }
  return tx
}

async function quote(
  reader: SuilendReader,
  request: ChainActionRequest,
  account: string
): Promise<VenueQuote> {
  if (request.kind !== 'supply') return {}
  checkedRequest(request, account)
  const market = await reader.market()
  return quotedApy(suilendApy(market(SUILEND_USDC_RESERVE)))
}

async function prepareSupply(
  reader: SuilendReader,
  request: ChainActionRequest,
  account: string
): Promise<PreparedAction> {
  const token = checkedRequest(request, account)
  const amount = toBaseUnits(request.amount, token.decimals)
  const reserve = (await reader.market())(SUILEND_USDC_RESERVE)
  if (totalLiquidity(reserve) + BigInt(amount) > reserve.depositLimit) {
    refuse("Suilend's USDC market is at its deposit limit. Try a smaller amount or another venue.")
  }
  const existing = positionForSupply(await reader.positions(account))

  const tx = new Transaction()
  tx.setSender(account)
  const [newCap] =
    existing === undefined
      ? tx.moveCall({
          target: fn('create_obligation'),
          typeArguments: [SUILEND_MAIN_POOL],
          arguments: [tx.object(SUILEND_MARKET)],
        })
      : [undefined]
  const cap = existing === undefined ? newCap : tx.object(existing.capId)
  if (cap === undefined) throw new Error('Opening a position returned nothing.')

  const coin = tx.add(
    coinWithBalance({ type: token.id, balance: BigInt(amount), useGasCoin: false })
  )
  const [ctokens] = tx.moveCall({
    target: fn('deposit_liquidity_and_mint_ctokens'),
    typeArguments: USDC_TYPES,
    arguments: [
      tx.object(SUILEND_MARKET),
      tx.pure.u64(SUILEND_USDC_RESERVE),
      tx.object.clock(),
      coin,
    ],
  })
  if (ctokens === undefined) throw new Error('Minting returned nothing.')
  tx.moveCall({
    target: fn('deposit_ctokens_into_obligation'),
    typeArguments: USDC_TYPES,
    arguments: [
      tx.object(SUILEND_MARKET),
      tx.pure.u64(SUILEND_USDC_RESERVE),
      cap,
      tx.object.clock(),
      ctokens,
    ],
  })
  if (existing === undefined) tx.transferObjects([cap], account)

  const transaction = await buildUnsigned(tx, suiClient(), token.symbol)
  const change = await dryRunChange(transaction, token.id, account, 'Checking the deposit')
  if (change !== -BigInt(amount)) {
    refuse("I couldn't confirm what this deposit would do, so I stopped. Try again shortly.")
  }

  return {
    venueId: 'suilend',
    venueName: 'Suilend',
    kind: 'supply',
    summary: `Supply ${request.amount} USDC to Suilend's main market.`,
    pay: { amount: request.amount, symbol: token.symbol },
    apy: suilendApy(reserve),
    notes: [
      ...sharedNotes(reserve),
      existing === undefined
        ? 'This opens a Suilend position, held by a position ticket sent to your wallet. Whoever holds that ticket controls the deposit, so keep it.'
        : 'This adds to your existing Suilend position. Whoever holds its position ticket controls the deposit, so keep it.',
      'You can withdraw here at any time while this position has no loan, as long as the pool has the cash.',
    ],
    signing: { family: 'sui', transaction },
  }
}

async function prepareWithdraw(
  reader: SuilendReader,
  request: ChainActionRequest,
  account: string
): Promise<PreparedAction> {
  const { token, reserve: reserveIndex } = checkedListed(request, account)
  const amount = BigInt(toBaseUnits(request.amount, token.decimals))
  const isWhole = request.wholePosition === true

  const holding = (await reader.positions(account)).filter(
    (p) => ctokensIn(p, reserveIndex) > BigInt(0)
  )
  if (holding.length === 0) refuse(`This wallet has no ${token.symbol} in Suilend.`)

  const market = await reader.market()
  const reserve = market(reserveIndex)
  const valueOf = (p: SuilendPosition) => amountForCtokens(ctokensIn(p, reserveIndex), reserve)

  // A whole withdraw takes every share, and shares don't change with interest, so none is left.
  const free = holding.filter((p) => p.borrows.length === 0)
  const fullest = (list: readonly SuilendPosition[]) =>
    list.reduce((best, p) => (valueOf(p) > valueOf(best) ? p : best))
  const single =
    free.length > 0 && gaveWhatWasAsked(valueOf(fullest(free)), amount)
      ? fullest(free)
      : fullest(holding)
  const targets = isWhole ? holding : [single]
  if (!isWhole && !gaveWhatWasAsked(valueOf(single), amount)) {
    const held = displayAmount(valueOf(single).toString(), token.decimals)
    refuse(
      `You have about ${held} ${token.symbol} in Suilend, which is less than ${request.amount}. Try ${held}.`
    )
  }

  const notes = [
    'Suilend limits how much can leave the whole market each hour, so a large withdrawal may need to wait.',
    'If the pool has little cash because most of it is lent out, this can fail until borrowers repay.',
    'This does not claim reward tokens. Any you have earned stay claimable at suilend.fi.',
  ]
  const refreshes = new Map<number, PriceRefresh>()
  for (const position of targets) {
    if (position.borrows.length === 0) continue
    const { standing, priceOf, refreshes: needed } = await priced(reader, position, market)
    for (const refresh of needed) refreshes.set(refresh.reserve, refresh)
    const value = valueOf(position)
    const taken = Number(isWhole ? value : amount) / 10 ** token.decimals
    const { priceUsd, emaUsd } = priceOf(reserveIndex)
    const health = assertWithdrawFits({
      venueName: 'Suilend',
      symbol: token.symbol,
      standing,
      removedLimitUsd: taken * Math.min(priceUsd, emaUsd) * (reserve.openLtvPercent / 100),
      removedLiquidationUsd: taken * priceUsd * (reserve.closeLtvPercent / 100),
      amount: taken,
    })
    if (health !== undefined) notes.push(withdrawLoanNote(token.symbol, health))
  }

  const withdrawals = targets.map((p) => ({
    capId: p.capId,
    ctokens: isWhole
      ? ctokensIn(p, reserveIndex)
      : min(ctokensForAmount(amount, reserve), ctokensIn(p, reserveIndex)),
  }))
  const tx = suilendWithdrawTransaction(account, reserveIndex, withdrawals, [...refreshes.values()])
  const transaction = await buildUnsigned(tx, suiClient(), token.symbol)
  const received = await dryRunChange(transaction, token.id, account, 'Checking the withdrawal')
  if (received === undefined || !gaveWhatWasAsked(received, amount)) {
    refuse(
      "I couldn't confirm this withdrawal would return what you asked, so I stopped. Try again shortly."
    )
  }
  const receive = displayAmount(received.toString(), token.decimals)

  return {
    venueId: 'suilend',
    venueName: 'Suilend',
    kind: 'withdraw',
    summary: `Withdraw about ${receive} ${token.symbol} from Suilend's main market to your wallet.`,
    pay: { amount: request.amount, symbol: token.symbol },
    receive: { amount: receive, symbol: token.symbol, approximate: true },
    notes,
    signing: { family: 'sui', transaction },
  }
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b
}

async function prepareBorrow(
  reader: SuilendReader,
  request: ChainActionRequest,
  account: string
): Promise<PreparedAction> {
  const { token, reserve: reserveIndex } = checkedListed(request, account)
  const amount = BigInt(toBaseUnits(request.amount, token.decimals))
  const market = await reader.market()
  const reserve = market(reserveIndex)

  if (reserve.borrowLimit === BigInt(0)) {
    refuse(`Suilend doesn't lend ${token.symbol} right now.`)
  }
  const fee = (amount * BigInt(reserve.borrowFeeBps)) / BigInt(10_000)
  if (amount + fee > reserve.available) {
    refuse(
      `Only about ${displayAmount(reserve.available.toString(), token.decimals)} ${token.symbol} is free to borrow on Suilend right now.`
    )
  }

  const backed = (await reader.positions(account)).filter((p) => p.deposits.length > 0)
  if (backed.length === 0) {
    refuse('You have no collateral on Suilend here, so there is nothing to borrow against.')
  }
  // The contract won't lend a token against itself in the same position.
  const open = backed.filter((p) => ctokensIn(p, reserveIndex) === BigInt(0))
  if (open.length === 0) {
    refuse(
      `Suilend won't lend ${token.symbol} against a position that holds ${token.symbol} as collateral. Borrow a different token, or withdraw your ${token.symbol} first.`
    )
  }
  const options = await Promise.all(
    open.map(async (position) => ({
      position,
      ...(await priced(reader, position, market, [reserveIndex])),
    }))
  )
  const best = options.reduce((a, b) =>
    b.standing.limitUsd - b.standing.owedUsd > a.standing.limitUsd - a.standing.owedUsd ? b : a
  )

  const { priceUsd, emaUsd } = best.priceOf(reserveIndex)
  const debtPrice =
    Math.max(priceUsd, emaUsd) *
    (reserve.borrowWeightBps / 10_000) *
    (1 + reserve.borrowFeeBps / 10_000)
  const health = assertBorrowFits({
    venueName: 'Suilend',
    symbol: token.symbol,
    standing: best.standing,
    addedOwedUsd: (Number(amount) / 10 ** token.decimals) * debtPrice,
    priceUsd: debtPrice,
  })

  const tx = suilendBorrowTransaction(
    account,
    reserveIndex,
    amount,
    best.position.capId,
    best.refreshes
  )
  const transaction = await buildUnsigned(tx, suiClient(), token.symbol)
  const received = await dryRunChange(transaction, token.id, account, 'Checking the borrow')
  if (received === undefined || !gaveWhatWasAsked(received, amount)) {
    refuse(
      "I couldn't confirm this borrow would pay what you asked, so I stopped. Try again shortly."
    )
  }

  return {
    venueId: 'suilend',
    venueName: 'Suilend',
    kind: 'borrow',
    summary: `Borrow ${request.amount} ${token.symbol} from Suilend's main market at a variable rate.`,
    pay: { amount: request.amount, symbol: token.symbol },
    receive: { amount: request.amount, symbol: token.symbol, approximate: false },
    notes: [
      ...borrowNotes({
        venueName: 'Suilend',
        symbol: token.symbol,
        health,
        borrowAprPercent: suilendBorrowApr(reserve),
        feePercent: reserve.borrowFeeBps / 100,
      }),
      'Suilend limits how much can leave the whole market each hour, so a large borrow may need to wait.',
      'This needs prices others publish on chain within the last minute. If they run late, this fails and only the network fee is lost.',
      ...sharedNotes(reserve).slice(2),
    ],
    signing: { family: 'sui', transaction },
  }
}

async function prepareRepay(
  reader: SuilendReader,
  request: ChainActionRequest,
  account: string
): Promise<PreparedAction> {
  const { token, reserve: reserveIndex } = checkedListed(request, account)
  const asked = BigInt(toBaseUnits(request.amount, token.decimals))
  const isWhole = request.wholePosition === true
  const market = await reader.market()
  const reserve = market(reserveIndex)

  const loans = (await reader.positions(account)).flatMap((position) => {
    const borrow = position.borrows.find((b) => b.reserve === reserveIndex)
    return borrow === undefined ? [] : [{ position, owed: owedOn(borrow, reserve) }]
  })
  if (loans.length === 0) refuse(`You don't owe any ${token.symbol} on Suilend.`)

  const largest = loans.reduce((a, b) => (b.owed > a.owed ? b : a))
  const totalOwed = loans.reduce((sum, loan) => sum + loan.owed, BigInt(0))
  const targets = isWhole ? loans : [largest]
  const owed = isWhole ? totalOwed : largest.owed
  let held = await reader.walletBalance(account, token.id)
  const coins = targets.map((loan) => {
    const coin = repayCoinAmount({
      asked,
      owed: loan.owed,
      whole: isWhole,
      held,
      symbol: token.symbol,
      decimals: token.decimals,
    })
    held -= coin
    return { capId: loan.position.capId, coin }
  })
  const clearing = isWhole || asked >= largest.owed

  const tx = suilendRepayTransaction(account, reserveIndex, coins)
  const transaction = await buildUnsigned(tx, suiClient(), token.symbol)
  const change = await dryRunChange(transaction, token.id, account, 'Checking the repayment')
  const paid = change === undefined ? undefined : -change
  if (paid === undefined || !gaveWhatWasAsked(paid, clearing ? owed : asked)) {
    refuse("I couldn't confirm what this repayment would do, so I stopped. Try again shortly.")
  }
  const shown = displayAmount(paid.toString(), token.decimals)

  return {
    venueId: 'suilend',
    venueName: 'Suilend',
    kind: 'repay',
    summary: clearing
      ? `Repay your whole ${token.symbol} loan on Suilend, about ${shown} ${token.symbol}, interest included.`
      : `Repay ${request.amount} ${token.symbol} of your loan on Suilend.`,
    pay: { amount: shown, symbol: token.symbol },
    notes: [
      `You owe about ${displayAmount(owed.toString(), token.decimals)} ${token.symbol} on Suilend, interest included.`,
      clearing
        ? 'This offers a little more than that, to cover interest added before you sign. Only what you owe is taken, and the rest stays in your wallet.'
        : 'Interest keeps adding to what is left, and a loan can still be liquidated until it is paid off.',
    ],
    signing: { family: 'sui', transaction },
  }
}

/** Only tokens this app lists are reported: nothing else can be acted on here. */
export async function readSuilendPositions(
  reader: SuilendReader,
  account: string
): Promise<VenuePosition[]> {
  assertSuiAccount(account)
  const positions = await reader.positions(account)
  if (positions.length === 0) return []
  const market = await reader.market()
  const out: VenuePosition[] = []
  for (const { symbol, reserve: index } of LISTED) {
    const reserve = market(index)
    let supplied = BigInt(0)
    let owed = BigInt(0)
    for (const position of positions) {
      supplied += amountForCtokens(ctokensIn(position, index), reserve)
      for (const borrow of position.borrows) {
        if (borrow.reserve === index) owed += owedOn(borrow, reserve)
      }
    }
    if (supplied > BigInt(0)) {
      out.push({
        slot: 'supplied',
        symbol,
        amount: displayAmount(supplied.toString(), reserve.decimals),
      })
    }
    if (owed > BigInt(0)) {
      out.push({
        slot: 'borrowed',
        symbol,
        amount: displayAmount(owed.toString(), reserve.decimals),
      })
    }
  }
  return out
}

export function createSuilendVenue(reader: SuilendReader = chainReader): ChainVenue {
  return {
    id: 'suilend',
    name: 'Suilend',
    kinds: ['supply', 'withdraw', 'borrow', 'repay'],
    assertCanFollow: takesOnly('Suilend', ['USDC']),
    quote: (request, account) => quote(reader, request, account),
    prepare: (request, account) => {
      if (request.kind === 'withdraw') return prepareWithdraw(reader, request, account)
      if (request.kind === 'borrow') return prepareBorrow(reader, request, account)
      if (request.kind === 'repay') return prepareRepay(reader, request, account)
      return prepareSupply(reader, request, account)
    },
    positions: (account) => readSuilendPositions(reader, account),
    assertSafe: (payload: SigningPayload, account: string) => {
      assertPtbSafe(payload, account, SUILEND_POLICY)
      assertCallsPinned(payload, PINS, 'Suilend')
      assertRepaysOwnLoan(payload)
    },
  }
}

export const suilendVenue = createSuilendVenue()
