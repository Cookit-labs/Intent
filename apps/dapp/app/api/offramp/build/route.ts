import { NextResponse } from 'next/server'

import { buildOfframpPayment } from '../../../../lib/offramp/build-payment'
import { readExpectation } from '../../../../lib/offramp/read-expectation'
import { USDC, toBaseUnits } from '../../../../lib/swap/assets'
import { balanceOf } from '../../../../lib/swap/delivered-balance'

/**
 * Builds the offramp payment, ready for signature.
 *
 * The browser sends which anchor and which withdrawal; it does not send where
 * the money goes. Destination, memo, amount and asset are read from the anchor
 * *here*, and the payment is built from that read alone. A compromised page
 * can ask for the wrong withdrawal id; it cannot name a destination.
 *
 * Refuses unless the anchor's status is `pending_user_transfer_start`. Before
 * that the anchor has provisioned nothing and a payment goes to an account not
 * expecting it — silently, which is why this is a refusal and not a warning.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface Body {
  account?: unknown
  anchor?: unknown
  transactionId?: unknown
  authToken?: unknown
}

const STATUS_FOR: Record<string, number> = {
  unknown_anchor: 400,
  anchor_unreachable: 502,
  not_ready: 409,
  declined: 409,
  unusable: 502,
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: Body
  try {
    body = (await request.json()) as Body
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }

  for (const key of ['account', 'anchor', 'transactionId', 'authToken'] as const) {
    if (typeof body[key] !== 'string' || body[key] === '') {
      return NextResponse.json({ error: `${key} is required` }, { status: 400 })
    }
  }
  const account = body.account as string
  const anchorId = body.anchor as string
  const transactionId = body.transactionId as string
  const authToken = body.authToken as string

  const read = await readExpectation({ anchorId, transactionId, authToken })
  if (!read.ok) {
    return NextResponse.json(
      {
        error: read.message,
        code: read.code,
        ...(read.status !== undefined ? { status: read.status } : {}),
      },
      { status: STATUS_FOR[read.code] ?? 500 }
    )
  }

  // The anchor may ask for more than the swap delivered. The app never rounds
  // up to meet it: the figures are named and the user decides.
  try {
    const held = await balanceOf(account, USDC.code)
    const asked = BigInt(toBaseUnits(read.expectation.amount))
    if (held !== undefined && held < asked) {
      return NextResponse.json(
        {
          error: `The anchor asks for ${read.expectation.amount} USDC and this account holds ${(Number(held) / 1e7).toFixed(7)}.`,
          code: 'insufficient',
        },
        { status: 409 }
      )
    }
  } catch {
    // A balance that cannot be read is not a reason to refuse; the network
    // will refuse an underfunded payment and the submit route reports it.
  }

  try {
    const built = await buildOfframpPayment({ account, expectation: read.expectation })
    return NextResponse.json({
      xdr: built.xdr,
      // Shown on the review card verbatim, so the user sees what the server
      // read rather than what the page believed.
      destination: read.expectation.destination,
      memo: read.expectation.memo,
      memoType: read.expectation.memoType,
      amount: read.expectation.amount,
      anchorStatus: read.tx.status,
      ...(read.tx.moreInfoUrl !== undefined ? { moreInfoUrl: read.tx.moreInfoUrl } : {}),
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'could not build the payment' },
      { status: 400 }
    )
  }
}
