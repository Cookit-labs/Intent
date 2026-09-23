import { NextResponse } from 'next/server'

import { createNoetherClient } from '../../../../lib/perps/noether-client'
import { submitOrder, validateOrderRequest } from '../../../../lib/perps/order-flow'

/**
 * Submits a signed Noether position through the gateway.
 *
 * The contracts are resolved **again** here and the signed envelope
 * re-asserted against the same request the browser sent to prepare. Between
 * prepare and submit the XDR passed through the browser and a wallet
 * extension; two independent reads bracket the signature, as they do for the
 * offramp payment.
 *
 * Submission goes through the gateway rather than Horizon because the
 * gateway polls the RPC and decodes the contract's own error names — the
 * difference between "failed" and "InsufficientCollateral".
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const STATUS_FOR: Record<string, number> = {
  offline: 502,
  refused: 400,
  failed: 409,
  pending: 202,
  missing_bearer: 401,
  malformed_bearer: 401,
  invalid_bearer: 401,
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }

  const token = body['authToken']
  if (typeof token !== 'string' || token === '') {
    return NextResponse.json({ error: 'authToken is required' }, { status: 400 })
  }
  const signedXdr = body['signedXdr']
  if (typeof signedXdr !== 'string' || signedXdr === '') {
    return NextResponse.json({ error: 'signedXdr is required' }, { status: 400 })
  }
  const validated = validateOrderRequest(body)
  if (!validated.ok) return NextResponse.json({ error: validated.error }, { status: 400 })

  const out = await submitOrder({
    client: createNoetherClient(),
    token,
    request: validated.request,
    signedXdr,
  })
  if (!out.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: out.error,
        code: out.code,
        ...(out.hash !== undefined ? { hash: out.hash } : {}),
      },
      { status: STATUS_FOR[out.code] ?? 502 }
    )
  }
  return NextResponse.json(out)
}
