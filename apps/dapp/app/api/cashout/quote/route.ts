import { NextResponse } from 'next/server'

import { createLinqClient } from '../../../../lib/linq/client'
import { enforceRateLimit } from '../../../../lib/server/rate-limit'
import { createWeaveClient, quoteCostPercent } from '../../../../lib/weave/client'
import { isCurrencyAllowed } from '../../../../lib/weave/corridors'
import { depositChain } from '../../../../lib/weave/deposit'
import { guardCashout } from '../../../../lib/weave/guard'
import { comparesLinq } from '../../../../lib/weave/linq-cashout'
import { readUsdcAmount } from '../../../../lib/weave/orders'
import { isCashoutChain } from '../../../../lib/weave/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function refuse(error: string, message: string): Response {
  return NextResponse.json({ error, message }, { status: 400 })
}

/**
 * What a cash-out would pay, what it would cost, and how long it should take.
 *
 * A naira cash-out from Sui or Solana is priced by whichever of Weave and Linq pays more, as the
 * order route places it. Linq's figure is the naira it pays; it states no fee of its own.
 */
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
  const linq = createLinqClient()
  // Sui and Solana naira go to Linq whenever it answers, so its locked rate is what is shown.
  if (comparesLinq(chain) && currency === 'NGN' && linq.configured) {
    const rate = await linq.getRate().catch(() => undefined)
    const naira = rate?.ok === true ? rate.value.ngnPerUsd * Number(amount) : Number.NaN
    if (Number.isFinite(naira) && naira > 0) {
      return NextResponse.json({
        destAmount: Math.floor(naira * 100) / 100,
        costPercent: 0,
        seconds: result.ok ? result.value.seconds : 0,
      })
    }
  }
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
