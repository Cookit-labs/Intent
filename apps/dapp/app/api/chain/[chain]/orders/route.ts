import { NextResponse } from 'next/server'
import { z } from 'zod'

import { chainModule } from '../../../../../lib/chains/registry'
import { BALANCE_DEADLINE_MS, ChainActionRefused } from '../../../../../lib/chains/types'
import { enforceRateLimit } from '../../../../../lib/server/rate-limit'
import { reportError } from '../../../../../lib/server/report'
import { isWalletAddress } from '../../../../../lib/wallet/address'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 20

const Body = z.object({
  account: z.string().min(1).max(128),
  orderId: z.string().min(1).max(200),
  action: z.enum(['cancel', 'collect']),
})

/** The account's resting limit orders on this chain, read when asked and never kept. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ chain: string }> }
): Promise<NextResponse> {
  const limited = await enforceRateLimit(request, 'read')
  if (limited !== undefined) return limited

  const chainApi = chainModule((await params).chain)
  if (chainApi === undefined) return NextResponse.json({ error: 'unknown_chain' }, { status: 404 })

  const account = new URL(request.url).searchParams.get('account') ?? ''
  if (!isWalletAddress(account)) {
    return NextResponse.json({ error: 'invalid_account' }, { status: 400 })
  }
  if (chainApi.limitBook === undefined) {
    return NextResponse.json({ orders: [] }, { headers: { 'cache-control': 'no-store' } })
  }
  try {
    const orders = await chainApi.limitBook.openOrders(
      account,
      AbortSignal.timeout(BALANCE_DEADLINE_MS)
    )
    return NextResponse.json({ orders }, { headers: { 'cache-control': 'no-store' } })
  } catch (e) {
    if (e instanceof ChainActionRefused) {
      return NextResponse.json({ error: 'invalid_account' }, { status: 400 })
    }
    reportError('chain/orders', e, { chain: chainApi.chain })
    return NextResponse.json({ error: 'orders_unavailable' }, { status: 503 })
  }
}

/** Builds the cancel or the collect of a resting order for the wallet to sign. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ chain: string }> }
): Promise<NextResponse> {
  const limited = await enforceRateLimit(request, 'build')
  if (limited !== undefined) return limited

  const chainApi = chainModule((await params).chain)
  if (chainApi === undefined) return NextResponse.json({ error: 'unknown_chain' }, { status: 404 })

  const parsed = Body.safeParse(await request.json().catch(() => undefined))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  if (!isWalletAddress(parsed.data.account)) {
    return NextResponse.json({ error: 'invalid_account' }, { status: 400 })
  }

  if (chainApi.limitBook === undefined) {
    return NextResponse.json(
      { error: 'There are no limit orders to change on this chain. Nothing was signed or sent.' },
      { status: 422 }
    )
  }
  try {
    const { account, orderId, action } = parsed.data
    const prepared = await chainApi.limitBook.prepareExit(account, orderId, action)
    return NextResponse.json({ prepared })
  } catch (e) {
    if (e instanceof ChainActionRefused) {
      return NextResponse.json({ error: e.message }, { status: 422 })
    }
    reportError('chain/orders', e, { chain: chainApi.chain })
    return NextResponse.json(
      { error: 'This could not be built right now. Nothing was signed or sent.' },
      { status: 502 }
    )
  }
}
