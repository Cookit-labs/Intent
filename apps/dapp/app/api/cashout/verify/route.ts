import { NextResponse } from 'next/server'
import { z } from 'zod'

import { enforceRateLimit } from '../../../../lib/server/rate-limit'
import { createWeaveClient } from '../../../../lib/weave/client'
import { isCashoutCurrency, liveCurrencies } from '../../../../lib/weave/corridors'
import { guardCashout } from '../../../../lib/weave/guard'
import { getWeaveOrderRepo } from '../../../../lib/weave/orders'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.object({
  currency: z.string().min(1).max(8),
  institution: z.string().min(1).max(64),
  accountIdentifier: z.string().regex(/^\+?[0-9A-Za-z]{6,34}$/),
})

/**
 * Looks up who an account belongs to, so the person can see it is the right one
 * before any money moves. The identifier is passed through and never stored or
 * logged here.
 */
export async function POST(request: Request): Promise<Response> {
  const guard = guardCashout(request)
  if (!guard.ok) return guard.response
  const limited = await enforceRateLimit(request, 'resolve')
  if (limited !== undefined) return limited

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_body', message: 'Check the account details and try again.' },
      { status: 400 }
    )
  }
  const { currency, institution, accountIdentifier } = parsed.data
  if (!isCashoutCurrency(currency) || !liveCurrencies().includes(currency)) {
    return NextResponse.json(
      { error: 'unknown_currency', message: 'Cash-outs do not pay out in that currency.' },
      { status: 400 }
    )
  }

  // An account this requester has already used was looked up then, and asking
  // again would spend a lookup to learn the same name.
  const known = await getWeaveOrderRepo()
    .then((repo) => repo.findHolder(guard.email, currency, institution, accountIdentifier))
    .catch(() => undefined)
  if (known !== undefined) return NextResponse.json({ accountName: known })

  const result = await createWeaveClient().verifyAccount({
    institution,
    accountIdentifier,
    currency,
  })
  if (!result.ok) {
    const status = result.code === 'rejected' ? 422 : 503
    return NextResponse.json({ error: result.code, message: result.message }, { status })
  }
  return NextResponse.json({ accountName: result.value.accountName })
}
