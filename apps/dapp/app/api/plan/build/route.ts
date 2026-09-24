import { NextResponse } from 'next/server'

import { buildPlan, type PlanAction } from '../../../../lib/swap/build-plan'
import { feePaidBy } from '../../../../lib/sponsor/sponsor'
import { derivePreview } from '../../../../lib/swap/preview'
import { DEFAULT_SLIPPAGE_BPS } from '../../../../lib/swap/build-tx'
import { applySlippage } from '../../../../lib/swap/assets'
import { collectQuotes } from '../../../../lib/swap/quote'
import { createHorizonQuoter } from '../../../../lib/swap/sources/horizon-quoter'
import { assertPlanWithinCap } from '../../../../lib/server/trade-cap'

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
    // Step by step against the mainnet cap, once the plan has been built, so
    // a step whose venue is not on this network is refused by name first.
    await assertPlanWithinCap(actions)
    return NextResponse.json({
      xdr: built.xdr,
      steps: built.steps,
      description: built.description,
      // The description says what each step intends; this says what the
      // operations, as built, will do to the account that signs them.
      preview: {
        ...derivePreview(built.xdr, body.account, built.networkPassphrase),
        feePaidBy: feePaidBy(),
      },
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

      // **Quoted against Horizon only, deliberately.** A plan step becomes a
      // classic path payment, and only Horizon prices that path. Soroswap
      // quotes a Soroban router call, which is a different operation this
      // builder cannot produce.
      //
      // Pricing against the best source across both was a real bug: on
      // USDC to XLM, Soroswap quotes roughly 3.7x what the classic path can
      // deliver, so the floor came from a venue the transaction never used and
      // the swap failed on-chain with `op_under_dest_min`. A floor must come
      // from the route that will actually execute.
      const { quotes, failures } = await collectQuotes([createHorizonQuoter()], {
        kind: 'strict_send',
        from: action.from,
        to: action.to,
        sendAmount: action.sendAmount,
      })

      const best = quotes[0]
      if (best === undefined) {
        const why = failures[0]?.reason
        throw new Error(
          `no classic path could price this swap${why !== undefined ? `: ${why}` : ''}, ` +
            'so no floor can be set for it'
        )
      }

      return { ...action, minReceive: applySlippage(best.destAmount, DEFAULT_SLIPPAGE_BPS) }
    })
  )
}
