import { NextResponse } from 'next/server'

import { reportError } from '../../../../lib/server/report'
import { resolveAsset, type ClassicAsset } from '../../../../lib/swap/assets'
import { ensureLiveAssets, tickersIn } from '../../../../lib/swap/live-assets'
import { buildOfferTransaction } from '../../../../lib/swap/build-offer'
import { fetchOrderBookTop, offerPriceFromUsd } from '../../../../lib/swap/limit-price'
import { fetchOffer, type HorizonOfferRecord } from '../../../../lib/swap/offers'
import { enforceRateLimit } from '../../../../lib/server/rate-limit'

/**
 * Builds the transaction that places a resting order.
 *
 * Mirrors `/api/swap/build`: the server assembles the envelope, the wallet
 * signs it, and the browser never holds a key. The difference is what is
 * checked first — a swap is priced by the network at fill time, while an offer
 * commits to a price now, so the price is validated against the live book
 * here rather than trusted from the client.
 *
 * The refusal is the point of this route. A limit order priced through the
 * spread fills the instant it is submitted, which is a market order with a
 * misleading label, and it is the specific behaviour that made limit orders
 * look broken.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface BuildOfferBody {
  account?: string
  /** Symbol being given up. */
  sellSymbol?: string
  /** Symbol wanted in return. */
  buySymbol?: string
  /** Display units of the sell asset. */
  amount?: string
  /** The price the user actually named, in USD per unit bought. */
  limitPriceUsd?: number
  /** Present when replacing or cancelling an existing offer. */
  offerId?: string
}

function ledgerAsset(asset: HorizonOfferRecord['selling']): ClassicAsset {
  if (asset.asset_type === 'native') return { kind: 'classic', code: 'XLM' }
  return { kind: 'classic', code: asset.asset_code ?? '', issuer: asset.asset_issuer ?? '' }
}

export async function POST(req: Request): Promise<NextResponse> {
  const limited = await enforceRateLimit(req, 'build')
  if (limited !== undefined) return limited

  let body: BuildOfferBody
  try {
    body = (await req.json()) as BuildOfferBody
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }

  const { account, sellSymbol, buySymbol, amount, limitPriceUsd, offerId } = body

  if (account === undefined || account.trim() === '') {
    return NextResponse.json({ error: 'account_required' }, { status: 400 })
  }
  if (amount === undefined) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }

  // Cancelling is read from the ledger, not from the names a client sends. Getting an order back
  // must not depend on this app's token list: one placed with a token that later left the list,
  // or from another wallet app, would otherwise be listed here with no way to withdraw it.
  if (Number(amount) === 0) {
    if (offerId === undefined || offerId === '0') {
      return NextResponse.json({ error: 'offer_id_required' }, { status: 400 })
    }
    try {
      const offer = await fetchOffer(offerId)
      if (offer === undefined) {
        return NextResponse.json(
          {
            error: 'offer_gone',
            detail: 'This order is no longer open, so there is nothing to withdraw.',
          },
          { status: 404 }
        )
      }
      if (offer.seller !== account) {
        return NextResponse.json(
          {
            error: 'not_your_offer',
            detail: 'This order belongs to another account. Nothing was signed or sent.',
          },
          { status: 403 }
        )
      }
      const built = await buildOfferTransaction({
        account,
        selling: ledgerAsset(offer.selling),
        buying: ledgerAsset(offer.buying),
        amount: '0',
        // Any positive ratio serves; the operation is removing the order.
        price: { n: 1, d: 1 },
        offerId,
      })
      return NextResponse.json({ xdr: built.xdr, offerId: built.offerId, cancelling: true })
    } catch (e) {
      reportError('offers/build', e, { offerId })
      return NextResponse.json(
        { error: 'build_failed', detail: e instanceof Error ? e.message : undefined },
        { status: 400 }
      )
    }
  }

  if (sellSymbol === undefined || buySymbol === undefined) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }

  await ensureLiveAssets([sellSymbol, buySymbol])
  const selling = resolveAsset(sellSymbol)
  const buying = resolveAsset(buySymbol)
  if (selling === undefined || buying === undefined) {
    // The allowlist is deliberately small: an intent is free text read by a
    // model, and an unknown symbol must fail here rather than resolve to
    // whatever issuer answers to the name.
    return NextResponse.json({ error: 'unknown_asset' }, { status: 400 })
  }

  if (typeof limitPriceUsd !== 'number' || !Number.isFinite(limitPriceUsd)) {
    return NextResponse.json({ error: 'limit_price_required' }, { status: 400 })
  }

  // The book is read for the pair in its quoted orientation — XLM against
  // USDC — regardless of which way this particular order runs, because that is
  // the orientation the prices are expressed in.
  const base = selling.issuer === undefined ? selling : buying
  const counter = selling.issuer === undefined ? buying : selling

  let book
  try {
    book = await fetchOrderBookTop(base, counter)
  } catch (e) {
    reportError('offers/build', e, { sellSymbol, buySymbol })
    return NextResponse.json({ error: 'horizon_unreachable' }, { status: 502 })
  }

  const priced = offerPriceFromUsd({ limitPriceUsd, selling, buying, book })
  if (!priced.ok) {
    // A refusal is a real answer, not a fault: the UI offers a market swap
    // instead of quietly performing one.
    return NextResponse.json(
      {
        error: priced.reason,
        detail: priced.detail,
        marketPriceUsd: priced.marketPriceUsd,
      },
      { status: 409 }
    )
  }

  try {
    const built = await buildOfferTransaction({
      account,
      selling,
      buying,
      amount,
      price: priced.price,
    })

    return NextResponse.json({
      xdr: built.xdr,
      offerId: built.offerId,
      amount: built.amount,
      price: built.price,
      priceDecimal: priced.priceDecimal,
      // Both numbers travel to the UI so the gap between the user's target and
      // the market is shown rather than hidden.
      marketPriceUsd: priced.marketPriceUsd,
    })
  } catch (e) {
    return NextResponse.json(
      { error: 'build_failed', detail: e instanceof Error ? e.message : undefined },
      { status: 400 }
    )
  }
}
