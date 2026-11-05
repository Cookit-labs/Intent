import { NextResponse } from 'next/server'

import { enforceRateLimit } from '../../../../lib/server/rate-limit'
import { reportError } from '../../../../lib/server/report'
import { depositChain } from '../../../../lib/weave/deposit'
import { guardCashout } from '../../../../lib/weave/guard'
import { isCashoutChain } from '../../../../lib/weave/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function displayUnits(units: bigint, decimals: number): string {
  const text = units.toString().padStart(decimals + 1, '0')
  const whole = text.slice(0, -decimals)
  const fraction = text.slice(-decimals).replace(/0+$/, '')
  return fraction === '' ? whole : `${whole}.${fraction}`
}

/** How much USDC a wallet holds on a chain, for the form's "Available". */
export async function GET(request: Request): Promise<Response> {
  const query = new URL(request.url).searchParams
  const chain = query.get('chain') ?? ''
  if (!isCashoutChain(chain)) {
    return NextResponse.json({ error: 'unknown_chain' }, { status: 400 })
  }
  const guard = guardCashout(request, chain)
  if (!guard.ok) return guard.response
  const limited = await enforceRateLimit(request, 'build')
  if (limited !== undefined) return limited

  const deposit = depositChain(chain)
  const account = query.get('account') ?? ''
  if (!deposit.isAccount(account)) {
    return NextResponse.json({ error: 'invalid_account' }, { status: 400 })
  }

  try {
    const units = await deposit.usdcBalance(account)
    return NextResponse.json({ balance: displayUnits(units, deposit.usdcDecimals) })
  } catch (e) {
    // Not answered as zero: the form would then say the wallet can't afford this.
    reportError('cashout/balance', e, { chain })
    return NextResponse.json({ error: 'unavailable' }, { status: 503 })
  }
}
