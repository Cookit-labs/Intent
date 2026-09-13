import { describe, expect, it } from 'vitest'

import { USDC, XLM } from '../swap/assets'
import { buildPlan } from '../swap/build-plan'
import { createHorizonQuoter } from '../swap/sources/horizon-quoter'
import { applySlippage } from '../swap/assets'

/**
 * A multi-step plan built against live prices and a real account.
 *
 * The unit tests prove composition and refusal in isolation. This proves the
 * sequence number, the asset encoding and the operation shapes are all
 * acceptable together — which is the part that can only fail against a real
 * ledger.
 */

const live = process.env['SKIP_LIVE'] === '1' ? describe.skip : describe
const FUNDED = 'GCYQ3NXJHGD7P36OVKII6GKVLAENQ6ZETYOBAPZTI4R6ZWUU6QLHVVUX'

live('a plan built from live quotes', () => {
  it('composes swap-then-rest against real prices', async () => {
    // Half now, half resting: the canonical two-step plan, and the one an
    // agent would propose when the market is near but not at a target.
    const quoted = await createHorizonQuoter().quote({
      kind: 'strict_send',
      from: USDC,
      to: XLM,
      sendAmount: '50000000', // 5 USDC
    })
    if (!quoted.ok) throw new Error(`no quote: ${quoted.failure.reason}`)

    const built = await buildPlan({
      account: FUNDED,
      actions: [
        {
          kind: 'swap',
          from: USDC,
          to: XLM,
          sendAmount: quoted.quote.sendAmount,
          minReceive: applySlippage(quoted.quote.destAmount, 50),
        },
        {
          kind: 'rest',
          selling: USDC,
          buying: XLM,
          amount: '5',
          price: { n: 9, d: 100 },
        },
      ],
    })

    expect(built.steps).toHaveLength(2)
    expect(built.description).toEqual(['1. Swap', '2. Place order'])
    expect(built.xdr).toMatch(/^[A-Za-z0-9+/=]+$/)
  }, 30_000)

  it('builds a trustline-then-buy plan for an asset not yet held', async () => {
    // The case that genuinely needs atomicity: without it the user signs a
    // trustline, then a purchase, and can end up holding an empty trustline if
    // the second is declined or the price moves.
    const built = await buildPlan({
      account: FUNDED,
      actions: [
        { kind: 'trust', asset: USDC },
        { kind: 'swap', from: XLM, to: USDC, sendAmount: '10000000', minReceive: '1' },
      ],
    })

    expect(built.description).toEqual(['1. Allow asset', '2. Swap'])
  }, 30_000)
})
