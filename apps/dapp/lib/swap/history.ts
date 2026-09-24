import { stellarNetwork } from '@intent/config'

import { BLEND_POOL, blendPositionUrl } from './contract-registry'
import { OFFER_MEMO } from './build-offer'
import { PLAN_MEMO } from './build-plan'
import { POOL_MEMO } from './build-pool'
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

/**
 * What a settled transaction was, in the user's terms.
 *
 * 'bundle' is not readable from the ledger: a Soroban router swap carries no
 * memo, and the supply that follows it is a separate transaction the chain does
 * not associate with it. The caller joins that in from the app's own record.
 */
export type SwapKind = 'swap' | 'limit' | 'bundle' | 'pool'

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
  /**
   * What kind of thing this transaction was.
   *
   * Read from the memo, which already distinguishes them — the app stamps a
   * different one for a swap, a resting order, a plan and a pool operation.
   * The reader used to collapse all of that into a single boolean, so a limit
   * order appeared in history labelled "Swap", which is a different trade with
   * different behaviour.
   *
   * 'swap' is the fallback for an unstamped or unrecognised transaction, since
   * a path payment between the same account's assets is a swap whoever built
   * it.
   */
  kind: SwapKind
  /** True when the transaction carries this app's memo. */
  fromThisApp: boolean
  /**
   * Whether this kind of transaction could carry a memo at all.
   *
   * False for a Soroban router swap. Without this, `fromThisApp: false` reads
   * as "some other app made this" when it actually means "the question does not
   * apply", and filtering on it discards trades this app really did make.
   */
  stampable?: boolean
  /**
   * The transactions this one was bundled with, when the ledger shows it was.
   *
   * A swap followed moments later by a supply of what it delivered is one
   * instruction, but the chain does not say so: a Soroban call carries no memo
   * and the two transactions are unrelated on-chain. The pairing is inferred
   * here from amount and timing, which is the only evidence that survives a
   * cleared browser.
   */
  bundledWith?: LedgerBundleStep[]
  explorerUrl: string
}

/** One transaction inside a bundle reconstructed from the ledger. */
export interface LedgerBundleStep {
  label: string
  hash: string
  explorerUrl: string
  /** Where the position lives, for a step that left value in a protocol. */
  positionUrl?: string
  venue?: string
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
  /** Offer fields. Present only on manage_sell_offer / manage_buy_offer. */
  price?: string
  offer_id?: string
  selling_asset_type?: string
  selling_asset_code?: string
  buying_asset_type?: string
  buying_asset_code?: string
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

/**
 * The memo, read as a kind.
 *
 * Unrecognised and absent both fall back to 'swap'. A path payment moving one
 * asset to another within the same account is a swap regardless of which app
 * built it, so that is the honest default rather than a guess.
 */
const KNOWN_MEMOS = new Set([INTENT_MEMO, OFFER_MEMO, PLAN_MEMO, POOL_MEMO])

function kindOfMemo(memo: string | undefined): SwapKind {
  if (memo === OFFER_MEMO) return 'limit'
  if (memo === POOL_MEMO) return 'pool'
  // A plan is several operations under one signature. Shown as a bundle
  // because that is what it is to the person who signed it.
  if (memo === PLAN_MEMO) return 'bundle'
  return 'swap'
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
  const horizonUrl = options.horizonUrl ?? stellarNetwork.horizonUrl
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

  const pathPayments: SwapRecord[] = records
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
      kind: kindOfMemo(memoByHash.get(op.transaction_hash)),
      fromThisApp: KNOWN_MEMOS.has(memoByHash.get(op.transaction_hash) ?? ''),
      // A classic transaction can carry a text memo, so the stamp is a question
      // worth asking of it.
      stampable: true,
      explorerUrl: `${stellarNetwork.blockExplorerUrl}/tx/${op.transaction_hash}`,
    }))

  // A resting order is neither a path payment nor a contract call, so the
  // reader saw none of them: an account could place a limit order through this
  // app and find no trace of it in its own history. It is a different kind of
  // thing from a swap — nothing has been exchanged yet — but it is an
  // instruction the user gave and it belongs in the record.
  const offers: SwapRecord[] = records
    .filter((op) => op.type === 'manage_sell_offer' || op.type === 'manage_buy_offer')
    // A zero amount withdraws an order rather than placing one. Stellar has no
    // delete operation, so this is what a cancellation looks like on the
    // ledger, and listing it as a new order would invert its meaning.
    .filter((op) => Number(op.amount ?? '0') > 0)
    .map((op) => ({
      txHash: op.transaction_hash,
      settledAt: op.created_at,
      // What the order offers, and what it asks for. Not a settlement: an
      // order rests until the market reaches it, and may never fill.
      sentAmount: op.amount ?? '0',
      sentAsset: assetName(op.selling_asset_type, op.selling_asset_code),
      receivedAmount: op.price ?? '0',
      receivedAsset: assetName(op.buying_asset_type, op.buying_asset_code),
      hops: 0,
      kind: 'limit' as const,
      fromThisApp: KNOWN_MEMOS.has(memoByHash.get(op.transaction_hash) ?? ''),
      stampable: true,
      explorerUrl: `${stellarNetwork.blockExplorerUrl}/tx/${op.transaction_hash}`,
    }))

  const routed = records
    .filter((op) => op.type === 'invoke_host_function')
    .map((op) => routerSwapOf(op, account, memoByHash))
    .filter((row): row is SwapRecord => row !== undefined)

  // Newest first, matching the order Horizon returned and the order the two
  // lists were each already in.
  const swaps = [...pathPayments, ...offers, ...routed].sort((a, b) =>
    b.settledAt.localeCompare(a.settledAt)
  )

  // A supply is a contract call that only sends, so `routerSwapOf` discards it
  // — correctly, since it is not a swap. But it is half of a bundled intent,
  // and pairing it back to the swap that fed it is the only way a bundle
  // survives a cleared browser.
  attachBundles(swaps, supplies(records, account))

  if (!onlyThisApp) return swaps

  // A Soroban transaction carries no text memo, so a router swap can never be
  // stamped — not because it came from elsewhere, but because the stamp has
  // nowhere to live. Filtering it against a memo asks a question it is
  // structurally unable to answer, so it is kept regardless.
  //
  // This was a real regression rather than a theoretical one: the fallback
  // below only fires when *zero* swaps are stamped, so an account with any
  // classic trade at all silently discarded every router trade it ever made.
  const routerSwaps = swaps.filter((s) => s.stampable === false)
  const stamped = swaps.filter((s) => s.stampable !== false && s.fromThisApp)

  // Classic swaps made before the memo existed carry no stamp either, so
  // filtering strictly would hide trades this app really did make. Falling back
  // to the unfiltered list is the lesser wrong: showing a few extra swaps beats
  // telling a user their trade never happened.
  const keptClassic = stamped.length > 0 ? stamped : swaps.filter((s) => s.stampable !== false)

  return [...keptClassic, ...routerSwaps].sort((a, b) => b.settledAt.localeCompare(a.settledAt))
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
    kind: 'swap',
    fromThisApp: KNOWN_MEMOS.has(memoByHash.get(op.transaction_hash) ?? ''),
    // Soroban transactions cannot carry a text memo, so this trade is not
    // filterable by one either way.
    stampable: false,
    explorerUrl: `${stellarNetwork.blockExplorerUrl}/tx/${op.transaction_hash}`,
  }
}

/** A one-way transfer into a protocol: the supply half of a bundled intent. */
interface LedgerSupply {
  txHash: string
  settledAt: string
  amount: string
  asset: string
  /** The contract it went to. */
  to: string
}

/**
 * Transfers that left the account for a contract and brought nothing back.
 *
 * Deliberately not treated as swaps. Only supplies to a protocol this app
 * integrates are collected, because a transfer to an unknown contract could be
 * anything and naming it would be a guess dressed as a fact.
 */
function supplies(records: HorizonOperation[], account: string): LedgerSupply[] {
  const found: LedgerSupply[] = []

  for (const op of records) {
    if (op.type !== 'invoke_host_function') continue
    const changes = op.asset_balance_changes ?? []

    const out = changes.find((c) => c.from === account && c.amount !== undefined)
    const back = changes.find((c) => c.to === account && c.amount !== undefined)
    // Both legs means a swap, which is handled elsewhere.
    if (out === undefined || back !== undefined) continue
    if (out.to !== BLEND_POOL) continue

    found.push({
      txHash: op.transaction_hash,
      settledAt: op.created_at,
      amount: out.amount ?? '0',
      asset: assetName(out.asset_type, out.asset_code),
      to: out.to,
    })
  }

  return found
}

/**
 * How long after a swap a supply may arrive and still belong to it.
 *
 * A sequence signs its second step as soon as the first confirms, so the gap is
 * seconds. Generous enough for a slow wallet prompt, tight enough that an
 * unrelated supply an hour later is not swept in.
 */
const BUNDLE_WINDOW_MS = 10 * 60 * 1000

/**
 * The fee makes the supplied amount slightly smaller than the swap's output,
 * so the match is proportional rather than exact. Real pairs differ by
 * thousandths of a percent; anything looser would pair coincidences.
 */
const BUNDLE_AMOUNT_TOLERANCE = 0.005

/**
 * Marks each swap that was followed by a supply of what it delivered.
 *
 * Matched on three things together — the same asset, a supply shortly after,
 * and an amount within a fee of the swap's output. One alone would pair
 * coincidences; all three together are what a sequence actually looks like.
 *
 * Mutates the rows in place, because the caller has already sorted and filtered
 * them and rebuilding the list would discard that work.
 */
function attachBundles(swaps: SwapRecord[], supplied: LedgerSupply[]): void {
  for (const supply of supplied) {
    const suppliedAt = new Date(supply.settledAt).getTime()
    const amount = Number(supply.amount)
    if (!Number.isFinite(amount) || amount <= 0) continue

    const match = swaps.find((swap) => {
      if (swap.receivedAsset !== supply.asset) return false
      const gap = suppliedAt - new Date(swap.settledAt).getTime()
      if (gap < 0 || gap > BUNDLE_WINDOW_MS) return false

      const delivered = Number(swap.receivedAmount)
      if (!Number.isFinite(delivered) || delivered <= 0) return false
      return Math.abs(delivered - amount) / delivered <= BUNDLE_AMOUNT_TOLERANCE
    })

    if (match === undefined) continue

    match.bundledWith = [
      {
        label: 'Swap',
        hash: match.txHash,
        explorerUrl: match.explorerUrl,
      },
      {
        label: `Supply ${supply.amount} ${supply.asset} to Blend`,
        hash: supply.txHash,
        explorerUrl: `${stellarNetwork.blockExplorerUrl}/tx/${supply.txHash}`,
        positionUrl: blendPositionUrl(supply.to),
        venue: 'Blend',
      },
    ]
    match.kind = 'bundle'
  }
}
