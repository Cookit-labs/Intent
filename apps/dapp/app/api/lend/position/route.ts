import { NextResponse } from 'next/server'

import { readBlendPosition, readBlendPositions } from '../../../../lib/lend/position'

/**
 * What an account currently holds in the Blend pool.
 *
 * Read from the pool rather than from anything this app recorded. A supply can
 * be made, added to, or withdrawn from another client entirely, so the only
 * trustworthy answer to "what do I have there" comes from the contract — the
 * same reasoning that has open orders read from the ledger rather than a local
 * copy.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<NextResponse> {
  const account = new URL(request.url).searchParams.get('account')

  if (account === null || account.trim() === '') {
    return NextResponse.json({ error: 'account_required' }, { status: 400 })
  }

  try {
    const positions = await readBlendPositions(account)
    const position = await readBlendPosition(account)

    // `position` is the plain XLM supply, kept for callers written before
    // collateral existed. `positions` is the whole picture — supply,
    // collateral, debt and health — which is what anything showing risk needs.
    //
    // Null is a real answer for the former, meaning nothing supplied, and must
    // not read as a failure.
    return NextResponse.json({ position, positions })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'could not read position' },
      { status: 502 }
    )
  }
}
