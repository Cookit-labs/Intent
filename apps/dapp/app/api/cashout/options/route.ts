import { NextResponse } from 'next/server'

import { CORRIDORS, isCurrencyAllowed, liveCurrencies } from '../../../../lib/weave/corridors'
import { guardCashout } from '../../../../lib/weave/guard'
import { isCashoutChain } from '../../../../lib/weave/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** The currencies this chain can cash out to right now. */
export async function GET(request: Request): Promise<Response> {
  const chain = new URL(request.url).searchParams.get('chain') ?? ''
  if (!isCashoutChain(chain)) {
    return NextResponse.json(
      { error: 'unknown_chain', message: 'Cash-outs are not available on this chain.' },
      { status: 400 }
    )
  }
  const guard = guardCashout(request, chain)
  if (!guard.ok) return guard.response

  return NextResponse.json({
    currencies: liveCurrencies()
      .filter((code) => isCurrencyAllowed(chain, code))
      .map((code) => CORRIDORS[code]),
  })
}
