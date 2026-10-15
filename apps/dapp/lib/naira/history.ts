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
export async function fetchCashouts(fetchImpl: typeof fetch = fetch): Promise<CashoutOrder[]> {
  try {
    const res = await fetchImpl('/api/naira/orders')
    if (!res.ok) return []
    const body = (await res.json()) as { orders?: CashoutOrder[] }
    return Array.isArray(body.orders) ? body.orders : []
  } catch {
    return []
  }
}
