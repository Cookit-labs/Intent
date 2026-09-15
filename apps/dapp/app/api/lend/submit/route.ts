import { NextResponse } from 'next/server'

import { assertSelfSupply, assertSelfWithdraw } from '../../../../lib/lend/blend-client'
import { submitSignedSwap } from '../../../../lib/swap/submit'

/**
 * Submits a signed supply.
 *
 * Re-validated even though it was checked at build time, because between the
 * two it passed through the client and a browser extension. The check that
 * matters here is the recipient: Blend credits the position to whatever the
 * call's `to` argument names, so an envelope altered in transit could deposit
 * the user's funds into somebody else's position while looking, at every other
 * level, like exactly the supply they approved.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<NextResponse> {
  // `kind` only selects which noun a refusal is phrased with. Both assertions
  // enforce the same rules, so an absent or unrecognised value is safe rather
  // than a hole — it falls through to the supply wording.
  let body: { signedXdr?: unknown; account?: unknown; kind?: 'supply' | 'withdraw' }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }

  if (typeof body.signedXdr !== 'string' || body.signedXdr === '') {
    return NextResponse.json({ error: 'signedXdr is required' }, { status: 400 })
  }

  // Required rather than optional, unlike the plan route. A supply has no
  // meaningful validation without knowing who it should credit, so submitting
  // one without an account to check against would skip the only check that
  // matters.
  if (typeof body.account !== 'string' || body.account === '') {
    return NextResponse.json({ error: 'account is required' }, { status: 400 })
  }

  try {
    // A withdrawal satisfies the supply assertion too — same function, same
    // three addresses — so this would pass either way. It is named explicitly
    // so a refusal says which kind of call was refused, rather than telling
    // someone withdrawing that their supply was rejected.
    if (body.kind === 'withdraw') {
      assertSelfWithdraw(body.signedXdr, body.account)
    } else {
      assertSelfSupply(body.signedXdr, body.account)
    }
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'refusing to submit' },
      { status: 400 }
    )
  }

  const result = await submitSignedSwap(body.signedXdr)
  return NextResponse.json(result)
}
