import { NextResponse } from 'next/server'
import { z } from 'zod'

import { createLinqClient } from '../../../../lib/linq/client'
import { bankByCode } from '../../../../lib/naira/banks'
import { guardNaira } from '../../../../lib/naira/guard'
import { holderOnRecord } from '../../../../lib/naira/holder'
import { enforceRateLimit } from '../../../../lib/server/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const body = z.object({
  bankCode: z.string().min(1).max(10),
  accountNumber: z.string().regex(/^\d{10}$/),
})

/**
 * Looks up who a bank account belongs to, so the form can show the holder's
 * name and the user can see it is the right person before any money moves.
 * The number is passed through and never stored or logged here.
 */
export async function POST(request: Request): Promise<Response> {
  const guard = guardNaira(request)
  if (!guard.ok) return guard.response
  const limited = await enforceRateLimit(request, 'resolve')
  if (limited !== undefined) return limited

  const parsed = body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_body', message: 'Enter the 10-digit account number.' },
      { status: 400 }
    )
  }
  if (bankByCode(parsed.data.bankCode) === undefined) {
    return NextResponse.json(
      { error: 'unknown_bank', message: 'That bank is not supported.' },
      { status: 400 }
    )
  }

  // An account this user has already been paid out to was looked up by the
  // provider then, and its holder is on record. Asking again spends lookups the
  // provider throttles, and a throttled lookup blocked a payout to an account
  // that had been verified an hour before.
  const known = await holderOnRecord(guard.email, parsed.data.bankCode, parsed.data.accountNumber)
  if (known !== undefined) return NextResponse.json({ accountName: known })

  const result = await createLinqClient().verifyBank(parsed.data)
  if (!result.ok) {
    const status = result.code === 'rejected' ? 422 : 503
    return NextResponse.json({ error: result.code, message: result.message }, { status })
  }
  return NextResponse.json({ accountName: result.value.accountName })
}
