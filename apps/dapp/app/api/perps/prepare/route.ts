import { NextResponse } from 'next/server'

import { createNoetherClient } from '../../../../lib/perps/noether-client'
import { prepareOrder, validateOrderRequest } from '../../../../lib/perps/order-flow'
import { createRpcSimulate } from '../../../../lib/perps/simulate-order'
import { enforceRateLimit } from '../../../../lib/server/rate-limit'

/**
 * Prepares a Noether position, ready for review and signature.
 *
 * The gateway builds the envelope; this route reads it back against the
 * request, simulates it for the position the contract would open, and only
 * then hands it to the browser. An envelope that names another trader,
 * another market, another size or the other side never reaches the wallet.
 *
 * The bearer is the wallet's own API key, sent by the browser like the
 * SEP-10 token is; the server holds none.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const STATUS_FOR: Record<string, number> = {
  offline: 502,
  paused: 409,
  unknown_market: 400,
  refused: 400,
  simulation: 409,
  missing_bearer: 401,
  malformed_bearer: 401,
  invalid_bearer: 401,
  not_in_beta: 403,
}

export async function POST(request: Request): Promise<NextResponse> {
  const limited = await enforceRateLimit(request, 'build')
  if (limited !== undefined) return limited

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
  const validated = validateOrderRequest(body)
  if (!validated.ok) return NextResponse.json({ error: validated.error }, { status: 400 })

  const out = await prepareOrder({
    client: createNoetherClient(),
    simulate: createRpcSimulate(),
    token,
    request: validated.request,
  })
  if (!out.ok) {
    return NextResponse.json(
      { error: out.error, code: out.code },
      { status: STATUS_FOR[out.code] ?? 502 }
    )
  }
  return NextResponse.json(out.prepared)
}
