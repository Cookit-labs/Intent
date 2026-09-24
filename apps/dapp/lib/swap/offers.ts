import { stellarNetwork } from '@intent/config'

/**
 * Resting orders, read from the ledger rather than remembered by the app.
 *
 * The same inversion `history.ts` applies to settled swaps: the network holds
 * the record and this app is a view of it. An offer the app remembers placing
 * is a claim about the past; an offer Horizon returns is a fact about the
 * present. Only one of those survives a page reload, a second device, or a
 * fill that happened while nobody was watching.
 *
 * Partial fills come for free from the same source. Stellar decrements an
 * offer's `amount` as it trades, so an offer holding less than it was placed
 * with has filled some of the way — no bookkeeping needed on our side to
 * notice, and no way for our idea of progress to drift from the chain's.
 */

/** The offer shape Horizon returns. Only the fields this app reads. */
export interface HorizonOfferRecord {
  id: string
  seller: string
  selling: { asset_type: string; asset_code?: string; asset_issuer?: string }
  buying: { asset_type: string; asset_code?: string; asset_issuer?: string }
  /** What is still on the book, in display units. Shrinks as the offer fills. */
  amount: string
  price: string
  last_modified_ledger: number
}

export interface OpenOffer {
  id: string
  sellingAsset: string
  buyingAsset: string
  /** Still unfilled, in display units. */
  remaining: string
  /** Counter units per unit sold. */
  price: string
  lastModifiedLedger: number
}

function assetName(asset: HorizonOfferRecord['selling']): string {
  return asset.asset_type === 'native' ? 'XLM' : (asset.asset_code ?? 'unknown')
}

export interface OffersOptions {
  horizonUrl?: string
  fetchImpl?: typeof fetch
}

/**
 * Every offer an account currently has resting.
 *
 * A 404 means the account is not funded, which on Stellar is an ordinary state
 * rather than a fault — an account that does not exist has no offers, and
 * saying so is the correct answer. Anything else throws, because an empty list
 * would claim "you have no resting orders" when the truth is "we could not
 * find out", and those must not look the same to someone deciding whether to
 * place another.
 */
export async function fetchOpenOffers(
  account: string,
  options: OffersOptions = {}
): Promise<OpenOffer[]> {
  const horizonUrl = options.horizonUrl ?? stellarNetwork.horizonUrl
  const doFetch = options.fetchImpl ?? fetch

  const res = await doFetch(`${horizonUrl}/accounts/${account}/offers?limit=200`, {
    headers: { Accept: 'application/json' },
  })

  if (res.status === 404) return []
  if (!res.ok) throw new Error(`Horizon ${res.status}`)

  const body = (await res.json()) as { _embedded?: { records?: HorizonOfferRecord[] } }
  const records = body._embedded?.records ?? []

  return records.map((r) => ({
    id: r.id,
    sellingAsset: assetName(r.selling),
    buyingAsset: assetName(r.buying),
    remaining: r.amount,
    price: r.price,
    lastModifiedLedger: r.last_modified_ledger,
  }))
}

export interface FillProgress {
  /** How much has traded, in display units. */
  filled: string
  filledPct: number
  /** True when some but not all of the order has traded. */
  partial: boolean
}

/**
 * How far a resting order has got.
 *
 * `placed` is optional because an offer read from the chain carries no memory
 * of its original size — only what is left. Without the original there is
 * nothing to measure against, and reporting a guess would be worse than
 * reporting no progress at all.
 */
export function fillProgress({
  placed,
  remaining,
}: {
  placed: string | undefined
  remaining: string
}): FillProgress {
  if (placed === undefined) return { filled: '0', filledPct: 0, partial: false }

  const placedNum = Number(placed)
  const remainingNum = Number(remaining)

  if (!Number.isFinite(placedNum) || placedNum <= 0 || !Number.isFinite(remainingNum)) {
    return { filled: '0', filledPct: 0, partial: false }
  }

  const filledNum = Math.max(0, placedNum - remainingNum)
  const pct = Math.min(100, (filledNum / placedNum) * 100)

  return {
    filled: trim(filledNum),
    filledPct: pct,
    // Fully filled is not partial, and neither is untouched. Only the middle
    // needs the caveat that some of the order is still working.
    partial: filledNum > 0 && remainingNum > 0,
  }
}

/** Display form without trailing zeroes, at the ledger's precision. */
function trim(value: number): string {
  return value.toFixed(7).replace(/0+$/, '').replace(/\.$/, '')
}
