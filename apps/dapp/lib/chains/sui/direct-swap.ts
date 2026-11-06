import { bcs } from '@mysten/sui/bcs'
import {
  coinWithBalance,
  Transaction,
  type TransactionObjectArgument,
} from '@mysten/sui/transactions'
import { fromBase64, normalizeStructTag, normalizeSuiAddress } from '@mysten/sui/utils'

import {
  ChainActionRefused,
  tokenBySymbol,
  toBaseUnits,
  type ChainActionRequest,
  type ChainToken,
  type SigningPayload,
} from '../types'
import { judgeRoute, SLIPPAGE_BPS } from './cetus-rules'
import { buildUnsigned, suiClient, withTimeout } from './client'
import { priceFromLlama } from './price'
import { displayAmount, SUI_TOKENS } from './tokens'

/**
 * What DeepBook and Momentum share: swapping straight against one pinned pool, with the quote read
 * on chain by dry run. Each venue checks its own transaction's shape on top of `assertPtbSafe`,
 * because `PtbPolicy.checkCall` can read literal arguments but not which object or result an
 * argument names, and a swap's pool and its minimum depend on those.
 */

const VIEW_TIMEOUT_MS = 10_000
const BPS = 10_000
/** A pool's fill steps can leave some of the amount unspent. Past this, it isn't the trade asked for. */
const MAX_UNSPENT_PERCENT = 1

export const CLOCK = '0x6'
export const CLOCK_SHARED_VERSION = 1

export interface SwapIo {
  /** Dry-runs a read-only transaction and returns each command's return values. */
  view: (tx: Transaction) => Promise<Uint8Array[][]>
  build: (tx: Transaction, symbol: string) => Promise<string>
  price: (token: ChainToken) => Promise<number | undefined>
  spend: (tx: Transaction, token: ChainToken, amount: string) => TransactionObjectArgument
}

export const LIVE_SWAP_IO: SwapIo = {
  async view(tx) {
    // Checks off, because these calls return values no transaction could keep, and no coin is spent.
    const result = await withTimeout(
      suiClient().core.simulateTransaction({
        transaction: tx,
        checksEnabled: false,
        include: { commandResults: true },
      }),
      VIEW_TIMEOUT_MS,
      'Reading the price'
    )
    if (result.$kind !== 'Transaction') throw new Error('The read did not run.')
    return result.commandResults.map((c) => c.returnValues.map((v) => v.bcs))
  },
  build: (tx, symbol) => buildUnsigned(tx, suiClient(), symbol),
  price: (token) => priceFromLlama(token),
  spend: (tx, token, amount) =>
    tx.add(coinWithBalance({ type: token.id, balance: BigInt(amount) })),
}

export function refuse(reason: string): never {
  throw new ChainActionRefused(`${reason} Nothing was signed or sent.`)
}

export interface PairedTokens {
  tokenIn: ChainToken
  tokenOut: ChainToken
  /** Whether the coin going in is the pool's first type argument. */
  inIsFirst: boolean
  amountIn: string
}

export function pairTokens(
  venueName: string,
  pairs: readonly (readonly [string, string])[],
  request: ChainActionRequest
): PairedTokens & { pairIndex: number } {
  const tokenIn = tokenBySymbol(SUI_TOKENS, request.tokenIn)
  const tokenOut = tokenBySymbol(SUI_TOKENS, request.tokenOut ?? '')
  if (tokenIn === undefined || tokenOut === undefined) {
    throw new ChainActionRefused("I can't confirm those as verified tokens on Sui.")
  }
  const pairIndex = pairs.findIndex(
    ([a, b]) =>
      (a === tokenIn.symbol && b === tokenOut.symbol) ||
      (a === tokenOut.symbol && b === tokenIn.symbol)
  )
  if (pairIndex < 0) {
    return refuse(
      `${venueName} has no direct pool here for ${tokenIn.symbol} and ${tokenOut.symbol}.`
    )
  }
  return {
    tokenIn,
    tokenOut,
    inIsFirst: pairs[pairIndex]?.[0] === tokenIn.symbol,
    amountIn: toBaseUnits(request.amount, tokenIn.decimals),
    pairIndex,
  }
}

export function tokenType(symbol: string): string {
  const token = tokenBySymbol(SUI_TOKENS, symbol)
  if (token === undefined) throw new Error(`${symbol} is not in the token table.`)
  return normalizeStructTag(token.id)
}

/** Reads the chain or refuses: a venue with no readable price offers no swap. */
export async function readOrRefuse(
  io: SwapIo,
  tx: Transaction,
  venueName: string
): Promise<Uint8Array[][]> {
  try {
    return await io.view(tx)
  } catch {
    return refuse(`I couldn't read a price from ${venueName} right now, so I stopped.`)
  }
}

export function u64At(views: Uint8Array[][], command: number, value: number): string {
  const bytes = views[command]?.[value]
  if (bytes === undefined) throw new ChainActionRefused('The chain returned less than I expected.')
  return bcs.u64().parse(bytes)
}

export function u128At(views: Uint8Array[][], command: number, value: number): string {
  const bytes = views[command]?.[value]
  if (bytes === undefined) throw new ChainActionRefused('The chain returned less than I expected.')
  return bcs.u128().parse(bytes)
}

export interface Fill {
  venueName: string
  tokens: PairedTokens
  /** How much of the amount in the pool would take, and how much it would give. */
  unspent: string
  out: string
  /** How far the price moves or fills from its mark, as a fraction. */
  impact: number
}

/** Holds a fill to the same limits as a routed swap: the whole amount, a fair value, a real output. */
export async function judgeFill(io: SwapIo, fill: Fill): Promise<void> {
  const { tokenIn, tokenOut, amountIn } = fill.tokens
  const spent = BigInt(amountIn) - BigInt(fill.unspent)
  if (spent <= BigInt(0) || BigInt(fill.out) === BigInt(0)) {
    refuse(
      `${fill.venueName} can't fill ${displayAmount(amountIn, tokenIn.decimals)} ${tokenIn.symbol} for ${tokenOut.symbol} right now. Try a larger amount, or another venue.`
    )
  }
  if (BigInt(fill.unspent) * BigInt(100) > BigInt(amountIn) * BigInt(MAX_UNSPENT_PERCENT)) {
    refuse(
      `${fill.venueName} could only take part of this amount, and about ${displayAmount(fill.unspent, tokenIn.decimals)} ${tokenIn.symbol} would stay unspent. Try a different amount.`
    )
  }
  const [priceIn, priceOut] = await Promise.all([io.price(tokenIn), io.price(tokenOut)])
  judgeRoute({
    requestedIn: spent.toString(),
    amountIn: spent.toString(),
    amountOut: fill.out,
    deviationRatio: fill.impact,
    tokenIn,
    tokenOut,
    priceIn,
    priceOut,
  })
}

export function minimumOut(out: string): string {
  return ((BigInt(out) * BigInt(BPS - SLIPPAGE_BPS)) / BigInt(BPS)).toString()
}

export function slippageNote(): string {
  return `The amount you get can move before this lands. If it drops by more than ${SLIPPAGE_BPS / 100}%, the swap cancels and you only pay the network fee.`
}

export function unspentNote(fill: Fill): string[] {
  if (BigInt(fill.unspent) === BigInt(0)) return []
  const { tokenIn } = fill.tokens
  return [
    `Only part of this can trade, in the steps the pool allows. About ${displayAmount(fill.unspent, tokenIn.decimals)} ${tokenIn.symbol} stays in your wallet.`,
  ]
}

export function bridgeNote(tokens: PairedTokens): string[] {
  return tokens.tokenIn.symbol === 'USDT' || tokens.tokenOut.symbol === 'USDT'
    ? ['USDT on Sui is a bridged token, so it also depends on the Sui Bridge.']
    : []
}

type TxData = ReturnType<Transaction['getData']>
type TxCommand = TxData['commands'][number]
export type MoveCall = Extract<TxCommand, { $kind: 'MoveCall' }>['MoveCall']
export type TxArgument = MoveCall['arguments'][number]

/** The bytes `assertPtbSafe` has already accepted, for a venue's own check of their shape. */
export function dataOf(payload: SigningPayload): TxData {
  if (payload.family !== 'sui') return refuse('That is not a Sui transaction.')
  return Transaction.from(fromBase64(payload.transaction)).getData()
}

export function moveCallsNamed(data: TxData, target: string): { at: number; call: MoveCall }[] {
  return data.commands.flatMap((command, at) => {
    if (command.$kind !== 'MoveCall') return []
    const { package: pkg, module, function: fn } = command.MoveCall
    return `${normalizeSuiAddress(pkg)}::${module}::${fn}` === target
      ? [{ at, call: command.MoveCall }]
      : []
  })
}

/** The shared object an argument names, or nothing if it names anything else. */
export function sharedObjectId(data: TxData, argument: TxArgument | undefined): string | undefined {
  if (argument?.$kind !== 'Input') return undefined
  const object = data.inputs[argument.Input]
  if (object?.$kind !== 'Object' || object.Object.$kind !== 'SharedObject') return undefined
  return normalizeSuiAddress(object.Object.SharedObject.objectId)
}

/** A literal u64 argument. Anything computed in the transaction reads as nothing. */
export function literalU64(data: TxData, argument: TxArgument | undefined): bigint | undefined {
  if (argument?.$kind !== 'Input') return undefined
  const input = data.inputs[argument.Input]
  if (input?.$kind !== 'Pure') return undefined
  try {
    return BigInt(bcs.u64().parse(fromBase64(input.Pure.bytes)))
  } catch {
    return undefined
  }
}

export function literalBool(data: TxData, argument: TxArgument | undefined): boolean | undefined {
  if (argument?.$kind !== 'Input') return undefined
  const input = data.inputs[argument.Input]
  if (input?.$kind !== 'Pure') return undefined
  try {
    return bcs.bool().parse(fromBase64(input.Pure.bytes))
  } catch {
    return undefined
  }
}

/** Which command, and which of its return values, an argument takes. */
export function resultOf(argument: TxArgument | undefined): [number, number] | undefined {
  if (argument?.$kind === 'Result') return [argument.Result, 0]
  if (argument?.$kind === 'NestedResult') return argument.NestedResult
  return undefined
}

export function sameType(a: string | undefined, b: string): boolean {
  if (a === undefined) return false
  try {
    return normalizeStructTag(a) === normalizeStructTag(b)
  } catch {
    return false
  }
}
