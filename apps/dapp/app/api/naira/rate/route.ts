import { NextResponse } from 'next/server'

import { createLinqClient } from '../../../../lib/linq/client'
import { guardNaira } from '../../../../lib/naira/guard'
import { enforceRateLimit } from '../../../../lib/server/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Indicative naira per US dollar, for the estimate under the amount field.
 * The order locks its own rate; this one is only to look at.
 */
export async function GET(request: Request): Promise<Response> {
  const guard = guardNaira(request)
  if (!guard.ok) return guard.response
  const limited = await enforceRateLimit(request, 'resolve')
  if (limited !== undefined) return limited

  const rate = await createLinqClient().getRate()
  if (!rate.ok) {
    return NextResponse.json({ error: rate.code, message: rate.message }, { status: 503 })
  }
  return NextResponse.json({ ngnPerUsd: rate.value.ngnPerUsd })
}
