import { NextResponse } from 'next/server'

import { buildPlan, type PlanAction } from '../../../../lib/swap/build-plan'
import { DEFAULT_SLIPPAGE_BPS } from '../../../../lib/swap/build-tx'
import { applySlippage } from '../../../../lib/swap/assets'
import { collectQuotes } from '../../../../lib/swap/quote'
import { createHorizonQuoter } from '../../../../lib/swap/sources/horizon-quoter'
import { createSoroswapQuoter } from '../../../../lib/swap/sources/soroswap-quoter'

/**
 * Builds a multi-step plan for signature.
 *
 * Server-side for the same reason every other builder is: the transaction is
 * assembled where the app controls it, and the browser only ever sees an
 * envelope it can sign or refuse.
 *
 * The returned description matters as much as the XDR. A plan the user cannot
 * read is a plan they cannot refuse, and "3 steps" without saying which three
 * would make multi-step less safe than single operations rather than more.
 *
 * A swap step sent with `minReceive: '0'` is priced here rather than by the
 * client. The browser cannot compute an honest floor — it would have to trust a
 * quote taken before the trade runs — so it asks for one, and this re-quotes
 * against live liquidity and applies slippage exactly as the swap route does.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface PlanBody {
  account?: string
  actions?: PlanAction[]
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: PlanBody
  try {
    body = (await request.json()) as PlanBody
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }

  if (typeof body.account !== 'string' || body.account === '') {
    return NextResponse.json({ error: 'account_required' }, { status: 400 })
  }
  if (!Array.isArray(body.actions) || body.actions.length === 0) {
    return NextResponse.json({ error: 'actions_required' }, { status: 400 })
  }

  let actions: PlanAction[]
  try {
    actions = await priceSwapFloors(body.actions)
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'could not price this plan' },
      { status: 400 }
    )
  }

  try {
    const built = await buildPlan({ account: body.account, actions })
    return NextResponse.json({
      xdr: built.xdr,
      steps: built.steps,
      description: built.description,
    })
  } catch (e) {
    // Every refusal here is a safety property rather than an ordinary failure
    // — an unverified asset, a step the app does not build, a delivery to
    // somebody else — so the reason surfaces instead of being flattened.
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'could not build the plan' },
      { status: 400 }
    )
  }
}

/**
 * Fills in a real slippage floor for any swap step that asked for one.
 *
 * `minReceive: '0'` is the request, not a floor of nothing: a client that
 * cannot honestly price a trade says so rather than asserting a nominal 1,
 * which would be a swap with no protection at all. Anything else is left
 * untouched, so a caller that has already priced its own step keeps control.
 */
async function priceSwapFloors(actions: PlanAction[]): Promise<PlanAction[]> {
  return Promise.all(
    actions.map(async (action) => {
      if (action.kind !== 'swap' || action.minReceive !== '0') return action

      const { quotes } = await collectQuotes([createSoroswapQuoter(), createHorizonQuoter()], {
        kind: 'strict_send',
        from: action.from,
        to: action.to,
        sendAmount: action.sendAmount,
      })

      // The best price across sources, so the floor reflects the route the
      // trade can actually take rather than whichever quoter answered first.
      const best = quotes.reduce<(typeof quotes)[number] | undefined>(
        (bestSoFar, q) =>
          bestSoFar === undefined || BigInt(q.destAmount) > BigInt(bestSoFar.destAmount)
            ? q
            : bestSoFar,
        undefined
      )

      if (best === undefined) {
        throw new Error('no route could price this swap, so no floor can be set for it')
      }

      return { ...action, minReceive: applySlippage(best.destAmount, DEFAULT_SLIPPAGE_BPS) }
    })
  )
}
