import { bcs } from '@mysten/sui/bcs'
import { coinWithBalance, Transaction } from '@mysten/sui/transactions'
import { fromBase64, normalizeStructTag, normalizeSuiAddress } from '@mysten/sui/utils'

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
  objectAt,
  pinnedPolicy,
  PYTH_STATE,
  readPythObject,
  refuse,
  repayCoinAmount,
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
 * Scallop's latest protocol package, version 19: the `package` field of the UpgradeCap
 * in `core.packages.protocol` of Scallop's address registry, the same cap id as
 * @scallop-io/sui-scallop-sdk 5.4.3's `constants/testAddress.ts`. `mint` and `redeem`
 * here match the signatures on Scallop's docs (integrations/contract-integration/
 * lending-function), which still name an older package.
 */
export const SCALLOP_PACKAGE = '0xde5c09ad171544aa3724dc67216668c80e754860f419136a68d78504eb2e2805'
export const SCALLOP_ORIGINAL_PACKAGE =
  '0xefe8b36d5b2e43728cc323298626b83177803521d195cfb11e15b910e892fddf'
export const SCALLOP_UPGRADE_CAP =
  '0x38527d154618d1fd5a644b90717fe07cf0e9f26b46b63e9568e611a3f86d5c1a'
/** Both on the docs page above and in the registry. On chain, shared `version::Version` and `market::Market`. */
export const SCALLOP_VERSION = '0x07871c4b3c847a0f674510d4978d5cf6f960452795e8ff6f189fd2088a3f6ac7'
export const SCALLOP_MARKET = '0xa757975255146dc9686aa823b7838b507f315d704f428cbadad2f4ea061939d9'
/** Table ids read from the market object. They hold the pool's numbers, keyed by coin type. */
export const SCALLOP_BALANCE_SHEETS =
  '0x8708eb23153bdc4b345c9f536fe05b62206f3f55629b26389d4fe5f129bd8368'
export const SCALLOP_BORROW_DYNAMICS =
  '0x2d878e129dec2d83f3e240fa403cd588bc5101dd9b60040c27007e24ef242d8d'
export const SCALLOP_INTEREST_MODELS =
  '0x1e8419e665b8b796723c97747c504f4a37a527d4f944f27ae9467ae68e8b50f9'
export const SCALLOP_RISK_MODELS =
  '0x4e5bcb98e020687fa7208486cbc3234e1696e6839c18336a65f70ede3fd59f36'
export const SCALLOP_DECIMALS_REGISTRY =
  '0x200abe9bf19751cc566ae35aa58e2b7e4ff688fc1130f8d8909ea09bc137d668'
/**
 * Scallop's price oracle and the rule that fills it from Pyth. The registry's Pyth entries still
 * name the older Pyth package, whose objects stopped moving, so these come from Scallop's own
 * borrows on chain, such as GH64VyAhAcrTEDBoZ5bAUaTB8Va17qg9dnafoe5VJ4e3, and the live test runs
 * them. The price objects are what `SCALLOP_PYTH_REGISTRY_TABLE` lists for each coin, read each
 * time, and the rule refuses any other.
 */
export const SCALLOP_X_ORACLE = '0x93d5bf0936b71eb27255941e532fac33b5a5c7759e377b4923af0a1359ad494f'
export const SCALLOP_X_ORACLE_PACKAGE =
  '0xbf926dd6ecdd3bb5231659b739e20cf864dc12f13c5b4c8b939d00fa70350b3a'
export const SCALLOP_PYTH_RULE =
  '0x71fddacc6ecf164bd8f6c081092beeef20945c5da2c74e0b9f3e1d3c7003fadd'
export const SCALLOP_PYTH_REGISTRY =
  '0xdf5a879c4a572c7a143839c019ca114eaaf696426b6c95a052b865c06f12e279'
export const SCALLOP_PYTH_REGISTRY_TABLE =
  '0x0ffe5411ce8662a92e4b0729611593fbc52da9ea93be91a2fafff0492aeba8db'

/** The listed tokens Scallop has a market for, each read from the tables above. */
export const SCALLOP_SYMBOLS: readonly string[] = ['SUI', 'USDC', 'USDT', 'WAL', 'USDsui', 'afSUI']

const USDC = SUI_TOKENS.find((t) => t.symbol === 'USDC')
if (USDC === undefined) throw new Error('USDC is missing from the Sui token table.')
const USDC_TYPE = USDC.id

function listedType(symbol: string): string {
  const token = SUI_TOKENS.find((t) => t.symbol === symbol)
  if (token === undefined) throw new Error(`${symbol} is missing from the Sui token table.`)
  return token.id
}

const LISTED_TYPES = SCALLOP_SYMBOLS.map(listedType)

function receiptType(coinType: string): string {
  return `${SCALLOP_ORIGINAL_PACKAGE}::reserve::MarketCoin<${coinType}>`
}

export const SCALLOP_RECEIPT_TYPE = receiptType(USDC_TYPE)
const RECEIPT_SYMBOL = 'Scallop USDC'
const SECONDS_PER_YEAR = 31_536_000
const FIXED_POINT_32 = 2 ** 32
const MAX_KEY_PAGES = 5
/** `assert_price_not_stale` in Scallop's `pyth_adaptor.move`. */
const PRICE_LIMIT_SECONDS = 30

const MINT = moveTarget(SCALLOP_PACKAGE, 'mint', 'mint')
const REDEEM = moveTarget(SCALLOP_PACKAGE, 'redeem', 'redeem')
const BORROW = moveTarget(SCALLOP_PACKAGE, 'borrow', 'borrow')
const REPAY = moveTarget(SCALLOP_PACKAGE, 'repay', 'repay')
const WITHDRAW_COLLATERAL = moveTarget(
  SCALLOP_PACKAGE,
  'withdraw_collateral',
  'withdraw_collateral'
)
const ASSERT_KEY = moveTarget(SCALLOP_PACKAGE, 'obligation', 'assert_key_match')
const PRICE_REQUEST = moveTarget(SCALLOP_X_ORACLE_PACKAGE, 'x_oracle', 'price_update_request')
const PRICE_CONFIRM = moveTarget(
  SCALLOP_X_ORACLE_PACKAGE,
  'x_oracle',
  'confirm_price_update_request'
)
const PRICE_SET = moveTarget(SCALLOP_PYTH_RULE, 'rule', 'set_price_as_primary')

const versionAndMarket = { objects: { 0: SCALLOP_VERSION, 1: SCALLOP_MARKET } }
const loanCallObjects = {
  objects: {
    0: SCALLOP_VERSION,
    3: SCALLOP_MARKET,
    4: SCALLOP_DECIMALS_REGISTRY,
    6: SCALLOP_X_ORACLE,
  },
}

function forEachToken(shape: Omit<PinnedCall, 'typeArguments'>): readonly PinnedCall[] {
  return LISTED_TYPES.map((type) => ({ ...shape, typeArguments: [type] }))
}

/**
 * None of these names a recipient. Each that pays returns a coin, and the transaction's transfers
 * must pay the signer. `borrow` and `withdraw_collateral` check the obligation against the key,
 * which only its holder can pass. `repay` takes no key, and anyone may repay any loan, so
 * `assertRepaysOwnLoan` requires a key check on the same obligation. The price calls move no money.
 */
const PINS: PinnedCalls = new Map<string, PinnedCall | readonly PinnedCall[]>([
  [MINT, { typeArguments: [USDC_TYPE], argumentCount: 4, ...versionAndMarket }],
  [REDEEM, forEachToken({ argumentCount: 4, ...versionAndMarket })],
  [BORROW, forEachToken({ argumentCount: 8, ...loanCallObjects })],
  [WITHDRAW_COLLATERAL, forEachToken({ argumentCount: 8, ...loanCallObjects })],
  [REPAY, forEachToken({ argumentCount: 5, objects: { 0: SCALLOP_VERSION, 2: SCALLOP_MARKET } })],
  [ASSERT_KEY, { typeArguments: [], argumentCount: 2 }],
  [PRICE_REQUEST, { typeArguments: undefined, argumentCount: 1, objects: { 0: SCALLOP_X_ORACLE } }],
  [
    PRICE_SET,
    {
      typeArguments: undefined,
      argumentCount: 5,
      objects: { 1: PYTH_STATE, 3: SCALLOP_PYTH_REGISTRY },
    },
  ],
  [PRICE_CONFIRM, { typeArguments: undefined, argumentCount: 3, objects: { 0: SCALLOP_X_ORACLE } }],
])

export const SCALLOP_POLICY = pinnedPolicy('Scallop', PINS)

/** A repay must follow a check, in the same transaction, that this signer's key opens the loan. */
export function assertRepaysOwnLoan(payload: SigningPayload): void {
  if (payload.family !== 'sui') refuse('That is not a Sui transaction.')
  const data = Transaction.from(fromBase64(payload.transaction)).getData()
  const checked = new Set<string>()
  for (const command of data.commands) {
    if (command.$kind !== 'MoveCall') continue
    const { package: pkg, module, function: name, arguments: args } = command.MoveCall
    const target = moveTarget(pkg, module, name)
    if (target === ASSERT_KEY) {
      const obligation = objectAt(data, args[0])
      if (obligation !== undefined) checked.add(obligation)
    }
    if (target === REPAY) {
      const obligation = objectAt(data, args[1])
      if (obligation === undefined || !checked.has(obligation)) {
        refuse("This transaction repays a loan that isn't shown to be yours.")
      }
    }
  }
}

export interface ScallopPool {
  cash: bigint
  debt: bigint
  revenue: bigint
  receiptSupply: bigint
  /** Fixed point over 2^32, per `borrowRateScale` seconds. */
  borrowRate: bigint
  borrowRateScale: bigint
  /** Fixed point over 2^32. */
  revenueFactor: bigint
  /** When interest was last added, in seconds. Zero means the figures already include it. */
  updatedSeconds: number
}

export interface ScallopHolding {
  coinName: string
  amount: bigint
}

export interface ScallopObligation {
  id: string
  keyId: string
  collaterals: readonly ScallopHolding[]
  /** What is owed now, interest included. */
  debts: readonly ScallopHolding[]
  borrowLocked: boolean
  repayLocked: boolean
  withdrawLocked: boolean
}

export interface ScallopStanding extends LoanStanding {
  readings: readonly PythReading[]
}

export interface ScallopWeights {
  collateralFactor: number
  liquidationFactor: number
}

export interface PriceTarget {
  coinType: string
  priceObject: string
}

/** Chain reads, kept apart so the refusals can be tested without a network. */
export interface ScallopReader {
  pool: (coinType?: string) => Promise<ScallopPool>
  /** The receipts for this token this wallet holds, in base units. */
  receipts: (account: string, coinType?: string) => Promise<bigint>
  obligations: (account: string) => Promise<ScallopObligation[]>
  /** The position in dollars, by the contract's own figures, and the price of every coin named. */
  standing: (
    account: string,
    obligation: ScallopObligation,
    coinTypes: readonly string[]
  ) => Promise<ScallopStanding>
  weights: (coinType: string) => Promise<ScallopWeights>
  borrowFeePercent: (coinType: string) => Promise<number>
  walletBalance: (account: string, coinType: string) => Promise<bigint>
}

function unreadable(): never {
  return refuse("I couldn't read Scallop's pool, so I stopped. Try again shortly.")
}

/** Value in base units behind all receipts, as the SDK counts it. */
function poolValue(pool: ScallopPool): bigint {
  return pool.debt + (pool.cash > pool.revenue ? pool.cash - pool.revenue : BigInt(0))
}

/** Rounded up: interest only moves the share price up, so this never pays out less than asked. */
export function receiptsForAmount(amount: bigint, pool: ScallopPool): bigint {
  const value = poolValue(pool)
  if (value <= BigInt(0) || pool.receiptSupply <= BigInt(0)) unreadable()
  return (amount * pool.receiptSupply + value - BigInt(1)) / value
}

export function amountForReceipts(receipts: bigint, pool: ScallopPool): bigint {
  if (pool.receiptSupply <= BigInt(0)) unreadable()
  return (receipts * poolValue(pool)) / pool.receiptSupply
}

/** Borrowers' rate now, as a percent a year. */
export function scallopBorrowApr(pool: ScallopPool): number | undefined {
  const scale = Number(pool.borrowRateScale)
  if (scale <= 0) return undefined
  const percent = ((Number(pool.borrowRate) / FIXED_POINT_32) * SECONDS_PER_YEAR * 100) / scale
  return Number.isFinite(percent) ? Math.round(percent * 100) / 100 : undefined
}

/**
 * The SDK's `supplyApr`: the borrow rate the contract last set, at the pool's current
 * use, less Scallop's revenue share. Rewards are not counted.
 */
export function scallopSupplyApr(pool: ScallopPool): number | undefined {
  const value = Number(poolValue(pool))
  const scale = Number(pool.borrowRateScale)
  if (value <= 0 || scale <= 0) return undefined
  const borrowApr = ((Number(pool.borrowRate) / FIXED_POINT_32) * SECONDS_PER_YEAR) / scale
  const used = Number(pool.debt) / value
  const keptBySuppliers = 1 - Number(pool.revenueFactor) / FIXED_POINT_32
  const percent = borrowApr * used * keptBySuppliers * 100
  return Number.isFinite(percent) ? Math.round(percent * 100) / 100 : undefined
}

function scallopApy(pool: ScallopPool): PreparedAction['apy'] {
  const basePercent = scallopSupplyApr(pool)
  return basePercent === undefined ? undefined : { basePercent }
}

/** The contract's growth since `update_borrow_index` last ran, as a multiple scaled by 1e18. */
function indexGrowth(pool: ScallopPool, nowSeconds: number): bigint {
  const elapsed = nowSeconds - pool.updatedSeconds
  const scale = pool.borrowRateScale
  if (elapsed <= 0 || scale <= BigInt(0) || pool.updatedSeconds === 0) return BigInt(1e18)
  const added = (pool.borrowRate * BigInt(elapsed) * BigInt(1e18)) / BigInt(FIXED_POINT_32) / scale
  return BigInt(1e18) + added
}

/** The pool as the contract would have it at this moment. */
export function accruedPool(pool: ScallopPool, nowSeconds: number): ScallopPool {
  const growth = indexGrowth(pool, nowSeconds)
  const interest = (pool.debt * growth) / BigInt(1e18) - pool.debt
  const revenue = (interest * pool.revenueFactor) / BigInt(FIXED_POINT_32)
  return { ...pool, debt: pool.debt + interest, revenue: pool.revenue + revenue }
}

const BalanceSheet = bcs.struct('BalanceSheet', {
  cash: bcs.u64(),
  debt: bcs.u64(),
  revenue: bcs.u64(),
  market_coin_supply: bcs.u64(),
})
const BorrowDynamic = bcs.struct('BorrowDynamic', {
  interest_rate: bcs.u64(),
  interest_rate_scale: bcs.u64(),
  borrow_index: bcs.u64(),
  last_updated: bcs.u64(),
})
const InterestModel = bcs.struct('InterestModel', {
  type: bcs.string(),
  base_borrow_rate_per_sec: bcs.u64(),
  interest_rate_scale: bcs.u64(),
  borrow_rate_on_mid_kink: bcs.u64(),
  mid_kink: bcs.u64(),
  borrow_rate_on_high_kink: bcs.u64(),
  high_kink: bcs.u64(),
  max_borrow_rate: bcs.u64(),
  revenue_factor: bcs.u64(),
})
const RiskModel = bcs.struct('RiskModel', {
  type: bcs.string(),
  collateral_factor: bcs.u64(),
  liquidation_factor: bcs.u64(),
})
const Debt = bcs.struct('Debt', { amount: bcs.u64(), borrow_index: bcs.u64() })
const Collateral = bcs.struct('Collateral', { amount: bcs.u64() })
const CoinNameKey = bcs.string()

function typeNameKey(coinName: string) {
  return { type: '0x1::type_name::TypeName', bcs: CoinNameKey.serialize(coinName).toBytes() }
}

async function coinField(parentId: string, coinName: string): Promise<Uint8Array> {
  const { dynamicField } = await suiClient().core.getDynamicField({
    parentId,
    name: typeNameKey(coinName),
  })
  return dynamicField.value.bcs
}

/** Whichever coin a position holds, unlisted too, as long as its price can be read. */
function coinTypeOfName(coinName: string): string {
  return `0x${coinName}`
}

async function readPool(coinType: string): Promise<ScallopPool> {
  const name = coinTypeName(coinType)
  const [sheet, dynamics, model] = await Promise.all([
    coinField(SCALLOP_BALANCE_SHEETS, name),
    coinField(SCALLOP_BORROW_DYNAMICS, name),
    coinField(SCALLOP_INTEREST_MODELS, name),
  ])
  const { cash, debt, revenue, market_coin_supply: receiptSupply } = BalanceSheet.parse(sheet)
  const borrow = BorrowDynamic.parse(dynamics)
  const { type, revenue_factor: revenueFactor } = InterestModel.parse(model)
  if (type !== name) unreadable()
  return accruedPool(
    {
      cash: BigInt(cash),
      debt: BigInt(debt),
      revenue: BigInt(revenue),
      receiptSupply: BigInt(receiptSupply),
      borrowRate: BigInt(borrow.interest_rate),
      borrowRateScale: BigInt(borrow.interest_rate_scale),
      revenueFactor: BigInt(revenueFactor),
      updatedSeconds: Number(borrow.last_updated),
    },
    Math.floor(Date.now() / 1000)
  )
}

/** A debt now: what it was at its index, grown to where the index is at this moment. */
async function liveDebt(coinName: string, amount: bigint, atIndex: bigint): Promise<bigint> {
  const borrow = BorrowDynamic.parse(await coinField(SCALLOP_BORROW_DYNAMICS, coinName))
  const growth = indexGrowth(
    {
      borrowRate: BigInt(borrow.interest_rate),
      borrowRateScale: BigInt(borrow.interest_rate_scale),
      updatedSeconds: Number(borrow.last_updated),
    } as ScallopPool,
    Math.floor(Date.now() / 1000)
  )
  const indexNow = (BigInt(borrow.borrow_index) * growth) / BigInt(1e18)
  return (amount * indexNow + atIndex - BigInt(1)) / atIndex
}

interface ObligationJson {
  collaterals: { keys: { contents: string[] }; table: { id: string } }
  debts: { keys: { contents: string[] }; table: { id: string } }
  borrow_locked: boolean
  repay_locked: boolean
  withdraw_collateral_locked: boolean
}

async function readObligation(keyId: string, id: string): Promise<ScallopObligation> {
  const { object } = await suiClient().core.getObject({ objectId: id, include: { json: true } })
  const json = object.json as unknown as ObligationJson
  const collaterals = await Promise.all(
    json.collaterals.keys.contents.map(async (coinName) => {
      const row = await coinField(json.collaterals.table.id, coinName)
      return { coinName, amount: BigInt(Collateral.parse(row).amount) }
    })
  )
  const debts = await Promise.all(
    json.debts.keys.contents.map(async (coinName) => {
      const { amount, borrow_index: index } = Debt.parse(
        await coinField(json.debts.table.id, coinName)
      )
      return { coinName, amount: await liveDebt(coinName, BigInt(amount), BigInt(index)) }
    })
  )
  return {
    id,
    keyId,
    collaterals,
    debts,
    borrowLocked: json.borrow_locked,
    repayLocked: json.repay_locked,
    withdrawLocked: json.withdraw_collateral_locked,
  }
}

async function pythObjectFor(coinName: string): Promise<string> {
  const row = await coinField(SCALLOP_PYTH_REGISTRY_TABLE, coinName)
  return normalizeSuiAddress(bcs.Address.parse(row.slice(0, 32)))
}

/** Fills Scallop's oracle for one coin in this transaction. The rule refuses any other price object. */
function priceCoin(tx: Transaction, { coinType, priceObject }: PriceTarget): void {
  const [request] = tx.moveCall({
    target: PRICE_REQUEST,
    typeArguments: [coinType],
    arguments: [tx.object(SCALLOP_X_ORACLE)],
  })
  if (request === undefined) throw new Error('Asking for a price returned nothing.')
  tx.moveCall({
    target: PRICE_SET,
    typeArguments: [coinType],
    arguments: [
      request,
      tx.object(PYTH_STATE),
      tx.object(priceObject),
      tx.object(SCALLOP_PYTH_REGISTRY),
      tx.object.clock(),
    ],
  })
  tx.moveCall({
    target: PRICE_CONFIRM,
    typeArguments: [coinType],
    arguments: [tx.object(SCALLOP_X_ORACLE), request, tx.object.clock()],
  })
}

const chainReader: ScallopReader = {
  pool: (coinType = USDC_TYPE) => readPool(coinType),
  receipts: async (account, coinType = USDC_TYPE) => {
    const { balance } = await suiClient().core.getBalance({
      owner: account,
      coinType: receiptType(coinType),
    })
    return BigInt(balance.balance)
  },
  obligations: async (account) => {
    const client = suiClient()
    const keys: { keyId: string; id: string }[] = []
    let cursor: string | null | undefined
    for (let page = 0; page < MAX_KEY_PAGES; page++) {
      const owned = await client.core.listOwnedObjects({
        owner: account,
        type: `${SCALLOP_ORIGINAL_PACKAGE}::obligation::ObligationKey`,
        include: { json: true },
        ...(cursor ? { cursor } : {}),
      })
      for (const { objectId, json } of owned.objects) {
        const id = (json as { ownership?: { of?: unknown } } | null)?.ownership?.of
        if (typeof id !== 'string') unreadable()
        keys.push({ keyId: objectId, id })
      }
      if (!owned.hasNextPage) break
      cursor = owned.cursor
    }
    return Promise.all(keys.map(({ keyId, id }) => readObligation(keyId, id)))
  },
  standing: async (account, obligation, coinTypes) => {
    const names = [
      ...new Set([
        ...obligation.collaterals.map((c) => c.coinName),
        ...obligation.debts.map((d) => d.coinName),
        ...coinTypes.map(coinTypeName),
      ]),
    ]
    let targets: PriceTarget[]
    let readings: PythReading[]
    try {
      targets = await Promise.all(
        names.map(async (name) => ({
          coinType: coinTypeOfName(name),
          priceObject: await pythObjectFor(name),
        }))
      )
      readings = await Promise.all(targets.map((t) => readPythObject(t.priceObject)))
    } catch {
      return refuse(
        'Your Scallop position holds something I can only price at scallop.io, so this has to be done there.'
      )
    }
    assertPricesFresh(readings, PRICE_LIMIT_SECONDS, 'Scallop')

    const tx = new Transaction()
    tx.setSender(account)
    for (const target of targets) priceCoin(tx, target)
    const first = tx.getData().commands.length
    const valueArgs = () => [
      tx.object(obligation.id),
      tx.object(SCALLOP_MARKET),
      tx.object(SCALLOP_DECIMALS_REGISTRY),
      tx.object(SCALLOP_X_ORACLE),
      tx.object.clock(),
    ]
    tx.moveCall({
      target: moveTarget(SCALLOP_PACKAGE, 'collateral_value', 'collaterals_value_usd_for_borrow'),
      arguments: valueArgs(),
    })
    tx.moveCall({
      target: moveTarget(
        SCALLOP_PACKAGE,
        'collateral_value',
        'collaterals_value_usd_for_liquidation'
      ),
      arguments: valueArgs(),
    })
    tx.moveCall({
      target: moveTarget(SCALLOP_PACKAGE, 'debt_value', 'debts_value_usd_with_weight'),
      arguments: [
        tx.object(obligation.id),
        tx.object(SCALLOP_DECIMALS_REGISTRY),
        tx.object(SCALLOP_MARKET),
        tx.object(SCALLOP_X_ORACLE),
        tx.object.clock(),
      ],
    })
    const { Transaction: result, commandResults } = await suiClient().core.simulateTransaction({
      transaction: tx,
      checksEnabled: false,
      include: { effects: true, commandResults: true },
    })
    if (result?.effects?.status.success !== true || commandResults === undefined) {
      throw new Error("A read of Scallop's contracts did not run.")
    }
    const usd = (index: number): number => {
      const bytes = commandResults[first + index]?.returnValues[0]?.bcs
      if (bytes === undefined) throw new Error("Scallop's position read returned too little.")
      return Number(bcs.u64().parse(bytes)) / FIXED_POINT_32
    }
    return {
      limitUsd: usd(0),
      liquidationUsd: usd(1),
      owedUsd: usd(2),
      readings,
    }
  },
  weights: async (coinType) => {
    const row = await coinField(SCALLOP_RISK_MODELS, coinTypeName(coinType))
    const parsed = RiskModel.parse(row)
    return {
      collateralFactor: Number(parsed.collateral_factor) / FIXED_POINT_32,
      liquidationFactor: Number(parsed.liquidation_factor) / FIXED_POINT_32,
    }
  },
  borrowFeePercent: async (coinType) => {
    const { dynamicField } = await suiClient().core.getDynamicField({
      parentId: SCALLOP_MARKET,
      name: {
        type: `${SCALLOP_ORIGINAL_PACKAGE}::market_dynamic_keys::BorrowFeeKey`,
        bcs: CoinNameKey.serialize(coinTypeName(coinType)).toBytes(),
      },
    })
    return (Number(bcs.u64().parse(dynamicField.value.bcs)) / FIXED_POINT_32) * 100
  },
  walletBalance,
}

function checkedRequest(request: ChainActionRequest, account: string): ChainToken {
  assertSuiAccount(account)
  const token = tokenBySymbol(SUI_TOKENS, request.tokenIn)
  if (token?.symbol !== 'USDC') {
    refuse(`Scallop takes USDC here, not ${request.tokenIn}. Try "supply 10 USDC on Scallop".`)
  }
  return token
}

function checkedListed(request: ChainActionRequest, account: string): ChainToken {
  assertSuiAccount(account)
  const token = tokenBySymbol(SUI_TOKENS, request.tokenIn)
  if (token === undefined || !SCALLOP_SYMBOLS.includes(token.symbol)) {
    refuse(`Scallop doesn't take ${request.tokenIn} here. It takes ${SCALLOP_SYMBOLS.join(', ')}.`)
  }
  return token
}

function holdingOf(list: readonly ScallopHolding[], token: ChainToken): bigint {
  const name = coinTypeName(token.id)
  return list.find((h) => h.coinName === name)?.amount ?? BigInt(0)
}

async function quote(
  reader: ScallopReader,
  request: ChainActionRequest,
  account: string
): Promise<VenueQuote> {
  if (request.kind !== 'supply') return {}
  checkedRequest(request, account)
  return quotedApy(scallopApy(await reader.pool()))
}

async function prepareSupply(
  reader: ScallopReader,
  request: ChainActionRequest,
  account: string
): Promise<PreparedAction> {
  const token = checkedRequest(request, account)
  const amount = toBaseUnits(request.amount, token.decimals)
  const pool = await reader.pool()

  const tx = new Transaction()
  tx.setSender(account)
  const coin = tx.add(
    coinWithBalance({ type: token.id, balance: BigInt(amount), useGasCoin: false })
  )
  const [receipt] = tx.moveCall({
    target: MINT,
    typeArguments: [USDC_TYPE],
    arguments: [tx.object(SCALLOP_VERSION), tx.object(SCALLOP_MARKET), coin, tx.object.clock()],
  })
  if (receipt === undefined) throw new Error('Minting returned nothing.')
  tx.transferObjects([receipt], account)

  const transaction = await buildUnsigned(tx, suiClient(), token.symbol)
  const minted = await dryRunChange(
    transaction,
    SCALLOP_RECEIPT_TYPE,
    account,
    'Checking the deposit'
  )
  if (minted === undefined || minted <= BigInt(0)) {
    refuse(
      "I couldn't confirm how much this deposit would return, so I stopped. Try again shortly."
    )
  }
  const receive = displayAmount(minted.toString(), token.decimals)

  return {
    venueId: 'scallop',
    venueName: 'Scallop',
    kind: 'supply',
    summary: `Supply ${request.amount} USDC to Scallop for about ${receive} ${RECEIPT_SYMBOL} receipts.`,
    pay: { amount: request.amount, symbol: token.symbol },
    receive: { amount: receive, symbol: RECEIPT_SYMBOL, approximate: true },
    apy: scallopApy(pool),
    notes: [
      ...poolNotes({ availableUsdc: Number(pool.cash) / 1e6 }),
      'Your wallet gets receipts that grow in value, so you get fewer of them than the USDC you put in. You withdraw by handing them back, here or on Scallop. If you send them away, your deposit goes with them.',
      "A retired Scallop rewards contract lost about $142K (about 150,000 SUI) on April 26, 2026. Reports say deposits in Scallop's main contracts were not affected. I could not confirm that those who lost money were repaid.",
      "Scallop's team can upgrade these contracts through a multisig, which can change how they work.",
      'Receipts can’t back a loan on Scallop. Borrowing here needs collateral in a Scallop borrowing position, which you open at scallop.io.',
    ],
    signing: { family: 'sui', transaction },
  }
}

export interface ScallopCollateralOut {
  obligation: ScallopObligation
  amount: bigint
}

export function scallopWithdrawTransaction(
  account: string,
  coinType: string,
  receipts: bigint,
  collateral: readonly ScallopCollateralOut[],
  prices: readonly PriceTarget[]
): Transaction {
  const tx = new Transaction()
  tx.setSender(account)
  if (receipts > BigInt(0)) {
    const coin = tx.add(
      coinWithBalance({ type: receiptType(coinType), balance: receipts, useGasCoin: false })
    )
    const [out] = tx.moveCall({
      target: REDEEM,
      typeArguments: [coinType],
      arguments: [tx.object(SCALLOP_VERSION), tx.object(SCALLOP_MARKET), coin, tx.object.clock()],
    })
    if (out === undefined) throw new Error('Redeeming returned nothing.')
    tx.transferObjects([out], account)
  }
  for (const target of prices) priceCoin(tx, target)
  for (const { obligation, amount } of collateral) {
    const [out] = tx.moveCall({
      target: WITHDRAW_COLLATERAL,
      typeArguments: [coinType],
      arguments: [
        tx.object(SCALLOP_VERSION),
        tx.object(obligation.id),
        tx.object(obligation.keyId),
        tx.object(SCALLOP_MARKET),
        tx.object(SCALLOP_DECIMALS_REGISTRY),
        tx.pure.u64(amount),
        tx.object(SCALLOP_X_ORACLE),
        tx.object.clock(),
      ],
    })
    if (out === undefined) throw new Error('Withdrawing returned nothing.')
    tx.transferObjects([out], account)
  }
  return tx
}

export function scallopBorrowTransaction(
  account: string,
  coinType: string,
  amount: bigint,
  obligation: Pick<ScallopObligation, 'id' | 'keyId'>,
  prices: readonly PriceTarget[]
): Transaction {
  const tx = new Transaction()
  tx.setSender(account)
  for (const target of prices) priceCoin(tx, target)
  const [out] = tx.moveCall({
    target: BORROW,
    typeArguments: [coinType],
    arguments: [
      tx.object(SCALLOP_VERSION),
      tx.object(obligation.id),
      tx.object(obligation.keyId),
      tx.object(SCALLOP_MARKET),
      tx.object(SCALLOP_DECIMALS_REGISTRY),
      tx.pure.u64(amount),
      tx.object(SCALLOP_X_ORACLE),
      tx.object.clock(),
    ],
  })
  if (out === undefined) throw new Error('Borrowing returned nothing.')
  tx.transferObjects([out], account)
  return tx
}

export interface ScallopRepayment {
  obligation: Pick<ScallopObligation, 'id' | 'keyId'>
  coin: bigint
}

/** The contract takes what is owed and sends the rest of the coin back to the sender. */
export function scallopRepayTransaction(
  account: string,
  coinType: string,
  repayments: readonly ScallopRepayment[]
): Transaction {
  const tx = new Transaction()
  tx.setSender(account)
  const isSui = normalizeStructTag(coinType) === normalizeStructTag('0x2::sui::SUI')
  for (const { obligation, coin: amount } of repayments) {
    tx.moveCall({
      target: ASSERT_KEY,
      arguments: [tx.object(obligation.id), tx.object(obligation.keyId)],
    })
    const coin = tx.add(
      isSui
        ? coinWithBalance({ balance: amount })
        : coinWithBalance({ type: coinType, balance: amount, useGasCoin: false })
    )
    tx.moveCall({
      target: REPAY,
      typeArguments: [coinType],
      arguments: [
        tx.object(SCALLOP_VERSION),
        tx.object(obligation.id),
        tx.object(SCALLOP_MARKET),
        coin,
        tx.object.clock(),
      ],
    })
  }
  return tx
}

export const chainObligations = chainReader.obligations

export async function scallopPriceTargets(
  obligation: Pick<ScallopObligation, 'collaterals' | 'debts'>,
  also: readonly string[] = []
): Promise<PriceTarget[]> {
  const names = [
    ...new Set([
      ...obligation.collaterals.map((c) => c.coinName),
      ...obligation.debts.map((d) => d.coinName),
      ...also.map(coinTypeName),
    ]),
  ]
  return Promise.all(
    names.map(async (name) => ({
      coinType: coinTypeOfName(name),
      priceObject: await pythObjectFor(name),
    }))
  )
}

const WITHDRAW_NOTES = [
  'This is a small pool. If most of it is lent out, this can fail until borrowers repay.',
]

function priceOf(standing: ScallopStanding, index: number): number {
  const reading = standing.readings[index]
  if (reading === undefined) throw new Error('A price was not read.')
  return reading.priceUsd
}

async function prepareWithdraw(
  reader: ScallopReader,
  request: ChainActionRequest,
  account: string
): Promise<PreparedAction> {
  const token = checkedListed(request, account)
  const amount = BigInt(toBaseUnits(request.amount, token.decimals))
  const isWhole = request.wholePosition === true

  const [held, obligations] = await Promise.all([
    reader.receipts(account, token.id),
    reader.obligations(account),
  ])
  const backing = obligations.filter((o) => holdingOf(o.collaterals, token) > BigInt(0))
  if (held <= BigInt(0) && backing.length === 0) {
    refuse(
      `This wallet has no Scallop ${token.symbol} receipts I can redeem, and no ${token.symbol} in a Scallop borrowing position. A deposit made on Scallop itself may be held as sCoins or staked, and needs withdrawing at scallop.io.`
    )
  }
  const pool = await reader.pool(token.id)
  const worth = amountForReceipts(held, pool)
  const inCollateral = backing.reduce((sum, o) => sum + holdingOf(o.collaterals, token), BigInt(0))
  const total = worth + inCollateral
  if (!isWhole && !gaveWhatWasAsked(total, amount)) {
    const shown = displayAmount(total.toString(), token.decimals)
    refuse(
      inCollateral > BigInt(0)
        ? `You have about ${shown} ${token.symbol} on Scallop, which is less than ${request.amount}. Try ${shown}.`
        : `Your Scallop receipts are worth about ${shown} ${token.symbol}, which is less than ${request.amount}. Try ${shown}.`
    )
  }

  // Receipts first: they back no loan. Shares don't change with interest, so a whole withdraw
  // that hands all of them back leaves nothing behind.
  const fromReceipts = isWhole || worth <= amount ? held : receiptsForAmount(amount, pool)
  let remaining = isWhole ? inCollateral : amount > worth ? amount - worth : BigInt(0)
  const outs: ScallopCollateralOut[] = []
  // Positions with no loan go first, so a loan is only touched when it has to be.
  const ordered = [...backing].sort((a, b) => a.debts.length - b.debts.length)
  for (const obligation of ordered) {
    if (remaining <= BigInt(0)) break
    const has = holdingOf(obligation.collaterals, token)
    const take = has < remaining ? has : remaining
    outs.push({ obligation, amount: take })
    remaining -= take
  }

  const notes = [...WITHDRAW_NOTES]
  const targets = new Map<string, PriceTarget>()
  for (const { obligation, amount: taken } of outs) {
    if (obligation.withdrawLocked) {
      refuse(
        `Your ${token.symbol} on Scallop is held in a position locked for its rewards, so it has to be withdrawn at scallop.io.`
      )
    }
    for (const target of await scallopPriceTargets(obligation)) targets.set(target.coinType, target)
    if (obligation.debts.length === 0) continue
    const standing = await reader.standing(account, obligation, [token.id])
    const names = [
      ...new Set([
        ...obligation.collaterals.map((c) => c.coinName),
        ...obligation.debts.map((d) => d.coinName),
        coinTypeName(token.id),
      ]),
    ]
    const units = Number(taken) / 10 ** token.decimals
    const value = units * priceOf(standing, names.indexOf(coinTypeName(token.id)))
    const weights = await reader.weights(token.id)
    const health = assertWithdrawFits({
      venueName: 'Scallop',
      symbol: token.symbol,
      standing,
      removedLimitUsd: value * weights.collateralFactor,
      removedLiquidationUsd: value * weights.liquidationFactor,
      amount: units,
    })
    if (health !== undefined) notes.push(withdrawLoanNote(token.symbol, health))
  }

  const tx = scallopWithdrawTransaction(account, token.id, fromReceipts, outs, [
    ...targets.values(),
  ])
  const transaction = await buildUnsigned(tx, suiClient(), token.symbol)
  const received = await dryRunChange(transaction, token.id, account, 'Checking the withdrawal')
  if (received === undefined || !gaveWhatWasAsked(received, amount)) {
    refuse(
      "I couldn't confirm this withdrawal would return what you asked, so I stopped. Try again shortly."
    )
  }
  const receive = displayAmount(received.toString(), token.decimals)

  return {
    venueId: 'scallop',
    venueName: 'Scallop',
    kind: 'withdraw',
    summary: `Withdraw about ${receive} ${token.symbol} from Scallop to your wallet.`,
    pay: { amount: request.amount, symbol: token.symbol },
    receive: { amount: receive, symbol: token.symbol, approximate: true },
    notes,
    signing: { family: 'sui', transaction },
  }
}

async function prepareBorrow(
  reader: ScallopReader,
  request: ChainActionRequest,
  account: string
): Promise<PreparedAction> {
  const token = checkedListed(request, account)
  const amount = BigInt(toBaseUnits(request.amount, token.decimals))

  const obligations = (await reader.obligations(account)).filter((o) => o.collaterals.length > 0)
  if (obligations.length === 0) {
    refuse(
      'You have no collateral in a Scallop borrowing position, so there is nothing to borrow against. Savings receipts don’t count. You can open a position at scallop.io.'
    )
  }
  const unlocked = obligations.filter((o) => !o.borrowLocked)
  if (unlocked.length === 0) {
    refuse(
      'Your Scallop position is staked for its borrow rewards, and it has to be unstaked before it can borrow. Borrow at scallop.io.'
    )
  }
  // The contract won't lend a token against itself in the same position.
  const open = unlocked.filter((o) => holdingOf(o.collaterals, token) === BigInt(0))
  if (open.length === 0) {
    refuse(
      `Scallop won't lend ${token.symbol} against a position that holds ${token.symbol} as collateral. Borrow a different token.`
    )
  }

  const pool = await reader.pool(token.id)
  const standings = await Promise.all(
    open.map(async (obligation) => ({
      obligation,
      standing: await reader.standing(account, obligation, [token.id]),
    }))
  )
  const best = standings.reduce((a, b) =>
    b.standing.limitUsd - b.standing.owedUsd > a.standing.limitUsd - a.standing.owedUsd ? b : a
  )
  const names = [
    ...new Set([
      ...best.obligation.collaterals.map((c) => c.coinName),
      ...best.obligation.debts.map((d) => d.coinName),
      coinTypeName(token.id),
    ]),
  ]
  const price = priceOf(best.standing, names.indexOf(coinTypeName(token.id)))
  const health = assertBorrowFits({
    venueName: 'Scallop',
    symbol: token.symbol,
    standing: best.standing,
    addedOwedUsd: (Number(amount) / 10 ** token.decimals) * price,
    priceUsd: price,
  })
  const feePercent = await reader.borrowFeePercent(token.id)

  const tx = scallopBorrowTransaction(
    account,
    token.id,
    amount,
    best.obligation,
    await scallopPriceTargets(best.obligation, [token.id])
  )
  const transaction = await buildUnsigned(tx, suiClient(), token.symbol)
  const received = await dryRunChange(transaction, token.id, account, 'Checking the borrow')
  // The fee comes out of what is paid, and the full amount is owed.
  const expected = amount - BigInt(Math.ceil((Number(amount) * feePercent) / 100))
  if (received === undefined || !gaveWhatWasAsked(received, expected)) {
    refuse(
      "I couldn't confirm this borrow would pay what you asked, so I stopped. Try again shortly."
    )
  }

  return {
    venueId: 'scallop',
    venueName: 'Scallop',
    kind: 'borrow',
    summary: `Borrow ${request.amount} ${token.symbol} from Scallop at a variable rate.`,
    pay: { amount: request.amount, symbol: token.symbol },
    receive: {
      amount: displayAmount(received.toString(), token.decimals),
      symbol: token.symbol,
      approximate: false,
    },
    notes: [
      ...borrowNotes({
        venueName: 'Scallop',
        symbol: token.symbol,
        health,
        borrowAprPercent: scallopBorrowApr(pool),
      }),
      ...(feePercent > 0
        ? [
            `Scallop takes a fee of about ${Math.round(feePercent * 100) / 100}% out of what you receive, and you owe the full ${request.amount} ${token.symbol}.`,
          ]
        : []),
      'This needs prices others publish on chain within the last 30 seconds. If they run late, this fails and only the network fee is lost.',
      "Scallop's team can upgrade these contracts through a multisig, which can change how they work.",
    ],
    signing: { family: 'sui', transaction },
  }
}

async function prepareRepay(
  reader: ScallopReader,
  request: ChainActionRequest,
  account: string
): Promise<PreparedAction> {
  const token = checkedListed(request, account)
  const asked = BigInt(toBaseUnits(request.amount, token.decimals))
  const isWhole = request.wholePosition === true

  const loans = (await reader.obligations(account)).filter(
    (o) => holdingOf(o.debts, token) > BigInt(0)
  )
  if (loans.length === 0) refuse(`You don't owe any ${token.symbol} on Scallop.`)
  const free = loans.filter((o) => !o.repayLocked)
  if (free.length === 0 || (isWhole && free.length < loans.length)) {
    refuse(
      'Your Scallop loan is staked for its borrow rewards, and it has to be unstaked before it can be repaid. Repay at scallop.io.'
    )
  }

  const largest = free.reduce((a, b) =>
    holdingOf(b.debts, token) > holdingOf(a.debts, token) ? b : a
  )
  const targets = isWhole ? free : [largest]
  const owed = targets.reduce((sum, o) => sum + holdingOf(o.debts, token), BigInt(0))
  let held = await reader.walletBalance(account, token.id)
  const repayments = targets.map((obligation) => {
    const coin = repayCoinAmount({
      asked,
      owed: holdingOf(obligation.debts, token),
      whole: isWhole,
      held,
      symbol: token.symbol,
      decimals: token.decimals,
    })
    held -= coin
    return { obligation, coin }
  })
  const clearing = isWhole || asked >= holdingOf(largest.debts, token)

  const tx = scallopRepayTransaction(account, token.id, repayments)
  const transaction = await buildUnsigned(tx, suiClient(), token.symbol)
  const change = await dryRunChange(transaction, token.id, account, 'Checking the repayment')
  const paid = change === undefined ? undefined : -change
  if (paid === undefined || !gaveWhatWasAsked(paid, clearing ? owed : asked)) {
    refuse("I couldn't confirm what this repayment would do, so I stopped. Try again shortly.")
  }
  const shown = displayAmount(paid.toString(), token.decimals)

  return {
    venueId: 'scallop',
    venueName: 'Scallop',
    kind: 'repay',
    summary: clearing
      ? `Repay your whole ${token.symbol} loan on Scallop, about ${shown} ${token.symbol}, interest included.`
      : `Repay ${request.amount} ${token.symbol} of your loan on Scallop.`,
    pay: { amount: shown, symbol: token.symbol },
    notes: [
      `You owe about ${displayAmount(owed.toString(), token.decimals)} ${token.symbol} on Scallop, interest included.`,
      clearing
        ? 'This offers a little more than that, to cover interest added before you sign. Only what you owe is taken, and the rest stays in your wallet.'
        : 'Interest keeps adding to what is left, and a loan can still be liquidated until it is paid off.',
    ],
    signing: { family: 'sui', transaction },
  }
}

/**
 * Only tokens this app lists are reported: nothing else can be acted on here. sCoins and
 * deposits staked on Scallop's own site are not read.
 */
export async function readScallopPositions(
  reader: ScallopReader,
  account: string
): Promise<VenuePosition[]> {
  assertSuiAccount(account)
  const [obligations, receipts] = await Promise.all([
    reader.obligations(account),
    Promise.all(LISTED_TYPES.map((type) => reader.receipts(account, type))),
  ])
  const rows = await Promise.all(
    SCALLOP_SYMBOLS.map(async (symbol, i): Promise<VenuePosition[]> => {
      const token = SUI_TOKENS.find((t) => t.symbol === symbol)
      if (token === undefined) return []
      const row: VenuePosition[] = []
      const held = receipts[i] ?? BigInt(0)
      const worth =
        held > BigInt(0) ? amountForReceipts(held, await reader.pool(token.id)) : BigInt(0)
      const supplied = obligations.reduce((sum, o) => sum + holdingOf(o.collaterals, token), worth)
      const owed = obligations.reduce((sum, o) => sum + holdingOf(o.debts, token), BigInt(0))
      if (supplied > BigInt(0)) {
        row.push({
          slot: 'supplied',
          symbol,
          amount: displayAmount(supplied.toString(), token.decimals),
        })
      }
      if (owed > BigInt(0)) {
        row.push({
          slot: 'borrowed',
          symbol,
          amount: displayAmount(owed.toString(), token.decimals),
        })
      }
      return row
    })
  )
  return rows.flat()
}

export function createScallopVenue(reader: ScallopReader = chainReader): ChainVenue {
  return {
    id: 'scallop',
    name: 'Scallop',
    kinds: ['supply', 'withdraw', 'borrow', 'repay'],
    assertCanFollow: takesOnly('Scallop', ['USDC']),
    quote: (request, account) => quote(reader, request, account),
    prepare: (request, account) => {
      if (request.kind === 'withdraw') return prepareWithdraw(reader, request, account)
      if (request.kind === 'borrow') return prepareBorrow(reader, request, account)
      if (request.kind === 'repay') return prepareRepay(reader, request, account)
      return prepareSupply(reader, request, account)
    },
    positions: (account) => readScallopPositions(reader, account),
    assertSafe: (payload: SigningPayload, account: string) => {
      assertPtbSafe(payload, account, SCALLOP_POLICY)
      assertCallsPinned(payload, PINS, 'Scallop')
      assertRepaysOwnLoan(payload)
    },
  }
}

export const scallopVenue = createScallopVenue()
