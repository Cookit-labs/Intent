import { limitPair } from '../limit'
import { ChainActionRefused, tokenBySymbol, type ChainToken } from '../types'
import { nearTokens, TGAS, USDC_NEAR, WRAP_NEAR } from './tokens'

export const DCL_CONTRACT = 'dclv2.ref-labs.near'
/** USDC is token x and wNEAR token y, at a 0.01% fee: the only pool here with real depth. */
export const DCL_POOL = `${USDC_NEAR}|${WRAP_NEAR}|100`
export const DCL_POINT_DELTA = 1
export const DCL_STORAGE_CAP = BigInt('500000000000000000000000')
export const DCL_ORDER_GAS = BigInt(250) * TGAS
export const DCL_EXIT_GAS = BigInt(180) * TGAS

const POINT_BASE = 1.0001
const USDC_PER_NEAR_AT_POINT_ZERO = 1e18

function refused(sentence: string): never {
  throw new ChainActionRefused(`${sentence} Nothing was signed or sent.`)
}

/** USDC per NEAR at a point on this pool. A higher point is a cheaper NEAR. */
export function priceAtPoint(point: number): number {
  return USDC_PER_NEAR_AT_POINT_ZERO / POINT_BASE ** point
}

/**
 * The point of a resting order: on the pool's step, and never worse than asked. A sale rounds to the
 * lower point, a dearer NEAR, and a purchase to the higher point, a cheaper one.
 */
export function pointForPrice(priceUsdcPerNear: number, selling: boolean, delta: number): number {
  if (!Number.isFinite(priceUsdcPerNear) || priceUsdcPerNear <= 0) {
    refused('That is not a price I can place on Rhea.')
  }
  const exact = Math.log(USDC_PER_NEAR_AT_POINT_ZERO / priceUsdcPerNear) / Math.log(POINT_BASE)
  const steps = selling ? Math.floor(exact / delta) : Math.ceil(exact / delta)
  let point = steps * delta
  while (
    selling ? priceAtPoint(point) < priceUsdcPerNear : priceAtPoint(point) > priceUsdcPerNear
  ) {
    point += selling ? -delta : delta
  }
  return point
}

/**
 * `LimitOrderWithSwap` swaps a marketable part at once, with no minimum out in the message, so an order
 * must rest beyond the pool's own price: a sale below its current point, a purchase above it. Read
 * just before building, so it can still cross before it lands. Why not plain `LimitOrder`: see near.md.
 */
export function assertRestingPoint(point: number, currentPoint: number, selling: boolean): void {
  if (selling ? point >= currentPoint : point <= currentPoint) {
    refused(
      `Rhea's own NEAR price is about $${Number(priceAtPoint(currentPoint).toPrecision(4))}, so that would fill at once with no minimum.`
    )
  }
}

export interface RheaPair {
  input: ChainToken
  output: ChainToken
  selling: boolean
}

/** Only NEAR against USDC. Anything else is refused here, wherever the request came from. */
export function rheaPair(tokenIn: string, tokenOut: string): RheaPair {
  const pair = limitPair(tokenIn, tokenOut)
  const input = tokenBySymbol(nearTokens, tokenIn)
  const output = tokenBySymbol(nearTokens, tokenOut)
  if (
    pair?.base !== 'NEAR' ||
    pair.quote !== 'USDC' ||
    input === undefined ||
    output === undefined
  ) {
    refused('Rhea here only trades NEAR against USDC.')
  }
  return { input, output, selling: pair.selling }
}

/** The token an order selling this one buys, or nothing for a token not on this pool. */
export function dclBuyToken(sellToken: string): string | undefined {
  if (sellToken === WRAP_NEAR) return USDC_NEAR
  return sellToken === USDC_NEAR ? WRAP_NEAR : undefined
}

/** The exact text an order carries. Key order matches what Rhea's own interface sends. */
export function dclOrderMsg(buyToken: string, point: number): string {
  return JSON.stringify({
    LimitOrderWithSwap: { client_id: '', pool_id: DCL_POOL, buy_token: buyToken, point },
  })
}

export function isDclOrderId(orderId: unknown): orderId is string {
  return (
    typeof orderId === 'string' &&
    orderId.startsWith(`${DCL_POOL}#`) &&
    /^\d{1,20}$/.test(orderId.slice(DCL_POOL.length + 1))
  )
}

/** Yes only for one of this venue's calls. The point is an order's, for finding it afterwards. */
export function readExecuted(
  receiver: string,
  calls: readonly { method: string; args: Record<string, unknown> }[]
): { belongs: boolean; point?: number } {
  let point: number | undefined
  const belongs =
    calls.length > 0 &&
    calls.every(({ method, args }) => {
      if (method === 'storage_deposit') return true
      if (receiver === DCL_CONTRACT)
        return method === 'cancel_order' && isDclOrderId(args['order_id'])
      if (method === 'near_deposit') return receiver === WRAP_NEAR
      if (method !== 'ft_transfer_call' || args['receiver_id'] !== DCL_CONTRACT) return false
      point = pointOf(args['msg'])
      return point !== undefined
    })
  const known = receiver === DCL_CONTRACT || dclBuyToken(receiver) !== undefined
  return known && belongs
    ? { belongs: true, ...(point === undefined ? {} : { point }) }
    : { belongs: false }
}

function pointOf(msg: unknown): number | undefined {
  if (typeof msg !== 'string') return undefined
  try {
    const order = (
      JSON.parse(msg) as { LimitOrderWithSwap?: { pool_id?: unknown; point?: unknown } }
    ).LimitOrderWithSwap
    return order?.pool_id === DCL_POOL && Number.isSafeInteger(order.point)
      ? (order.point as number)
      : undefined
  } catch {
    return undefined
  }
}
