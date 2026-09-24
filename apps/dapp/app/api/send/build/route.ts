import { stellarNetwork } from '@intent/config'
import { NextResponse } from 'next/server'

import { resolveRecipient } from '../../../../lib/names/resolve'
import { buildSendPayment } from '../../../../lib/send/build-payment'
import {
  CannotReceive,
  assertCanReceive,
  expectationFor,
  resolutionFailure,
  unitsForUsd,
} from '../../../../lib/send/prepare'
import { feePaidBy } from '../../../../lib/sponsor/sponsor'
import { resolveAsset } from '../../../../lib/swap/assets'
import { derivePreview } from '../../../../lib/swap/preview'
import { fetchMarketPrices } from '../../../../lib/swap/prices'

/**
 * Builds the payment a user is about to sign, to whoever the recipient
 * resolves to.
 *
 * The browser sends the recipient as typed; it does not send an address for
 * it. The name is resolved *here*, the payment is built from that answer
 * alone, and the answer is returned so the card shows what the server read
 * rather than what the page believed. A compromised page can ask to pay the
 * wrong name; it cannot name a destination.
 *
 * A dollar amount is sized against the same price source the agents reason
 * from, and refused when that source has only a fallback figure: a payment
 * sized against a constant is a payment of an amount nobody chose.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface Body {
  account?: unknown
  asset?: unknown
  amount?: unknown
  amountIsUsd?: unknown
  recipient?: unknown
  memo?: unknown
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: Body
  try {
    body = (await request.json()) as Body
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }

  for (const key of ['account', 'asset', 'amount', 'recipient'] as const) {
    if (typeof body[key] !== 'string' || body[key] === '') {
      return NextResponse.json({ error: `${key} is required` }, { status: 400 })
    }
  }
  if (body.memo !== undefined && typeof body.memo !== 'string') {
    return NextResponse.json({ error: 'memo must be text' }, { status: 400 })
  }
  const account = body.account as string
  const symbol = body.asset as string
  const recipient = body.recipient as string
  const memo = body.memo as string | undefined

  // Refused before the name is asked about: an asset the app cannot send is
  // a refusal whatever the name resolves to, and a registry read is not free.
  if (resolveAsset(symbol) === undefined) {
    return NextResponse.json(
      { error: `${symbol} is not an asset this app can send` },
      { status: 400 }
    )
  }

  let resolved
  try {
    resolved = await resolveRecipient(recipient)
  } catch (e) {
    const { status, ...failure } = resolutionFailure(e)
    return NextResponse.json(failure, { status })
  }

  let amount = body.amount as string
  if (body.amountIsUsd === true) {
    try {
      const price = (await fetchMarketPrices())[symbol]
      amount = unitsForUsd(amount, price?.source === 'fallback' ? undefined : price?.usd)
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : 'could not size the amount' },
        { status: 400 }
      )
    }
  }

  let expectation
  try {
    expectation = expectationFor(resolved, symbol, amount, memo)
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'could not build the payment' },
      { status: 400 }
    )
  }

  // Asked before the envelope exists. The network would refuse a payment to
  // an account it has never seen, or one without the trustline, only after
  // the signature and with a code that blames the sender.
  try {
    await assertCanReceive(resolved, expectation.asset)
  } catch (e) {
    if (e instanceof CannotReceive) {
      const { status, ...failure } = resolutionFailure(e)
      return NextResponse.json(failure, { status })
    }
    return NextResponse.json(
      { error: "the recipient's account could not be checked on testnet" },
      { status: 502 }
    )
  }

  try {
    const built = await buildSendPayment({ account, expectation })
    return NextResponse.json({
      xdr: built.xdr,
      // Returned so the submit route can be asked to check the same figures,
      // and so the card shows what the server built rather than what the
      // page asked for.
      expectation,
      resolved,
      preview: {
        ...derivePreview(built.xdr, account, stellarNetwork.networkPassphrase),
        feePaidBy: feePaidBy(),
      },
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'could not build the payment' },
      { status: 400 }
    )
  }
}
