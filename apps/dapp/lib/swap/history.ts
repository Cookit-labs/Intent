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
 *
 * **Two shapes of swap, not one.** A classic swap is a path payment and states
 * its amounts directly. A Soroban router swap is an `invoke_host_function`, and
 * its amounts appear only in `asset_balance_changes` as a pair of transfers —
 * one leaving the account, one arriving. Reading path payments alone made every
 * Soroswap trade invisible here, which is exactly the route the agents pick
 * when it quotes better. A trade that really happened must not be missing from
 * the record because of how it was routed.
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
  /**
   * The transfers a contract call performed.
   *
   * Only present on `invoke_host_function`. A router swap moves value through
   * token contracts rather than through a path payment, so this is the only
   * place Horizon reports what was actually sent and received.
   */
  asset_balance_changes?: HorizonBalanceChange[]
}

interface HorizonBalanceChange {
  type?: string
  asset_type?: string
  asset_code?: string
  amount?: string
  from?: string
  to?: string
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

  const records = ops?._embedded?.records ?? []

  const classic = records
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

  const routed = records
    .filter((op) => op.type === 'invoke_host_function')
    .map((op) => routerSwapOf(op, account, memoByHash))
    .filter((row): row is SwapRecord => row !== undefined)

  // Newest first, matching the order Horizon returned and the order the two
  // lists were each already in.
  const swaps = [...classic, ...routed].sort((a, b) => b.settledAt.localeCompare(a.settledAt))

  if (!onlyThisApp) return swaps

  const stamped = swaps.filter((s) => s.fromThisApp)

  // Swaps made before the memo existed carry no stamp, so filtering strictly
  // would hide trades this app really did make. Falling back to the unfiltered
  // list is the lesser wrong: showing a few extra swaps beats telling a user
  // their trade never happened.
  return stamped.length > 0 ? stamped : swaps
}

/**
 * A router swap, read from the transfers a contract call performed.
 *
 * Returns nothing unless the account both sent and received something. A
 * contract call that only moves value one way is a deposit, a supply or a
 * transfer — real activity, but not a swap, and listing it as one would
 * misdescribe it.
 *
 * `fromThisApp` is false for every one of these: a Soroban transaction carries
 * no text memo, so the stamp that separates this app's classic trades from any
 * other wallet's cannot exist here. The caller's fallback handles that — it
 * shows the unstamped list rather than claiming the trade never happened.
 */
function routerSwapOf(
  op: HorizonOperation,
  account: string,
  memoByHash: Map<string, string>
): SwapRecord | undefined {
  const changes = op.asset_balance_changes ?? []
  if (changes.length === 0) return undefined

  const sent = changes.find((c) => c.from === account && c.amount !== undefined)
  const received = changes.find((c) => c.to === account && c.amount !== undefined)
  if (sent === undefined || received === undefined) return undefined

  return {
    txHash: op.transaction_hash,
    settledAt: op.created_at,
    sentAmount: sent.amount ?? '0',
    sentAsset: assetName(sent.asset_type, sent.asset_code),
    receivedAmount: received.amount ?? '0',
    receivedAsset: assetName(received.asset_type, received.asset_code),
    // A router reports no path, and the hop count is not recoverable from the
    // transfers. Zero states "not known" rather than asserting a direct route.
    hops: 0,
    fromThisApp: memoByHash.get(op.transaction_hash) === INTENT_MEMO,
    explorerUrl: `${stellarTestnet.blockExplorerUrl}/tx/${op.transaction_hash}`,
  }
}
