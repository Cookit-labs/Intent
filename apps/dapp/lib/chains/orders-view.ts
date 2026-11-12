import { limitPair, type RestingOrder } from './limit'

export type OrderExit = 'cancel' | 'collect'

export const GONE = 'That order is no longer open. Nothing was signed or sent.'

const ORDERS_WORDS = /\b(?:my|open|limit)\s+(?:(?:open|limit)\s+)?orders?\b/i

/**
 * Whether the person is asking about their resting orders. A message with a figure in it is placing
 * or changing something and not asking, and "order 5 SOL" or "in order to" are not about orders.
 */
export function ordersAsked(text: string): boolean {
  return !/\d/.test(text) && ORDERS_WORDS.test(text)
}

/** What can be done with an order as listed. */
export function exitsFor(order: RestingOrder): OrderExit[] {
  const waiting = (order.collectable ?? []).length > 0
  if (order.status === 'open') return ['cancel']
  if (order.status === 'partly') return waiting ? ['cancel', 'collect'] : ['cancel']
  if (order.status === 'filled') return ['collect']
  return []
}

/**
 * What a press means now, read again just before it builds. A cancel on an order that has since
 * filled becomes a collect, and an order that is no longer listed, or has nothing left to do, is
 * gone.
 */
export function freshExit(
  listed: RestingOrder,
  now: RestingOrder | undefined,
  action: OrderExit
): OrderExit | 'gone' {
  if (now === undefined || now.id !== listed.id) return 'gone'
  const exits = exitsFor(now)
  if (exits.includes(action)) return action
  if (action === 'cancel' && exits.includes('collect')) return 'collect'
  return 'gone'
}

function scaled(text: string): { digits: bigint; places: number } | undefined {
  if (!/^\d+(\.\d+)?$/.test(text)) return undefined
  const [whole = '0', fraction = ''] = text.split('.')
  return { digits: BigInt(`${whole}${fraction}`), places: fraction.length }
}

/** `a - b` as decimal text, or nothing when either is not a plain figure or b is the larger. */
function minus(a: string, b: string): string | undefined {
  const x = scaled(a)
  const y = scaled(b)
  if (x === undefined || y === undefined) return undefined
  const places = Math.max(x.places, y.places)
  const lift = (v: { digits: bigint; places: number }): bigint =>
    v.digits * BigInt(10) ** BigInt(places - v.places)
  const left = lift(x) - lift(y)
  if (left < BigInt(0)) return undefined
  const padded = left.toString().padStart(places + 1, '0')
  const whole = padded.slice(0, padded.length - places)
  const fraction = padded.slice(padded.length - places).replace(/0+$/, '')
  return fraction === '' ? whole : `${whole}.${fraction}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function dayOf(ms: number): string {
  const date = new Date(ms)
  return `${MONTHS[date.getUTCMonth()] ?? ''} ${date.getUTCDate()}`
}

/** One order as a line: what was ordered, how much has filled, and when it ends. */
export function orderLine(order: RestingOrder): string {
  const waiting = order.collectable ?? []
  const lead =
    waiting.length > 0
      ? `${waiting.map((w) => `${w.amount} ${w.symbol}`).join(' and ')} ready to collect`
      : ''
  if (order.amountIn === '0' || order.amountIn === '') return lead

  const pair = limitPair(order.tokenIn, order.tokenOut)
  const price = order.limitPrice !== undefined ? ` at $${order.limitPrice}` : ''
  const what =
    pair === undefined || pair.selling
      ? `Sell ${order.amountIn} ${order.tokenIn}${price}`
      : `Buy ${pair.base} with ${order.amountIn} ${order.tokenIn}${price}`
  const parts = [what]
  const filled = minus(order.amountIn, order.remainingIn)
  if (order.status === 'filled' || order.status === 'done') {
    parts.push('filled')
  } else if (filled !== undefined && filled !== '0') {
    parts.push(`${filled}${pair !== undefined && !pair.selling ? ` ${order.tokenIn}` : ''} filled`)
  }
  if (order.expiresAt !== undefined && order.status !== 'filled' && order.status !== 'done') {
    parts.push(`expires ${dayOf(order.expiresAt)}`)
  }
  const line = parts.join(', ')
  return lead === '' ? line : `${lead}. ${line}`
}

/** What is said once a limit order is resting, and what is still to do for it. */
export function limitSettledNote(chain: string): string {
  const base = 'Your order is resting. Say "my orders" to see it, cancel it or collect from it.'
  return chain === 'sui' || chain === 'near'
    ? `${base} Collecting what it fills takes another signature.`
    : base
}

const ORDERS_UNREAD = 'Your orders could not be read just now. Nothing was signed or sent.'

/** What the orders card showed, in words the chat keeps once the card has gone. */
export function ordersReply(orders: readonly RestingOrder[] | undefined): string {
  if (orders === undefined) return ORDERS_UNREAD
  if (orders.length === 0) return 'You have no resting limit orders here.'
  return ['Your limit orders:', ...orders.map((o) => `${orderLine(o)}, via ${o.venueId}`)].join(
    '\n'
  )
}
