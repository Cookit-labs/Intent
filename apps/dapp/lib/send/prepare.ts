import { NameLookupFailed, NameNotFound, UnsupportedRecipient } from '../names/errors'
import type { ResolvedRecipient } from '../names/resolve'
import { memoFromAnchor } from '../offramp/memo'
import { resolveAsset, toBaseUnits } from '../swap/assets'
import type { SendExpectation } from './build-payment'

/**
 * What sits between a resolved recipient and a payment.
 *
 * Kept out of the routes so it can be tested without one: sizing a dollar
 * amount, turning the resolution into the expectation the builder checks
 * against, and naming the HTTP answer a failed resolution deserves. The
 * routes validate a body and call these; nothing here reads a request.
 */

/**
 * How many units a dollar figure buys at a price, to the ledger's precision.
 *
 * Refuses rather than guesses when there is no price. A dollar amount sized
 * against a fallback constant is a payment of an amount the user never chose,
 * and the sentence "no live price" is the honest one.
 */
export function unitsForUsd(amountUsd: string, priceUsd: number | undefined): string {
  if (priceUsd === undefined || !Number.isFinite(priceUsd) || priceUsd <= 0) {
    throw new Error('no live price, so a dollar amount cannot be sized')
  }
  const dollars = Number(amountUsd)
  if (!Number.isFinite(dollars) || dollars <= 0) {
    throw new Error(`amount "${amountUsd}" is not a positive number of dollars`)
  }
  return (dollars / priceUsd).toFixed(7)
}

/**
 * The expectation a payment to this recipient must meet.
 *
 * The destination is the resolution's and nothing else's. The memo is the
 * recipient's when the resolution named one — an exchange's federation answer
 * is a pooled account and a memo saying whose deposit this is — and a memo the
 * user typed on top of that is refused rather than dropped, because one of
 * the two has to go and it should not go silently.
 */
export function expectationFor(
  resolved: ResolvedRecipient,
  symbol: string,
  amount: string,
  memo?: string
): SendExpectation {
  const asset = resolveAsset(symbol)
  if (asset === undefined) throw new Error(`${symbol} is not an asset this app can send`)

  if (BigInt(toBaseUnits(amount)) <= BigInt(0)) {
    throw new Error('amount must be more than zero')
  }

  const typed = memo?.trim()
  const own = typed !== undefined && typed !== '' ? typed : undefined

  let memoFields: Pick<SendExpectation, 'memo' | 'memoType'> = {}
  if (resolved.memo !== undefined && resolved.memoType !== undefined) {
    if (own !== undefined && own !== resolved.memo) {
      throw new Error(
        `${resolved.input} sets its own memo (${resolved.memoType} ${resolved.memo}), so a memo of your own cannot be sent with it`
      )
    }
    memoFields = { memo: resolved.memo, memoType: resolved.memoType }
  } else if (own !== undefined) {
    // Built once here so an over-long memo is refused before any envelope
    // exists, rather than at signing time.
    memoFromAnchor(own, 'text')
    memoFields = { memo: own, memoType: 'text' }
  }

  return {
    recipientInput: resolved.input,
    destination: resolved.address,
    amount,
    asset: { code: asset.code, ...(asset.issuer !== undefined ? { issuer: asset.issuer } : {}) },
    ...memoFields,
  }
}

export type ResolutionCode = 'not_found' | 'lookup_failed' | 'unsupported'

/** How a route reports a resolution that produced no address. */
export function resolutionFailure(e: unknown): {
  status: number
  code: ResolutionCode
  error: string
} {
  const error = e instanceof Error ? e.message : String(e)
  if (e instanceof NameNotFound) return { status: 404, code: 'not_found', error }
  if (e instanceof UnsupportedRecipient) return { status: 400, code: 'unsupported', error }
  if (e instanceof NameLookupFailed) return { status: 502, code: 'lookup_failed', error }
  return { status: 502, code: 'lookup_failed', error }
}
