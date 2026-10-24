import type { ChatTurn } from '../chat-history'
import type { SwapRecord } from '../swap/history'
import type { NairaCoin } from './build-payment'
import type { NairaStatus } from './status'

/**
 * Cash-outs, as rows of the History list.
 *
 * The ledger cannot tell a payout from any other payment: it is a plain
 * payment to an address the provider made for one order, and that account is
 * gone afterwards. The app's own record of the order is what knows it was a
 * cash-out, so History merges the two.
 */

/** One paid-out order as the list endpoint returns it. */
export interface CashoutOrder {
  id: string
  status: NairaStatus
  coin: NairaCoin
  /** Amount of `coin` that was sent. */
  amount: string
  /** Naira the account holder receives. */
  amountNgn: string
  bankName: string
  accountName: string
  accountMask: string
  paymentHash: string | undefined
  createdAt: string
}

export const PAYOUT_STATUS_LABEL: Record<NairaStatus, string> = {
  waiting: 'Waiting',
  processing: 'Paying out',
  paid: 'Paid',
  expired: 'Expired',
  failed: 'Failed',
}

/** An order whose payment was sent, as a History row. Orders never paid are not shown. */
export function cashoutRecords(orders: CashoutOrder[], explorerBase: string): SwapRecord[] {
  return orders
    .filter((o) => o.paymentHash !== undefined && o.paymentHash !== '')
    .map((o) => ({
      txHash: o.paymentHash as string,
      settledAt: o.createdAt,
      sentAmount: o.amount,
      sentAsset: o.coin.toUpperCase(),
      receivedAmount: o.amountNgn,
      receivedAsset: 'NGN',
      hops: 0,
      kind: 'cashout' as const,
      fromThisApp: true,
      stampable: false,
      explorerUrl: `${explorerBase}/tx/${o.paymentHash as string}`,
      payout: {
        status: o.status,
        statusLabel: PAYOUT_STATUS_LABEL[o.status],
        bankName: o.bankName,
        accountName: o.accountName,
        accountMask: o.accountMask,
      },
    }))
}

/** The signed-in user's paid cash-outs. An unavailable list is an empty one: History still shows the ledger. */
export async function fetchCashouts(
  /** The connected wallet. History is per wallet, so only its cash-outs are asked for. */
  account: string,
  fetchImpl: typeof fetch = fetch
): Promise<CashoutOrder[]> {
  try {
    const res = await fetchImpl(`/api/naira/orders?account=${encodeURIComponent(account)}`)
    if (!res.ok) return []
    const body = (await res.json()) as { orders?: CashoutOrder[] }
    return Array.isArray(body.orders) ? body.orders : []
  } catch {
    return []
  }
}

/** Id prefix of a past-intents row that stands for a cash-out rather than a recorded chat. */
export const CASHOUT_TURN_PREFIX = 'cashout:'

/**
 * What the assistant did when it opened the cash-out form, kept so a reopened
 * chat shows the reply even when no order was ever made.
 */
export function cashoutFormOutcome(symbol: string, amount: number | undefined): string {
  const what = amount !== undefined ? `${amount} ${symbol}` : symbol
  return `I opened the cash-out form to pay ${what} out to a Nigerian bank account. No payout was made from it.`
}

/** What a cash-out came to, as the assistant would say it. */
export function cashoutOutcome(o: {
  coin: string
  amount: string
  amountNgn: string
  bankName: string
  accountName: string
  accountMask: string
  status: NairaStatus
}): string {
  return `${PAYOUT_STATUS_LABEL[o.status]}: ${o.amount} ${o.coin.toUpperCase()} cashed out as ₦${o.amountNgn} to ${o.accountName}, ${o.bankName} ${o.accountMask}.`
}

/**
 * Cash-outs as rows of Past intents.
 *
 * A cash-out is an intent, but it never goes through the agent race that writes
 * a chat turn, so the list would not show it. This lists the order record's
 * payouts beside the chats, with enough to reopen as a conversation when the
 * chat itself was not kept.
 */
export function cashoutTurns(
  orders: CashoutOrder[],
  chain: string,
  /** Hashes a recorded chat already carries, so one payout is not listed twice. */
  have: ReadonlySet<string> = new Set()
): ChatTurn[] {
  return orders
    .filter((o) => o.paymentHash !== undefined && o.paymentHash !== '')
    .filter((o) => !have.has(o.paymentHash as string))
    .map((o) => ({
      id: `${CASHOUT_TURN_PREFIX}${o.id}`,
      chain,
      text: `Cash out ${o.amount} ${o.coin.toUpperCase()} to ${o.bankName}`,
      createdAt: o.createdAt,
      proposals: {},
      winner: null,
      txHash: o.paymentHash as string,
      outcome: cashoutOutcome(o),
    }))
}
