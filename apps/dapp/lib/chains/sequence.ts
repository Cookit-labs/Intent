import type { CashoutCurrencyCode } from '../weave/parse-cashout'
import { closedCashoutReply } from '../weave/types'
import { sendRefusal } from './recipient'
import type { ChainActionRequest, ChainVenue, ChainWithActions } from './types'

export type FollowOn =
  | { kind: 'cashout'; currency?: CashoutCurrencyCode }
  | { kind: 'supply' | 'stake'; venue?: string }
  | { kind: 'send'; recipient: string }

export interface ChainSequenceRequest {
  swap: ChainActionRequest
  followOn: FollowOn
}

/** Where a swap can go on to a cash-out. Stellar has its own path, so it is not here. */
export const SEQUENCE_CASHOUT_CHAINS: readonly ChainWithActions[] = ['solana', 'sui', 'avalanche']

const NOTHING_MOVED = 'Nothing was signed or sent.'

/** Exact base units of a decimal, or nothing if it is not one or has more places than the token. */
export function toBase(text: string, decimals: number): bigint | undefined {
  if (!/^\d+(?:\.\d+)?$/.test(text)) return undefined
  const [whole = '0', fraction = ''] = text.split('.')
  if (fraction.length > decimals && /[1-9]/.test(fraction.slice(decimals))) return undefined
  const padded = fraction.slice(0, decimals).padEnd(decimals, '0')
  return BigInt(whole + padded)
}

export function fromBase(base: bigint, decimals: number): string {
  const digits = base.toString().padStart(decimals + 1, '0')
  const whole = digits.slice(0, digits.length - decimals)
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '')
  return fraction === '' ? whole : `${whole}.${fraction}`
}

/** What arrived between two readings of a balance, in whole base units, or nothing if it did not grow. */
export function deliveredAmount(
  before: string | undefined,
  after: string | undefined,
  decimals: number
): string | undefined {
  if (before === undefined || after === undefined) return undefined
  const a = toBase(before, decimals)
  const b = toBase(after, decimals)
  if (a === undefined || b === undefined || b <= a) return undefined
  return fromBase(b - a, decimals)
}

/**
 * What to ask Weave for, leaving room for the 2% it may take over the order:
 * floor(delivered / 1.02) to 2 places. Nothing for zero or for text that is not an amount.
 */
export function cashoutAmountFrom(delivered: string): string | undefined {
  const places = delivered.includes('.') ? (delivered.split('.')[1] ?? '').length : 0
  const base = toBase(delivered, places)
  if (base === undefined) return undefined
  const hundredths = (base * BigInt(10000)) / (BigInt(102) * BigInt(10) ** BigInt(places))
  return hundredths === BigInt(0) ? undefined : fromBase(hundredths, 2)
}

/**
 * The sentence for a follow-on that cannot run on this chain, or nothing if it can. `tokenOut` is
 * what the swap delivers, for a send, whose chain may not move that token.
 */
export function followOnRefusal(
  chain: ChainWithActions,
  chainName: string,
  followOn: FollowOn,
  venues: readonly Pick<ChainVenue, 'kinds'>[],
  tokenOut?: string
): string | undefined {
  if (followOn.kind === 'cashout') {
    const closed = closedCashoutReply(chain)
    if (closed !== undefined) return closed
    if (!SEQUENCE_CASHOUT_CHAINS.includes(chain)) {
      return `Cash-outs don't run on ${chainName}. ${NOTHING_MOVED}`
    }
    return undefined
  }
  if (followOn.kind === 'send') return sendRefusal(chain, tokenOut, followOn.recipient)
  if (!venues.some((v) => v.kinds.includes(followOn.kind))) {
    const can = followOn.kind === 'supply' ? 'take a deposit' : followOn.kind
    return `Nothing on ${chainName} can ${can} yet. ${NOTHING_MOVED}`
  }
  return undefined
}

/** After the swap went through and the next step cannot go on: what reached the wallet, never a guess. */
export function strandedReply(
  symbol: string,
  delivered: string | undefined,
  followOn: FollowOn
): string {
  const paidOut = followOn.kind === 'cashout' ? ' Nothing was paid out.' : ''
  if (delivered === undefined) {
    return `The swap went through, but I could not confirm what reached your wallet, so the next step did not run. What arrived stays in your wallet. Check your wallet before doing anything else.${paidOut}`
  }
  return `The swap went through and about ${delivered} ${symbol} reached your wallet, but the next step did not run.${paidOut}`
}
