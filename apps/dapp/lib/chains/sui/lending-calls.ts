import { bcs } from '@mysten/sui/bcs'
import { Transaction } from '@mysten/sui/transactions'
import { fromBase64, normalizeStructTag, normalizeSuiAddress, toBase64 } from '@mysten/sui/utils'

import { ChainActionRefused, type SigningPayload } from '../types'
import { suiClient, withTimeout } from './client'
import type { PtbPolicy } from './safety'
import { moveTarget } from './safety'
import { displayAmount } from './tokens'

/**
 * What the Sui lending venues share. `assertPtbSafe` reads targets, signer and
 * recipients. It can't see object inputs, so this adds what an allowed call may be
 * pointed at: the token, the market and the literals.
 */
export interface PinnedCall {
  /** Nothing for a call that moves no money and may price any coin. */
  typeArguments: readonly string[] | undefined
  argumentCount: number
  /** The object that must sit at an argument position. */
  objects?: Readonly<Record<number, string>> | undefined
  /** The literal bytes that must sit at an argument position, as base64. */
  pure?: Readonly<Record<number, string>> | undefined
}

/** A call is pinned to one shape, or to any of several: one per coin the venue handles. */
export type PinnedCalls = ReadonlyMap<string, PinnedCall | readonly PinnedCall[]>

export function u64Bytes(value: number): string {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true)
  return toBase64(bytes)
}

export function pinnedPolicy(venueName: string, pins: PinnedCalls): PtbPolicy {
  return { venueName, allowedCalls: new Set(pins.keys()) }
}

export function refuse(reason: string): never {
  throw new ChainActionRefused(`${reason} Nothing was signed or sent.`)
}

type TxData = ReturnType<Transaction['getData']>
type MoveCall = Extract<TxData['commands'][number], { $kind: 'MoveCall' }>['MoveCall']

/** The object id an argument points at, or nothing when it is not an object input. */
export function objectAt(data: TxData, argument: MoveCall['arguments'][number] | undefined) {
  const input = argument?.$kind === 'Input' ? data.inputs[argument.Input] : undefined
  const object = input?.$kind === 'Object' ? input.Object : undefined
  const id =
    object?.$kind === 'SharedObject'
      ? object.SharedObject.objectId
      : object?.$kind === 'ImmOrOwnedObject'
        ? object.ImmOrOwnedObject.objectId
        : undefined
  return id === undefined ? undefined : normalizeSuiAddress(id)
}

/** How far a call got against a pin, so a refusal names the mismatch that matters. */
function mismatch(
  data: TxData,
  call: MoveCall,
  pin: PinnedCall,
  venueName: string
): { depth: number; reason: string } | undefined {
  const label = `${call.module}::${call.function}`
  const { typeArguments: types, arguments: args } = call
  if (args.length !== pin.argumentCount) {
    return {
      depth: 0,
      reason: `This transaction passes ${label} the wrong arguments for ${venueName}.`,
    }
  }
  const sameTypes =
    pin.typeArguments === undefined ||
    (types.length === pin.typeArguments.length &&
      types.every(
        (type, i) => normalizeStructTag(type) === normalizeStructTag(pin.typeArguments?.[i] ?? '')
      ))
  if (!sameTypes) {
    return {
      depth: 1,
      reason: `This transaction uses a token ${venueName} isn't confirmed for.`,
    }
  }
  for (const [index, wanted] of Object.entries(pin.objects ?? {})) {
    if (objectAt(data, args[Number(index)]) !== normalizeSuiAddress(wanted)) {
      return {
        depth: 2,
        reason: `This transaction points ${label} at an object ${venueName} doesn't use.`,
      }
    }
  }
  for (const [index, wanted] of Object.entries(pin.pure ?? {})) {
    const argument = args[Number(index)]
    const input = argument?.$kind === 'Input' ? data.inputs[argument.Input] : undefined
    if (input?.$kind !== 'Pure' || input.Pure.bytes !== wanted) {
      return {
        depth: 3,
        reason: `This transaction passes ${label} a value ${venueName} doesn't use.`,
      }
    }
  }
  return undefined
}

/** Run after `assertPtbSafe`, which has already refused anything not allowed. */
export function assertCallsPinned(
  payload: SigningPayload,
  pins: PinnedCalls,
  venueName: string
): void {
  if (payload.family !== 'sui') refuse('That is not a Sui transaction.')
  const data = Transaction.from(fromBase64(payload.transaction)).getData()

  for (const command of data.commands) {
    if (command.$kind !== 'MoveCall') continue
    const call = command.MoveCall
    const pin = pins.get(moveTarget(call.package, call.module, call.function))
    if (pin === undefined) continue
    const shapes: readonly PinnedCall[] = 'argumentCount' in pin ? [pin] : pin
    const misses = shapes.map((shape) => mismatch(data, call, shape, venueName))
    if (misses.includes(undefined)) continue
    const closest = misses.reduce((best, miss) =>
      (miss?.depth ?? 0) > (best?.depth ?? 0) ? miss : best
    )
    if (closest !== undefined) refuse(closest.reason)
  }
}

const DRY_RUN_TIMEOUT_MS = 15_000
const SUI_TYPE = normalizeStructTag('0x2::sui::SUI')

/**
 * What a dry run, which moves nothing, says this account's balance of a coin would
 * change by. Nothing when the dry run failed or couldn't be read. For SUI the network
 * fee is left out, since it isn't part of what the action does.
 */
export async function dryRunChange(
  transaction: string,
  coinType: string,
  account: string,
  what: string
): Promise<bigint | undefined> {
  const simulated = await withTimeout(
    suiClient().core.simulateTransaction({
      transaction: fromBase64(transaction),
      include: { effects: true, balanceChanges: true },
    }),
    DRY_RUN_TIMEOUT_MS,
    what
  )
  const result = simulated.Transaction
  if (result?.effects?.status.success !== true || result.balanceChanges === undefined) {
    return undefined
  }
  const me = normalizeSuiAddress(account)
  const coin = normalizeStructTag(coinType)
  const change = result.balanceChanges.find(
    (c) => normalizeStructTag(c.coinType) === coin && normalizeSuiAddress(c.address) === me
  )
  const moved = change === undefined ? BigInt(0) : BigInt(change.amount)
  if (coin !== SUI_TYPE) return moved
  const gas = result.effects.gasUsed
  return moved + BigInt(gas.computationCost) + BigInt(gas.storageCost) - BigInt(gas.storageRebate)
}

/** A position's share price rounds, so a hundredth of a percent under what was asked still counts. */
export function gaveWhatWasAsked(received: bigint, asked: bigint): boolean {
  return received * BigInt(10_000) >= asked * BigInt(9_999)
}

export function coinTypeName(coinType: string): string {
  return normalizeStructTag(coinType).replace(/^0x/, '')
}

/**
 * A borrow, or a withdraw of collateral, may not leave the health factor under this. The
 * same line the app holds on EVM lending, since a protocol's own limit leaves little room.
 */
export const MIN_HEALTH_FACTOR = 1.5

/** A position in dollars, as its protocol weighs it. */
export interface LoanStanding {
  /** Collateral counted at the point it can be liquidated. */
  liquidationUsd: number
  /** The most this position may owe and still borrow. */
  limitUsd: number
  owedUsd: number
}

function healthText(health: number): string {
  return health.toFixed(2)
}

function roundedDown(amount: number): string {
  return String(Math.floor(amount * 1e6) / 1e6)
}

/** Refuses a borrow the position can't support, and returns the health factor it would leave. */
export function assertBorrowFits(check: {
  venueName: string
  symbol: string
  standing: LoanStanding
  addedOwedUsd: number
  /** Dollars of debt per unit borrowed, fee and weighting included. */
  priceUsd: number
}): number {
  const { venueName, symbol, standing, addedOwedUsd, priceUsd } = check
  if (standing.limitUsd <= 0) {
    refuse(`You have no collateral on ${venueName} here, so there is nothing to borrow against.`)
  }
  const owedAfter = standing.owedUsd + addedOwedUsd
  if (owedAfter > standing.limitUsd) {
    const spare = standing.limitUsd - standing.owedUsd
    refuse(
      spare > 0
        ? `Your collateral on ${venueName} can back about ${roundedDown(spare / priceUsd)} more ${symbol} right now, which is less than this. Borrow less or add collateral.`
        : `Your collateral on ${venueName} can't back any more loans right now. Repay some of the loan or add collateral.`
    )
  }
  const health = standing.liquidationUsd / owedAfter
  if (health < MIN_HEALTH_FACTOR) {
    refuse(
      `This borrow would leave your health factor at ${healthText(health)}. This app stops at ${MIN_HEALTH_FACTOR}, to keep room before liquidation. Borrow less or add collateral.`
    )
  }
  return health
}

/**
 * Refuses taking out collateral a loan depends on, and returns the health factor it would leave.
 * Nothing when there is no loan, and so nothing to check.
 */
export function assertWithdrawFits(check: {
  venueName: string
  symbol: string
  standing: LoanStanding
  removedLimitUsd: number
  removedLiquidationUsd: number
  /** The amount being taken out, in display units. */
  amount: number
}): number | undefined {
  const { venueName, symbol, standing, removedLimitUsd, removedLiquidationUsd, amount } = check
  if (standing.owedUsd <= 0) return undefined
  const limitAfter = standing.limitUsd - removedLimitUsd
  const liquidationAfter = standing.liquidationUsd - removedLiquidationUsd
  const health = liquidationAfter / standing.owedUsd
  if (limitAfter >= standing.owedUsd && health >= MIN_HEALTH_FACTOR) return health

  // The share of what was asked for that keeps both lines. Dividing by zero means no limit.
  const share = Math.min(
    (standing.limitUsd - standing.owedUsd) / removedLimitUsd,
    (standing.liquidationUsd - MIN_HEALTH_FACTOR * standing.owedUsd) / removedLiquidationUsd
  )
  const safe = Number.isFinite(share) ? Math.max(share, 0) * amount : 0
  refuse(
    safe > 0
      ? `Your loan on ${venueName} depends on this ${symbol}. Only about ${roundedDown(safe)} ${symbol} can come out and leave the loan covered, with this app's health factor limit of ${MIN_HEALTH_FACTOR}. Withdraw less, or repay the loan first.`
      : `Your loan on ${venueName} depends on this ${symbol}, so it can't come out right now. Repay the loan first.`
  )
}

function dropBeforeLiquidation(health: number): number {
  return Math.round((1 - 1 / health) * 100)
}

/** The conditions a person reads before taking a loan. */
export function borrowNotes(loan: {
  venueName: string
  symbol: string
  health: number
  /** Only what was read. A rate that couldn't be read is left out, never guessed. */
  borrowAprPercent?: number | undefined
  feePercent?: number | undefined
}): string[] {
  const { venueName, symbol, health, borrowAprPercent, feePercent } = loan
  return [
    `A borrow can be liquidated. This loan leaves your health factor at ${healthText(health)}. If what you supplied falls about ${dropBeforeLiquidation(health)}% in value against what you owe, or interest builds up to the same effect, anyone can repay part of the loan and take your collateral at a discount. You lose that discount on top. This app refuses a borrow under ${MIN_HEALTH_FACTOR}, but it does not watch the loan afterwards.`,
    ...(borrowAprPercent === undefined
      ? []
      : [
          `The rate is variable, about ${borrowAprPercent}% a year now, and it can rise quickly. Interest adds to what you owe.`,
        ]),
    ...(feePercent === undefined || feePercent <= 0
      ? []
      : [`${venueName} charges a ${feePercent}% fee on this borrow, added to what you owe.`]),
    `To close the loan, ask to repay ${symbol} on ${venueName}.`,
  ]
}

/** What a person reads before taking out collateral that backs a loan. */
export function withdrawLoanNote(symbol: string, health: number): string {
  return `This ${symbol} backs your loan, so taking it out leaves your health factor at ${healthText(health)}. The lower it is, the sooner the rest can be liquidated.`
}

/** Room left over a whole repay, a tenth of a percent, for interest added since the read. */
const WHOLE_REPAY_PADDING = BigInt(1000)

/**
 * The coin to hand over. Interest builds between reading a debt and signing, so a whole repay
 * hands over a little more than was read. The contract takes only what is owed, and the rest
 * comes back. One the wallet can only just cover still clears the debt as read.
 */
export function repayCoinAmount(repay: {
  asked: bigint
  owed: bigint
  whole: boolean
  held: bigint
  symbol: string
  decimals: number
}): bigint {
  const { asked, owed, whole, held, symbol, decimals } = repay
  const show = (units: bigint) => displayAmount(units.toString(), decimals)
  if (!whole && asked < owed) {
    if (held < asked) {
      refuse(`You hold ${show(held)} ${symbol}, which is less than ${show(asked)}.`)
    }
    return asked
  }
  if (held < owed) {
    refuse(
      `You hold ${show(held)} ${symbol}, which is less than the ${show(owed)} you owe. Say an amount to pay part of it.`
    )
  }
  const share = owed / WHOLE_REPAY_PADDING
  const padded = owed + (share > BigInt(0) ? share : BigInt(1))
  return held < padded ? held : padded
}

export async function walletBalance(account: string, coinType: string): Promise<bigint> {
  const { balance } = await suiClient().core.getBalance({ owner: account, coinType })
  return BigInt(balance.balance)
}

/**
 * Pyth Core Compatible on Sui, what every price below reads. Since Pyth's August 2026 upgrade
 * the older package's objects have stopped moving, and Hermes, the service that would let a
 * transaction publish its own price, needs an API key. These objects are kept current by others
 * and need neither, as NAVI and Suilend borrows and Scallop withdrawals show on chain, so a loan
 * here costs no key. A coin whose object nobody keeps current, and any position holding one, is
 * refused on its age, and so is everything if they all go quiet.
 */
export const PYTH_STATE = '0x03719fae774ddab3cfcaa53bbc046f0cbe21410019b6280811bf3f9f4b05839d'
export const PYTH_PACKAGE = '0x55300367a2d40813727ccac4ecee977a39fb9cdb46f2e6b2c354b9798f5de2c0'
export const PYTH_PRICE_TABLE = '0x34188088689963c36b11a2309c8dc871afd806194b06466999d6cc6a2b34afec'

export interface PythReading {
  objectId: string
  priceUsd: number
  emaUsd: number
  ageSeconds: number
}

function pythUsd(raw: unknown): number {
  const { price, expo } = raw as {
    price: { magnitude: string; negative: boolean }
    expo: { magnitude: string; negative: boolean }
  }
  if (price.negative) throw new Error('Pyth reported a negative price.')
  const scale = 10 ** Number(expo.magnitude)
  const value = expo.negative ? Number(price.magnitude) / scale : Number(price.magnitude) * scale
  if (!Number.isFinite(value) || value <= 0) throw new Error('Pyth reported an unusable price.')
  return value
}

export function parsePythPrice(json: unknown, nowSeconds: number): Omit<PythReading, 'objectId'> {
  const feed = (
    json as { price_info: { price_feed: { price: unknown; ema_price: unknown } } } | undefined
  )?.price_info.price_feed
  if (feed === undefined) throw new Error('Not a Pyth price object.')
  return {
    priceUsd: pythUsd(feed.price),
    emaUsd: pythUsd(feed.ema_price),
    ageSeconds: nowSeconds - Number((feed.price as { timestamp: string }).timestamp),
  }
}

export async function readPythObject(objectId: string): Promise<PythReading> {
  const { object } = await suiClient().core.getObject({ objectId, include: { json: true } })
  return { objectId, ...parsePythPrice(object.json, Math.floor(Date.now() / 1000)) }
}

const PriceIdentifier = bcs.struct('PriceIdentifier', { bytes: bcs.vector(bcs.u8()) })

/** The current price object of a feed, from Pyth's own table on chain. */
export async function pythObjectForFeed(feed: Uint8Array): Promise<string> {
  const { dynamicField } = await suiClient().core.getDynamicField({
    parentId: PYTH_PRICE_TABLE,
    name: {
      type: `${PYTH_PACKAGE}::price_identifier::PriceIdentifier`,
      bcs: PriceIdentifier.serialize({ bytes: [...feed] }).toBytes(),
    },
  })
  return normalizeSuiAddress(bcs.Address.parse(dynamicField.value.bcs))
}

/** Refuses before building what the contract would turn down for a price that has gone stale. */
export function assertPricesFresh(
  readings: readonly PythReading[],
  limitSeconds: number,
  venueName: string
): void {
  if (readings.some((r) => r.ageSeconds > limitSeconds)) {
    refuse(
      `${venueName} needs prices from the last ${limitSeconds} seconds, and the ones published on chain are older. Try again in a minute.`
    )
  }
}
