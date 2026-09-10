import { stellarTestnet } from '@intent/config'

import { INTENT_MEMO } from './build-tx'

/**
 * Swap history, read from the chain rather than remembered by the app.
 *
 * The app used to record trades as it made them, which meant history only
 * contained swaps performed in that browser, in that session, after the
 * recording code existed. A trade made yesterday, or on another device, or
 * before this feature shipped, was invisible — even though the network had it
 * the whole time.
 *
 * Reading from Horizon inverts that: the ledger is the record, the app is just
 * a view of it. Nothing to persist, nothing to keep in sync, and a swap is
 * present exactly when it actually happened.
 *
 * The account's ledger holds every swap it has ever made, including ones from
 * other Stellar apps entirely. Transactions this app builds carry a memo
 * (`intent:swap:v1`), which is what separates "trades made here" from "every
 * path payment this key has ever signed".
 */

export interface SwapRecord {
  txHash: string
  /** ISO timestamp from the ledger. */
  settledAt: string
  sentAmount: string
  sentAsset: string
  receivedAmount: string
  receivedAsset: string
  /** Intermediate hops. Zero for a direct swap. */
  hops: number
  /** True when the transaction carries this app's memo. */
  fromThisApp: boolean
  explorerUrl: string
}

interface HorizonOperation {
  type: string
  transaction_hash: string
  created_at: string
  from?: string
  to?: string
  amount?: string
  source_amount?: string
  asset_type?: string
  asset_code?: string
  source_asset_type?: string
  source_asset_code?: string
  path?: { asset_type: string; asset_code?: string }[]
}

interface HorizonTransaction {
  hash: string
  memo?: string
  memo_type?: string
}

function assetName(type: string | undefined, code: string | undefined): string {
  return type === 'native' || type === undefined ? 'XLM' : (code ?? '?')
}

export interface HistoryOptions {
  horizonUrl?: string
  fetchImpl?: typeof fetch
  /** How many operations to scan. Swaps are a minority of account activity. */
  limit?: number
  /**
   * Restrict to trades this app made.
   *
   * Defaults to true, because a history screen inside an app is understood to
   * be that app's history. The unfiltered view still exists for anyone who
   * wants the whole account.
   */
  onlyThisApp?: boolean
}

async function fetchJson<T>(url: string, doFetch: typeof fetch): Promise<T | undefined> {
  try {
    const res = await doFetch(url, { headers: { Accept: 'application/json' } })
    // A brand-new account 404s; that is empty history, not an error.
    if (!res.ok) return undefined
    return (await res.json()) as T
  } catch {
    return undefined
  }
}

/**
 * Every swap this account has made, newest first.
 *
 * Only path payments where the account paid itself are returned. That is the
 * shape this app produces, and it is also what distinguishes a swap from an
 * ordinary payment to someone else — which belongs in a transfer history, not
 * here.
 */
export async function fetchSwapHistory(
  account: string,
  options: HistoryOptions = {}
): Promise<SwapRecord[]> {
  const horizonUrl = options.horizonUrl ?? stellarTestnet.horizonUrl
  const doFetch = options.fetchImpl ?? fetch
  const limit = options.limit ?? 100
  const onlyThisApp = options.onlyThisApp ?? true

  // Two calls because Horizon splits the data: operations carry the amounts,
  // transactions carry the memo, and a swap needs both.
  const [ops, txs] = await Promise.all([
    fetchJson<{ _embedded?: { records?: HorizonOperation[] } }>(
      `${horizonUrl}/accounts/${account}/operations?order=desc&limit=${limit}`,
      doFetch
    ),
    fetchJson<{ _embedded?: { records?: HorizonTransaction[] } }>(
      `${horizonUrl}/accounts/${account}/transactions?order=desc&limit=${limit}`,
      doFetch
    ),
  ])

  const memoByHash = new Map<string, string>()
  for (const t of txs?._embedded?.records ?? []) {
    if (t.memo_type === 'text' && t.memo !== undefined) memoByHash.set(t.hash, t.memo)
  }

  const swaps = (ops?._embedded?.records ?? [])
    .filter((op) => op.type.startsWith('path_payment'))
    // Self-payment is what makes it a swap rather than a transfer.
    .filter((op) => op.from !== undefined && op.from === op.to)
    .map((op) => ({
      txHash: op.transaction_hash,
      settledAt: op.created_at,
      sentAmount: op.source_amount ?? '0',
      sentAsset: assetName(op.source_asset_type, op.source_asset_code),
      receivedAmount: op.amount ?? '0',
      receivedAsset: assetName(op.asset_type, op.asset_code),
      hops: op.path?.length ?? 0,
      fromThisApp: memoByHash.get(op.transaction_hash) === INTENT_MEMO,
      explorerUrl: `${stellarTestnet.blockExplorerUrl}/tx/${op.transaction_hash}`,
    }))

  if (!onlyThisApp) return swaps

  const stamped = swaps.filter((s) => s.fromThisApp)

  // Swaps made before the memo existed carry no stamp, so filtering strictly
  // would hide trades this app really did make. Falling back to the unfiltered
  // list is the lesser wrong: showing a few extra swaps beats telling a user
  // their trade never happened.
  return stamped.length > 0 ? stamped : swaps
}
