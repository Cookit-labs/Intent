import { NextResponse } from 'next/server'

import { readBlendPosition } from '../../../../lib/lend/position'

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
    const position = await readBlendPosition(account)
    // Null is a real answer — an account with nothing supplied — and must not
    // read as a failure, or an empty position would show as an error.
    return NextResponse.json({ position })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'could not read position' },
      { status: 502 }
    )
  }
}
