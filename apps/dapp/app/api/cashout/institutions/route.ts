import { NextResponse } from 'next/server'

import { enforceRateLimit } from '../../../../lib/server/rate-limit'
import { createWeaveClient } from '../../../../lib/weave/client'
import { isCashoutCurrency, liveCurrencies } from '../../../../lib/weave/corridors'
import { guardCashout } from '../../../../lib/weave/guard'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** The banks and mobile money services a currency can be paid out to. */
export async function GET(request: Request): Promise<Response> {
  const guard = guardCashout(request)
  if (!guard.ok) return guard.response
  const limited = await enforceRateLimit(request, 'build')
  if (limited !== undefined) return limited

  const currency = new URL(request.url).searchParams.get('currency') ?? ''
  if (!isCashoutCurrency(currency) || !liveCurrencies().includes(currency)) {
    return NextResponse.json(
      { error: 'unknown_currency', message: 'Cash-outs do not pay out in that currency.' },
      { status: 400 }
    )
  }

  const result = await createWeaveClient().institutions(currency)
  if (!result.ok) {
    const status = result.code === 'rejected' ? 422 : 503
    return NextResponse.json({ error: result.code, message: result.message }, { status })
  }
  return NextResponse.json({ institutions: result.value })
}
