import { stellarTestnet } from '@intent/config'

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

interface OperationsResponse {
  _embedded?: { records?: HorizonOperation[] }
}

function assetName(type: string | undefined, code: string | undefined): string {
  return type === 'native' || type === undefined ? 'XLM' : (code ?? '?')
}

export interface HistoryOptions {
  horizonUrl?: string
  fetchImpl?: typeof fetch
  /** How many operations to scan. Swaps are a minority of account activity. */
  limit?: number
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

  const url = `${horizonUrl}/accounts/${account}/operations?order=desc&limit=${limit}`

  let res: Response
  try {
    res = await doFetch(url, { headers: { Accept: 'application/json' } })
  } catch {
    // An unreachable Horizon means no history to show, not a broken page.
    return []
  }

  // A brand-new account has no operations at all; that is empty, not an error.
  if (!res.ok) return []

  let body: OperationsResponse
  try {
    body = (await res.json()) as OperationsResponse
  } catch {
    return []
  }

  return (body._embedded?.records ?? [])
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
      explorerUrl: `${stellarTestnet.blockExplorerUrl}/tx/${op.transaction_hash}`,
    }))
}
