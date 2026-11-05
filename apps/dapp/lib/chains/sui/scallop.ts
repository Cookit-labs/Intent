import { bcs } from '@mysten/sui/bcs'
import { coinWithBalance, Transaction } from '@mysten/sui/transactions'

import {
  ChainActionRefused,
  quotedApy,
  takesOnly,
  tokenBySymbol,
  toBaseUnits,
  type ChainActionRequest,
  type ChainToken,
  type ChainVenue,
  type PreparedAction,
  type SigningPayload,
  type VenueQuote,
} from '../types'
import { assertSuiAccount, buildUnsigned, suiClient } from './client'
import {
  assertCallsPinned,
  coinTypeName,
  dryRunChange,
  gaveWhatWasAsked,
  pinnedPolicy,
  type PinnedCalls,
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

const USDC = SUI_TOKENS.find((t) => t.symbol === 'USDC')
if (USDC === undefined) throw new Error('USDC is missing from the Sui token table.')
const USDC_TYPE = USDC.id
export const SCALLOP_RECEIPT_TYPE = `${SCALLOP_ORIGINAL_PACKAGE}::reserve::MarketCoin<${USDC_TYPE}>`
const RECEIPT_SYMBOL = 'Scallop USDC'
const SECONDS_PER_YEAR = 31_536_000
const FIXED_POINT_32 = 2 ** 32

const versionAndMarket = { objects: { 0: SCALLOP_VERSION, 1: SCALLOP_MARKET } }
const MINT = moveTarget(SCALLOP_PACKAGE, 'mint', 'mint')
const REDEEM = moveTarget(SCALLOP_PACKAGE, 'redeem', 'redeem')

/** Neither call names a recipient. Each returns a coin, and the transaction's transfers must pay the signer. */
const PINS: PinnedCalls = new Map([
  [MINT, { typeArguments: [USDC_TYPE], argumentCount: 4, ...versionAndMarket }],
  [REDEEM, { typeArguments: [USDC_TYPE], argumentCount: 4, ...versionAndMarket }],
])

export const SCALLOP_POLICY = pinnedPolicy('Scallop', PINS)

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
}

/** Chain reads, kept apart so the refusals can be tested without a network. */
export interface ScallopReader {
  pool: () => Promise<ScallopPool>
  /** The USDC receipts this wallet holds, in base units. */
  receipts: (account: string) => Promise<bigint>
}

function unreadable(): never {
  throw new ChainActionRefused(
    "I couldn't read Scallop's USDC pool, so I stopped. Nothing was signed or sent. Try again shortly."
  )
}

/** Value in USDC base units behind all receipts, as the SDK counts it. */
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

const BalanceSheet = bcs.struct('BalanceSheet', {
  cash: bcs.u64(),
  debt: bcs.u64(),
  revenue: bcs.u64(),
  market_coin_supply: bcs.u64(),
})
const BorrowDynamic = bcs.struct('BorrowDynamic', {
  interest_rate: bcs.u64(),
  interest_rate_scale: bcs.u64(),
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

async function usdcField(parentId: string): Promise<Uint8Array> {
  const { dynamicField } = await suiClient().core.getDynamicField({
    parentId,
    name: {
      type: '0x1::type_name::TypeName',
      bcs: bcs.string().serialize(coinTypeName(USDC_TYPE)).toBytes(),
    },
  })
  return dynamicField.value.bcs
}

const chainReader: ScallopReader = {
  pool: async () => {
    const [sheet, dynamics, model] = await Promise.all([
      usdcField(SCALLOP_BALANCE_SHEETS),
      usdcField(SCALLOP_BORROW_DYNAMICS),
      usdcField(SCALLOP_INTEREST_MODELS),
    ])
    const { cash, debt, revenue, market_coin_supply: receiptSupply } = BalanceSheet.parse(sheet)
    const { interest_rate: borrowRate, interest_rate_scale: borrowRateScale } =
      BorrowDynamic.parse(dynamics)
    const { type, revenue_factor: revenueFactor } = InterestModel.parse(model)
    if (type !== coinTypeName(USDC_TYPE)) unreadable()
    return {
      cash: BigInt(cash),
      debt: BigInt(debt),
      revenue: BigInt(revenue),
      receiptSupply: BigInt(receiptSupply),
      borrowRate: BigInt(borrowRate),
      borrowRateScale: BigInt(borrowRateScale),
      revenueFactor: BigInt(revenueFactor),
    }
  },
  receipts: async (account) => {
    const { balance } = await suiClient().core.getBalance({
      owner: account,
      coinType: SCALLOP_RECEIPT_TYPE,
    })
    return BigInt(balance.balance)
  },
}

function checkedRequest(request: ChainActionRequest, account: string): ChainToken {
  assertSuiAccount(account)
  const token = tokenBySymbol(SUI_TOKENS, request.tokenIn)
  if (token?.symbol !== 'USDC') {
    throw new ChainActionRefused(
      `Scallop takes USDC here, not ${request.tokenIn}. Nothing was signed or sent. Try "supply 10 USDC on Scallop".`
    )
  }
  return token
}

async function quote(
  reader: ScallopReader,
  request: ChainActionRequest,
  account: string
): Promise<VenueQuote> {
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
    throw new ChainActionRefused(
      "I couldn't confirm how much this deposit would return, so I stopped. Nothing was signed or sent. Try again shortly."
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
    ],
    signing: { family: 'sui', transaction },
  }
}

async function prepareWithdraw(
  reader: ScallopReader,
  request: ChainActionRequest,
  account: string
): Promise<PreparedAction> {
  const token = checkedRequest(request, account)
  const amount = BigInt(toBaseUnits(request.amount, token.decimals))

  const held = await reader.receipts(account)
  if (held <= BigInt(0)) {
    throw new ChainActionRefused(
      'This wallet has no Scallop USDC receipts I can redeem. A deposit made on Scallop itself may be held as sUSDC or staked, and needs withdrawing at scallop.io. Nothing was signed or sent.'
    )
  }
  const pool = await reader.pool()
  const receipts = receiptsForAmount(amount, pool)
  if (receipts > held) {
    const worth = displayAmount(amountForReceipts(held, pool).toString(), token.decimals)
    throw new ChainActionRefused(
      `Your Scallop receipts are worth about ${worth} USDC, which is less than ${request.amount}. Nothing was signed or sent. Try ${worth}.`
    )
  }

  const tx = new Transaction()
  tx.setSender(account)
  const coin = tx.add(
    coinWithBalance({ type: SCALLOP_RECEIPT_TYPE, balance: receipts, useGasCoin: false })
  )
  const [usdc] = tx.moveCall({
    target: REDEEM,
    typeArguments: [USDC_TYPE],
    arguments: [tx.object(SCALLOP_VERSION), tx.object(SCALLOP_MARKET), coin, tx.object.clock()],
  })
  if (usdc === undefined) throw new Error('Redeeming returned nothing.')
  tx.transferObjects([usdc], account)

  const transaction = await buildUnsigned(tx, suiClient(), token.symbol)
  const received = await dryRunChange(transaction, token.id, account, 'Checking the withdrawal')
  if (received === undefined || !gaveWhatWasAsked(received, amount)) {
    throw new ChainActionRefused(
      "I couldn't confirm this withdrawal would return what you asked, so I stopped. Nothing was signed or sent. Try again shortly."
    )
  }
  const receive = displayAmount(received.toString(), token.decimals)

  return {
    venueId: 'scallop',
    venueName: 'Scallop',
    kind: 'withdraw',
    summary: `Withdraw about ${receive} USDC from Scallop to your wallet.`,
    pay: { amount: request.amount, symbol: token.symbol },
    receive: { amount: receive, symbol: token.symbol, approximate: true },
    notes: [
      'This is a small pool. If most of it is lent out, this can fail until borrowers repay.',
    ],
    signing: { family: 'sui', transaction },
  }
}

export function createScallopVenue(reader: ScallopReader = chainReader): ChainVenue {
  return {
    id: 'scallop',
    name: 'Scallop',
    kinds: ['supply', 'withdraw'],
    assertCanFollow: takesOnly('Scallop', ['USDC']),
    quote: (request, account) => quote(reader, request, account),
    prepare: (request, account) =>
      request.kind === 'withdraw'
        ? prepareWithdraw(reader, request, account)
        : prepareSupply(reader, request, account),
    assertSafe: (payload: SigningPayload, account: string) => {
      assertPtbSafe(payload, account, SCALLOP_POLICY)
      assertCallsPinned(payload, PINS, 'Scallop')
    },
  }
}

export const scallopVenue = createScallopVenue()
