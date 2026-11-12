import { z } from 'zod'

import type { ChainActionKind, PreparedAction } from '../chains/types'
import type { NairaStatus } from '../naira/status'
import { CASHOUT_STATUSES, type CashoutOrderView } from '../weave/cashout-view'

/**
 * The last screen of a card, kept with its turn once the next message is sent, and in the saved
 * chat. Only what that screen shows is kept: never a transaction that could be signed again, and
 * never a whole account number.
 */

export interface TurnBank {
  code: string
  name: string
  logo?: string
}

/** What a sign card shows once it is done: the action without anything to sign. */
export type FrozenPrepared = Omit<PreparedAction, 'signing' | 'context' | 'receipt'>

export interface LinqSummary {
  amount: string
  coin: string
  amountNgn: string
  accountName: string
  bankName: string
  accountMask: string
  paymentHash?: string | undefined
}

export type TurnCard =
  | {
      kind: 'weave'
      order: CashoutOrderView
      bank?: TurnBank
      hash?: string
      explorerUrl?: string
    }
  | { kind: 'linq'; status: NairaStatus; order: LinqSummary; bank?: TurnBank }
  | {
      kind: 'chain'
      phase: 'settled' | 'failed' | 'pending'
      prepared?: FrozenPrepared
      hash?: string
      explorerUrl?: string
      error?: string
    }

const KINDS = [
  'swap',
  'supply',
  'stake',
  'send',
  'limit',
  'withdraw',
  'unstake',
  'borrow',
  'repay',
  'stream',
  'invoice',
  'pay_invoice',
  'claim',
  'cancel',
] as const satisfies readonly ChainActionKind[]

const NAIRA_STATUSES = [
  'waiting',
  'processing',
  'paid',
  'expired',
  'failed',
] as const satisfies readonly NairaStatus[]

const text = z.string().max(2000)
const short = z.string().max(200)

/** Only the last four digits of an account: a stored card must never hold the whole number. */
function masked(value: string): string {
  return value.replace(/\d{5,}/g, (run) => `••${run.slice(-4)}`)
}

const mask = short.transform(masked)

const httpsUrl = z
  .string()
  .max(500)
  .refine((value) => {
    try {
      return new URL(value).protocol === 'https:'
    } catch {
      return false
    }
  })

/** A logo is one of this app's own images, never an address from elsewhere. */
const ownImage = z
  .string()
  .max(200)
  .regex(/^\/[A-Za-z0-9/_.-]+$/)
  .refine((path) => !path.includes('..') && !path.startsWith('//'))

function optional<T extends z.ZodTypeAny>(schema: T) {
  return schema.optional().catch(undefined)
}

const bank = z.object({ code: short, name: short, logo: optional(ownImage) })

const order = z.object({
  id: short,
  chain: short,
  status: z.enum(CASHOUT_STATUSES),
  currency: short,
  amount: short,
  estimatedDest: short,
  provider: optional(z.enum(['linq', 'weave'])),
  exactDest: optional(z.boolean()),
  paidDest: optional(short),
  institutionName: short,
  accountName: short,
  accountMask: mask,
  depositAddress: short,
  depositHash: optional(short),
  expiresAt: optional(short),
})

const prepared = z.object({
  venueId: short,
  venueName: short,
  kind: z.enum(KINDS),
  summary: text,
  pay: z.object({ amount: short, symbol: short }),
  receive: optional(z.object({ amount: short, symbol: short, approximate: z.boolean() })),
  apy: optional(z.object({ basePercent: z.number(), rewardPercent: optional(z.number()) })),
  notes: z.array(text).max(20),
  thenPrepareAgain: optional(z.literal(true)),
})

const card = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('weave'),
    order,
    bank: optional(bank),
    hash: optional(short),
    explorerUrl: optional(httpsUrl),
  }),
  z.object({
    kind: z.literal('linq'),
    status: z.enum(NAIRA_STATUSES),
    order: z.object({
      amount: short,
      coin: short,
      amountNgn: short,
      accountName: short,
      bankName: short,
      accountMask: mask,
      paymentHash: optional(short),
    }),
    bank: optional(bank),
  }),
  z.object({
    kind: z.literal('chain'),
    phase: z.enum(['settled', 'failed', 'pending']),
    prepared: optional(prepared),
    hash: optional(short),
    explorerUrl: optional(httpsUrl),
    error: optional(text),
  }),
])

/** Drops keys whose value is undefined, so a card read back equals the card that was kept. */
function defined<T>(value: T): T {
  if (Array.isArray(value)) return value.map(defined) as T
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, defined(v)])
  ) as T
}

/** Rebuilt field by field from whatever was stored, or nothing when it isn't a card. */
export function toTurnCard(value: unknown): TurnCard | undefined {
  const parsed = card.safeParse(value)
  return parsed.success ? (defined(parsed.data) as TurnCard) : undefined
}

/** A sign card's last screen, or nothing while it is still being built, reviewed or signed. */
export function chainTurnCard(state: {
  phase: string
  prepared?: PreparedAction | undefined
  hash?: string | undefined
  explorerUrl?: string | undefined
  error?: string | undefined
}): TurnCard | undefined {
  const { phase } = state
  if (phase !== 'settled' && phase !== 'failed' && phase !== 'pending') return undefined
  const kept =
    state.prepared === undefined
      ? undefined
      : (({ signing: _s, context: _c, receipt: _r, ...rest }) => rest)(state.prepared)
  return toTurnCard({
    kind: 'chain',
    phase,
    prepared: kept,
    hash: state.hash,
    explorerUrl: state.explorerUrl,
    error: state.error,
  })
}

const STOPPED: Record<string, string> = {
  failed: 'Payout stopped: the payout failed.',
  expired: 'Payout stopped: the order expired.',
  refunded: 'Payout stopped: the deposit was refunded.',
}

/** A payout card's outcome in one line for the saved chat, or nothing while it still runs. */
export function payoutLine(card: TurnCard): string | undefined {
  if (card.kind === 'chain') return undefined
  const status = card.kind === 'weave' ? card.order.status : card.status
  if (status === 'paid') {
    const paid =
      card.kind === 'weave'
        ? `${card.order.paidDest ?? card.order.estimatedDest} ${card.order.currency}`
        : `${card.order.amountNgn} NGN`
    const to =
      card.kind === 'weave'
        ? `${card.order.institutionName} ${card.order.accountMask}`
        : `${card.order.bankName} ${card.order.accountMask}`
    return `Payout complete: ${paid} paid to ${to}.`
  }
  return STOPPED[status]
}
