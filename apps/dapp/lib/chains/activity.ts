import { txExplorerUrl } from '@intent/config'
import type { ChainSlug } from '@intent/types'

import type { SwapKind, SwapRecord } from '../swap/history'
import type { WeaveOrderView } from '../weave/orders'
import type { WeaveStatus } from '../weave/status'

/**
 * A wallet's past transactions on any chain, from the app's own record of what it submitted.
 *
 * Client-safe: the route reads the rows and the History page words them here. Stellar also reads its
 * ledger, which knows about trades made elsewhere. No other chain has one reader that says what a
 * transaction was, so off Stellar this record is the list.
 */

export interface ActivityEntry {
  hash: string
  /** The logged kind, which folds actions together: a supply and a repay are both `lend`. */
  kind: string
  /** The action itself. Null on rows from before it was recorded. */
  action: string | null
  /** The venue's name. Null on rows from before it was recorded. */
  venue: string | null
  assetIn: string | null
  assetOut: string | null
  amountIn: string | null
  /** False when it was sent and the chain has not yet said how it ended. */
  confirmed: boolean
  at: string
}

/** Chains whose transactions are recorded, Arc being the one that has neither actions nor a log. */
const RECORDED_CHAINS: readonly ChainSlug[] = [
  'stellar',
  'solana',
  'sui',
  'near',
  'avalanche',
  'monad',
]

export function hasActivityRecord(slug: string): boolean {
  return (RECORDED_CHAINS as readonly string[]).includes(slug)
}

/** Which reader knows what this chain's wallet holds. Blend's only speaks Stellar addresses. */
export function chainPositionsSource(slug: ChainSlug): 'blend' | 'venues' | 'none' {
  if (slug === 'stellar') return 'blend'
  return hasActivityRecord(slug) ? 'venues' : 'none'
}

const COW_ORDERS = 'https://explorer.cow.fi/avax/orders/'
/** A CoW order is logged under its uid, far longer than any transaction hash, and lives on CoW. */
const COW_UID = /^0x[0-9a-fA-F]{112}$/

export function txExplorerLink(slug: ChainSlug, hash: string): string {
  return slug === 'avalanche' && COW_UID.test(hash)
    ? `${COW_ORDERS}${hash}`
    : txExplorerUrl(slug, hash)
}

const ACTION_TITLE: Readonly<Record<string, string>> = {
  swap: 'Swap',
  supply: 'Deposit',
  stake: 'Stake',
  send: 'Send',
  limit: 'Limit order',
  withdraw: 'Withdrawal',
  unstake: 'Unstake',
  borrow: 'Borrow',
  repay: 'Repayment',
  stream: 'Stream',
  invoice: 'Invoice',
  pay_invoice: 'Invoice payment',
  claim: 'Claim',
  cancel: 'Cancellation',
}

/** For a row with no action recorded. `lend` stays vague because it could be any of three things. */
const KIND_TITLE: Readonly<Record<string, string>> = {
  swap: 'Swap',
  send: 'Send',
  lend: 'Lending',
  perp: 'Perp trade',
  withdraw: 'Withdrawal',
  borrow: 'Borrow',
  claim: 'Claim',
  cancel: 'Cancellation',
  invoice: 'Invoice',
}

/** Kinds History already has a name and a shape for. */
const ROW_KIND: Readonly<Record<string, SwapKind>> = {
  swap: 'swap',
  plan: 'bundle',
  offer: 'limit',
  offramp: 'cashout',
}

function titleOf(entry: ActivityEntry): string | undefined {
  const named =
    (entry.action !== null ? ACTION_TITLE[entry.action] : undefined) ?? KIND_TITLE[entry.kind]
  if (named === undefined) return undefined
  // A transfer goes to a person, so the venue that carried it says nothing worth saying.
  return entry.venue !== null && entry.action !== 'send' ? `${named} on ${entry.venue}` : named
}

export function activityRecords(entries: readonly ActivityEntry[], slug: ChainSlug): SwapRecord[] {
  return entries.map((entry) => {
    const title = titleOf(entry)
    return {
      txHash: entry.hash,
      settledAt: entry.at,
      sentAmount: entry.amountIn ?? '',
      sentAsset: entry.assetIn ?? '',
      receivedAmount: '',
      receivedAsset: entry.assetOut ?? '',
      hops: 0,
      kind: ROW_KIND[entry.kind] ?? 'other',
      fromThisApp: true,
      stampable: false,
      recorded: true,
      explorerUrl: txExplorerLink(slug, entry.hash),
      ...(title === undefined ? {} : { title }),
      ...(entry.confirmed ? {} : { unconfirmed: true }),
    }
  })
}

/** Each transaction once, the first source's row winning, newest first. */
export function mergeHistory(
  primary: readonly SwapRecord[],
  recorded: readonly SwapRecord[]
): SwapRecord[] {
  const known = new Set(primary.map((row) => row.txHash))
  return [...primary, ...recorded.filter((row) => !known.has(row.txHash))].sort((a, b) =>
    b.settledAt.localeCompare(a.settledAt)
  )
}

const PAYOUT_LABEL: Readonly<Record<WeaveStatus, string>> = {
  waiting: 'Waiting',
  processing: 'Paying out',
  paid: 'Paid',
  failed: 'Failed',
  expired: 'Expired',
  refunded: 'Refunded',
}

/** A cash-out's chain record says what left the wallet; only its order knows what arrived. */
export function withPayouts(
  rows: readonly SwapRecord[],
  orders: readonly WeaveOrderView[],
  slug: ChainSlug
): SwapRecord[] {
  const byHash = new Map(
    orders
      .filter((o) => o.chain === slug && o.depositHash !== undefined)
      .map((o) => [o.depositHash as string, o])
  )
  return rows.map((row) => {
    const order = row.kind === 'cashout' ? byHash.get(row.txHash) : undefined
    if (order === undefined) return row
    return {
      ...row,
      receivedAmount: order.paidDest ?? order.estimatedDest,
      receivedAsset: order.currency,
      payout: {
        status: order.status,
        statusLabel: PAYOUT_LABEL[order.status],
        bankName: order.institutionName,
        accountName: order.accountName,
        accountMask: order.accountMask,
      },
    }
  })
}

/** What was typed for each settled hash, for rows from before the log said what they did. */
export function askedByHash(
  turns: readonly {
    text: string
    txHash?: string | undefined
    bundle?: readonly { hash?: string | undefined }[] | undefined
  }[]
): Map<string, string> {
  const byHash = new Map<string, string>()
  for (const turn of turns) {
    if (turn.txHash !== undefined) byHash.set(turn.txHash, turn.text)
    for (const step of turn.bundle ?? []) {
      if (step.hash !== undefined) byHash.set(step.hash, turn.text)
    }
  }
  return byHash
}

/** "First" is only true of a wallet known to have done nothing, so an unanswered read isn't it. */
export function composeInviteShown(history: { rows: number; settled: boolean }): boolean {
  return history.settled && history.rows === 0
}

export async function fetchActivity(
  slug: string,
  account: string,
  fetchImpl: typeof fetch = fetch
): Promise<ActivityEntry[]> {
  const res = await fetchImpl(`/api/chain/${slug}/activity?account=${encodeURIComponent(account)}`)
  if (!res.ok) throw new Error('could not read this wallet’s activity')
  const body = (await res.json()) as { entries?: ActivityEntry[] }
  return Array.isArray(body.entries) ? body.entries : []
}
