import { coinWithBalance, Transaction } from '@mysten/sui/transactions'
import { fromBase64 } from '@mysten/sui/utils'

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
  u64Bytes,
  type PinnedCalls,
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

const CAP_TYPE = `${SUILEND_ORIGINAL_PACKAGE}::lending_market::ObligationOwnerCap<${SUILEND_MAIN_POOL}>`
const WAD = BigInt('1000000000000000000')
const MAX_CAP_PAGES = 5

const USDC = SUI_TOKENS.find((t) => t.symbol === 'USDC')
if (USDC === undefined) throw new Error('USDC is missing from the Sui token table.')
const USDC_TYPE = USDC.id
const USDC_NAME = coinTypeName(USDC_TYPE)
const USDC_TYPES = [SUILEND_MAIN_POOL, USDC_TYPE]
const USDC_RESERVE_BYTES = u64Bytes(SUILEND_USDC_RESERVE)
const EXEMPTION_TYPE = `${SUILEND_ORIGINAL_PACKAGE}::lending_market::RateLimiterExemption<${SUILEND_MAIN_POOL}, ${USDC_TYPE}>`

function fn(name: string): string {
  return moveTarget(SUILEND_PACKAGE, 'lending_market', name)
}

const marketAndReserve = {
  objects: { 0: SUILEND_MARKET },
  pure: { 1: USDC_RESERVE_BYTES },
}

/**
 * Nothing here can credit anyone but the signer: every call that touches a position
 * takes the owner cap, which only its holder can pass. `repay` is left out because it
 * takes a bare obligation id, so it could pay down a stranger's loan.
 */
const PINS: PinnedCalls = new Map([
  [
    fn('create_obligation'),
    { typeArguments: [SUILEND_MAIN_POOL], argumentCount: 1, objects: { 0: SUILEND_MARKET } },
  ],
  [
    fn('deposit_liquidity_and_mint_ctokens'),
    { typeArguments: USDC_TYPES, argumentCount: 4, ...marketAndReserve },
  ],
  [
    fn('deposit_ctokens_into_obligation'),
    { typeArguments: USDC_TYPES, argumentCount: 5, ...marketAndReserve },
  ],
  [fn('withdraw_ctokens'), { typeArguments: USDC_TYPES, argumentCount: 5, ...marketAndReserve }],
  [
    fn('redeem_ctokens_and_withdraw_liquidity_request'),
    { typeArguments: USDC_TYPES, argumentCount: 5, ...marketAndReserve },
  ],
  [
    fn('fulfill_liquidity_request'),
    { typeArguments: USDC_TYPES, argumentCount: 3, ...marketAndReserve },
  ],
  // The redeem's rate-limit exemption, as none. A real one only comes from a liquidation.
  [moveTarget('0x1', 'option', 'none'), { typeArguments: [EXEMPTION_TYPE], argumentCount: 0 }],
])

export const SUILEND_POLICY = pinnedPolicy('Suilend', PINS)

export interface SuilendReserve {
  available: bigint
  ctokenSupply: bigint
  borrowedWad: bigint
  spreadFeesWad: bigint
  depositLimit: bigint
  utilsPercent: readonly number[]
  aprsBps: readonly number[]
  spreadFeeBps: number
}

export interface SuilendPosition {
  capId: string
  obligationId: string
  /** cTokens of USDC deposited. Zero when the position holds none. */
  ctokens: bigint
  hasBorrows: boolean
}

/** Chain reads, kept apart so the refusals can be tested without a network. */
export interface SuilendReader {
  reserve: () => Promise<SuilendReserve>
  positions: (account: string) => Promise<SuilendPosition[]>
}

function unreadable(): never {
  throw new ChainActionRefused(
    "I couldn't read Suilend's USDC market, so I stopped. Nothing was signed or sent. Try again shortly."
  )
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

export function parseSuilendReserve(market: unknown): SuilendReserve {
  const reserves = record(market)['reserves']
  const raw = Array.isArray(reserves) ? record(reserves[SUILEND_USDC_RESERVE]) : unreadable()
  if (raw['coin_type'] !== USDC_NAME) unreadable()
  const config = record(record(raw['config'])['element'])
  const utilsRaw = config['interest_rate_utils']
  const aprsRaw = config['interest_rate_aprs']
  if (typeof utilsRaw !== 'string' || !Array.isArray(aprsRaw)) unreadable()
  return {
    available: whole(raw['available_amount']),
    ctokenSupply: whole(raw['ctoken_supply']),
    borrowedWad: decimalValue(raw['borrowed_amount']),
    spreadFeesWad: decimalValue(raw['unclaimed_spread_fees']),
    depositLimit: whole(config['deposit_limit']),
    utilsPercent: [...fromBase64(utilsRaw)],
    aprsBps: aprsRaw.map((apr) => Number(whole(apr))),
    spreadFeeBps: Number(whole(config['spread_fee_bps'])),
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

/**
 * The base rate from the contract's own curve: borrowers' rate at the current use of
 * the pool, shared across all deposits, less Suilend's spread. This is the SDK's
 * `calculateDepositAprPercent`. Rewards are not counted, and no rate is shown if the
 * curve doesn't read.
 */
export function suilendSupplyApr(reserve: SuilendReserve): number | undefined {
  const borrowed = Number(reserve.borrowedWad / WAD)
  const available = Number(reserve.available)
  const { utilsPercent: utils, aprsBps: aprs } = reserve
  if (borrowed + available <= 0 || utils.length !== aprs.length || utils.length < 2) {
    return undefined
  }
  const usedPercent = (borrowed / (borrowed + available)) * 100
  const upper = utils.findIndex((util) => util >= usedPercent)
  if (usedPercent === 0) return 0
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
  const borrowBps = lowApr + ((usedPercent - lowUtil) / (highUtil - lowUtil)) * (highApr - lowApr)
  const percent = (usedPercent / 100) * (borrowBps / 100) * (1 - reserve.spreadFeeBps / 10_000)
  return Number.isFinite(percent) ? Math.round(percent * 100) / 100 : undefined
}

function suilendApy(reserve: SuilendReserve): PreparedAction['apy'] {
  const basePercent = suilendSupplyApr(reserve)
  return basePercent === undefined ? undefined : { basePercent }
}

const chainReader: SuilendReader = {
  reserve: async () => {
    const { object } = await suiClient().core.getObject({
      objectId: SUILEND_MARKET,
      include: { json: true },
    })
    return parseSuilendReserve(object.json)
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
        const usdc = deposits.map(record).find((d) => d['coin_type'] === USDC_NAME)
        return {
          capId,
          obligationId,
          ctokens: usdc === undefined ? BigInt(0) : whole(usdc['deposited_ctoken_amount']),
          hasBorrows: borrows.length > 0,
        }
      })
    )
  },
}

function checkedRequest(request: ChainActionRequest, account: string): ChainToken {
  assertSuiAccount(account)
  const token = tokenBySymbol(SUI_TOKENS, request.tokenIn)
  if (token?.symbol !== 'USDC') {
    throw new ChainActionRefused(
      `Suilend takes USDC here, not ${request.tokenIn}. Nothing was signed or sent. Try "supply 10 USDC on Suilend".`
    )
  }
  return token
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

/**
 * Only a position with no loan is reused, so a deposit never becomes collateral by
 * accident and can always leave without a fresh price.
 */
export function positionForSupply(
  positions: readonly SuilendPosition[]
): SuilendPosition | undefined {
  const free = positions.filter((p) => !p.hasBorrows)
  return free.find((p) => p.ctokens > BigInt(0)) ?? free[0]
}

async function quote(
  reader: SuilendReader,
  request: ChainActionRequest,
  account: string
): Promise<VenueQuote> {
  checkedRequest(request, account)
  return quotedApy(suilendApy(await reader.reserve()))
}

async function prepareSupply(
  reader: SuilendReader,
  request: ChainActionRequest,
  account: string
): Promise<PreparedAction> {
  const token = checkedRequest(request, account)
  const amount = toBaseUnits(request.amount, token.decimals)
  const reserve = await reader.reserve()
  if (totalLiquidity(reserve) + BigInt(amount) > reserve.depositLimit) {
    throw new ChainActionRefused(
      "Suilend's USDC market is at its deposit limit. Nothing was signed or sent. Try a smaller amount or another venue."
    )
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
    throw new ChainActionRefused(
      "I couldn't confirm what this deposit would do, so I stopped. Nothing was signed or sent. Try again shortly."
    )
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
  const token = checkedRequest(request, account)
  const amount = BigInt(toBaseUnits(request.amount, token.decimals))

  const holding = (await reader.positions(account)).filter((p) => p.ctokens > BigInt(0))
  if (holding.length === 0) {
    throw new ChainActionRefused('This wallet has no USDC in Suilend. Nothing was signed or sent.')
  }
  const free = holding.filter((p) => !p.hasBorrows)
  if (free.length === 0) {
    // With a loan the contract wants fresh prices, which public Pyth access no longer gives without a key.
    throw new ChainActionRefused(
      'Your USDC in Suilend backs a loan, and I only withdraw from positions with no loan. Repay or withdraw at suilend.fi. Nothing was signed or sent.'
    )
  }
  const position = free.reduce((best, p) => (p.ctokens > best.ctokens ? p : best))

  const reserve = await reader.reserve()
  const ctokens = ctokensForAmount(amount, reserve)
  if (ctokens > position.ctokens) {
    const held = displayAmount(
      amountForCtokens(position.ctokens, reserve).toString(),
      token.decimals
    )
    throw new ChainActionRefused(
      `You have about ${held} USDC in Suilend, which is less than ${request.amount}. Nothing was signed or sent. Try ${held}.`
    )
  }

  const tx = new Transaction()
  tx.setSender(account)
  const [out] = tx.moveCall({
    target: fn('withdraw_ctokens'),
    typeArguments: USDC_TYPES,
    arguments: [
      tx.object(SUILEND_MARKET),
      tx.pure.u64(SUILEND_USDC_RESERVE),
      tx.object(position.capId),
      tx.object.clock(),
      tx.pure.u64(ctokens),
    ],
  })
  const [exemption] = tx.moveCall({
    target: moveTarget('0x1', 'option', 'none'),
    typeArguments: [EXEMPTION_TYPE],
  })
  if (out === undefined || exemption === undefined) throw new Error('A step returned nothing.')
  const [liquidityRequest] = tx.moveCall({
    target: fn('redeem_ctokens_and_withdraw_liquidity_request'),
    typeArguments: USDC_TYPES,
    arguments: [
      tx.object(SUILEND_MARKET),
      tx.pure.u64(SUILEND_USDC_RESERVE),
      tx.object.clock(),
      out,
      exemption,
    ],
  })
  if (liquidityRequest === undefined) throw new Error('Redeeming returned nothing.')
  const [usdc] = tx.moveCall({
    target: fn('fulfill_liquidity_request'),
    typeArguments: USDC_TYPES,
    arguments: [tx.object(SUILEND_MARKET), tx.pure.u64(SUILEND_USDC_RESERVE), liquidityRequest],
  })
  if (usdc === undefined) throw new Error('Withdrawing returned nothing.')
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
    venueId: 'suilend',
    venueName: 'Suilend',
    kind: 'withdraw',
    summary: `Withdraw about ${receive} USDC from Suilend's main market to your wallet.`,
    pay: { amount: request.amount, symbol: token.symbol },
    receive: { amount: receive, symbol: token.symbol, approximate: true },
    notes: [
      'Suilend limits how much can leave the whole market each hour, so a large withdrawal may need to wait.',
      'If the pool has little cash because most of it is lent out, this can fail until borrowers repay.',
      'This does not claim reward tokens. Any you have earned stay claimable at suilend.fi.',
    ],
    signing: { family: 'sui', transaction },
  }
}

export function createSuilendVenue(reader: SuilendReader = chainReader): ChainVenue {
  return {
    id: 'suilend',
    name: 'Suilend',
    kinds: ['supply', 'withdraw'],
    assertCanFollow: takesOnly('Suilend', ['USDC']),
    quote: (request, account) => quote(reader, request, account),
    prepare: (request, account) =>
      request.kind === 'withdraw'
        ? prepareWithdraw(reader, request, account)
        : prepareSupply(reader, request, account),
    assertSafe: (payload: SigningPayload, account: string) => {
      assertPtbSafe(payload, account, SUILEND_POLICY)
      assertCallsPinned(payload, PINS, 'Suilend')
    },
  }
}

export const suilendVenue = createSuilendVenue()
