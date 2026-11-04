import { NextResponse } from 'next/server'

import { enforceRateLimit } from '../../../../lib/server/rate-limit'
import { createWeaveClient, quoteCostPercent } from '../../../../lib/weave/client'
import { isCurrencyAllowed } from '../../../../lib/weave/corridors'
import { depositChain } from '../../../../lib/weave/deposit'
import { guardCashout } from '../../../../lib/weave/guard'
import { readUsdcAmount } from '../../../../lib/weave/orders'
import { isCashoutChain } from '../../../../lib/weave/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function refuse(error: string, message: string): Response {
  return NextResponse.json({ error, message }, { status: 400 })
}

/** What a cash-out would pay, what it would cost, and how long it should take. */
export async function GET(request: Request): Promise<Response> {
  const query = new URL(request.url).searchParams
  const chain = query.get('chain') ?? ''
  if (!isCashoutChain(chain)) {
    return refuse('unknown_chain', 'Cash-outs are not available on this chain.')
  }
  const guard = guardCashout(request, chain)
  if (!guard.ok) return guard.response
  const limited = await enforceRateLimit(request, 'build')
  if (limited !== undefined) return limited

  const currency = query.get('currency') ?? ''
  if (!isCurrencyAllowed(chain, currency)) {
    return refuse('unknown_currency', 'This chain does not cash out to that currency.')
  }
  const amount = readUsdcAmount(query.get('amount') ?? '', depositChain(chain).usdcDecimals)
  if (amount === undefined) {
    return refuse('invalid_amount', 'Enter an amount of USDC greater than zero.')
  }

  const result = await createWeaveClient().quote({ chain, currency, amount })
  if (!result.ok) {
    const status = result.code === 'rejected' ? 422 : 503
    return NextResponse.json({ error: result.code, message: result.message }, { status })
  }
  const cost = quoteCostPercent(amount, result.value.netUsd)
  return NextResponse.json({
    destAmount: result.value.destAmount,
    costPercent: Math.max(0, Math.round(cost * 100) / 100),
    seconds: result.value.seconds,
  })
}
