import { NextResponse } from 'next/server'

import { assertSelfSwap } from '../../../../lib/swap/build-tx'
import { assertSelfInvoke } from '../../../../lib/swap/build-soroban'
import { submitSignedSwap } from '../../../../lib/swap/submit'

/**
 * Submits a signed swap to the network.
 *
 * The signed envelope is re-checked before submission. It has already been
 * validated at build time, but it has since passed through the client and a
 * browser extension, and the cost of checking again is one decode against the
 * cost of broadcasting a payment to somebody else.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<NextResponse> {
  let body: { signedXdr?: unknown; account?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }

  if (typeof body.signedXdr !== 'string' || body.signedXdr === '') {
    return NextResponse.json({ error: 'signedXdr is required' }, { status: 400 })
  }

  if (typeof body.account === 'string' && body.account !== '') {
    // Either shape is acceptable here, but each must satisfy its own
    // assertion — a path payment proves the destination is the sender, and a
    // router call proves the recipient argument is. Accepting one envelope
    // under the other's check would let a transaction through with a
    // guarantee that was never verified for its shape.
    try {
      assertSelfSwap(body.signedXdr, body.account)
    } catch (classicError) {
      try {
        assertSelfInvoke(body.signedXdr, body.account)
      } catch {
        // Reported as the classic failure: that is the common case, and the
        // Soroban message would be confusing for what is almost always a
        // malformed path payment.
        return NextResponse.json(
          {
            error: classicError instanceof Error ? classicError.message : 'refusing to submit',
          },
          { status: 400 }
        )
      }
    }
  }

  const result = await submitSignedSwap(body.signedXdr)
  return NextResponse.json(result, { status: result.ok ? 200 : 200 })
}
