import { isAddress as isSolanaAddress } from '@solana/kit'
import { NextResponse } from 'next/server'

import { NEAR_ACCOUNT } from '../../../../../lib/chains/near/account'
import type { PositionsReport, VenueHoldings } from '../../../../../lib/chains/positions-reply'
import { readPositionsBriefly } from '../../../../../lib/chains/prepare'
import { chainModule } from '../../../../../lib/chains/registry'
import type { ChainActionKind, ChainWithActions } from '../../../../../lib/chains/types'
import { enforceRateLimit } from '../../../../../lib/server/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 20

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/
const SUI_ADDRESS = /^0x[0-9a-fA-F]{64}$/

/** The same shapes the balance readers hold to. Every read swallows its error, so a bad address has to stop here. */
function isAccountOn(chain: ChainWithActions, account: string): boolean {
  switch (chain) {
    case 'solana':
      return isSolanaAddress(account)
    case 'sui':
      return SUI_ADDRESS.test(account)
    case 'near':
      return NEAR_ACCOUNT.test(account)
    case 'avalanche':
    case 'monad':
      return EVM_ADDRESS.test(account)
  }
}

/** A venue that only swaps or sends keeps nothing, so one with no reader is left out, not called unread. */
const HOLDS_MONEY: ReadonlySet<ChainActionKind> = new Set([
  'supply',
  'stake',
  'withdraw',
  'unstake',
  'borrow',
  'repay',
  'stream',
  'claim',
  'cancel',
])

/** What the account holds at each venue on this chain, read when asked and never kept. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ chain: string }> }
): Promise<NextResponse> {
  const limited = await enforceRateLimit(request, 'read')
  if (limited !== undefined) return limited

  const chainApi = chainModule((await params).chain)
  if (chainApi === undefined) return NextResponse.json({ error: 'unknown_chain' }, { status: 404 })

  const account = new URL(request.url).searchParams.get('account') ?? ''
  if (!isAccountOn(chainApi.chain, account)) {
    return NextResponse.json({ error: 'invalid_account' }, { status: 400 })
  }

  const asked = chainApi.venues.filter(
    (venue) => venue.positions !== undefined || venue.kinds.some((kind) => HOLDS_MONEY.has(kind))
  )
  const readings = await Promise.all(asked.map((venue) => readPositionsBriefly(venue, account)))

  const venues: VenueHoldings[] = []
  const unread: PositionsReport['unread'] = []
  asked.forEach(({ id, name, kinds }, i) => {
    const positions = readings[i]
    // A figure that isn't a number says nothing about what is there, so it isn't read as nothing.
    if (positions === undefined || positions.some((p) => Number.isNaN(Number(p.amount)))) {
      unread.push({ id, name })
      return
    }
    venues.push({ id, name, kinds, positions: positions.filter((p) => Number(p.amount) > 0) })
  })

  const report: PositionsReport = { venues, unread }
  return NextResponse.json(report, { headers: { 'cache-control': 'no-store' } })
}
