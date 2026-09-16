import { describe, expect, it } from 'vitest'

import { USDC, XLM } from '../swap/assets'
import { createHorizonQuoter } from '../swap/sources/horizon-quoter'
import { createSoroswapQuoter } from '../swap/sources/soroswap-quoter'
import { buildSorobanSwap, prepareSorobanSwap } from '../swap/build-soroban'
import { buildSwapTransaction } from '../swap/build-tx'
import { applySlippage } from '../swap/assets'
import { builderFor } from '../swap/venue-routing'

/**
 * Both venues, quoted live and built for signature.
 *
 * The unit tests prove each builder does what it claims in isolation. This
 * proves the two halves meet: a quote taken from a real venue reaches the
 * right builder and produces something the network accepts.
 *
 * Worth having because the failure it guards against is silent. The build
 * endpoint hardcoded Horizon, so a Soroswap route was quoted, compared,
 * displayed, and then either rebuilt as a completely different trade or
 * rejected — with nothing in the types to notice.
 */

const live = process.env['SKIP_LIVE'] === '1' ? describe.skip : describe

const FUNDED = 'GCYQ3NXJHGD7P36OVKII6GKVLAENQ6ZETYOBAPZTI4R6ZWUU6QLHVVUX'
const SEND = '100000000' // 10 USDC

live('a live quote reaches the builder its venue requires', () => {
  it('routes a Horizon quote to the classic builder and signs', async () => {
    const quoted = await createHorizonQuoter().quote({
      kind: 'strict_send',
      from: USDC,
      to: XLM,
      sendAmount: SEND,
    })
    if (!quoted.ok) throw new Error(`Horizon did not quote: ${quoted.failure.reason}`)

    expect(builderFor(quoted.quote)).toBe('classic')

    const built = await buildSwapTransaction({ account: FUNDED, quote: quoted.quote })
    expect(built.xdr).toMatch(/^[A-Za-z0-9+/=]+$/)
    // The floor is below the quote, never above it: rounding the other way
    // would fail transactions that should have succeeded.
    expect(BigInt(built.destMin)).toBeLessThanOrEqual(BigInt(quoted.quote.destAmount))
  }, 30_000)

  it('routes a Soroswap quote to the Soroban builder and simulates', async () => {
    const quoted = await createSoroswapQuoter().quote({
      kind: 'strict_send',
      from: USDC,
      to: XLM,
      sendAmount: SEND,
    })
    if (!quoted.ok) throw new Error(`Soroswap did not quote: ${quoted.failure.reason}`)

    // Marked executable only because the route settles in the asset it names.
    // If this ever becomes defined again, the quoter has drifted back to a
    // contract that merely shares a ticker.
    expect(quoted.quote.deliversAsset).toBeUndefined()
    expect(builderFor(quoted.quote)).toBe('soroban')

    const built = await buildSorobanSwap({
      account: FUNDED,
      from: quoted.quote.from,
      to: quoted.quote.to,
      sendAmount: quoted.quote.sendAmount,
      minReceive: applySlippage(quoted.quote.destAmount, 50),
    })
    const prepared = await prepareSorobanSwap(built.xdr)
    expect(prepared.ok, prepared.ok ? '' : `router rejected: ${prepared.reason}`).toBe(true)
  }, 40_000)
})

live('the venues genuinely differ', () => {
  it('quotes the same trade at materially different prices', async () => {
    // Not a correctness property, but the reason the whole phase exists: if
    // these ever converge, executing Soroswap stops being worth its builder.
    const [h, s] = await Promise.all([
      createHorizonQuoter().quote({ kind: 'strict_send', from: USDC, to: XLM, sendAmount: SEND }),
      createSoroswapQuoter().quote({ kind: 'strict_send', from: USDC, to: XLM, sendAmount: SEND }),
    ])
    if (!h.ok || !s.ok) throw new Error('both venues must quote for this comparison')

    expect(BigInt(h.quote.destAmount)).toBeGreaterThan(BigInt(0))
    expect(BigInt(s.quote.destAmount)).toBeGreaterThan(BigInt(0))
    // Both are real, and an agent choosing between them is making a real
    // decision rather than picking between two names for one price.
    expect(h.quote.destAmount).not.toBe(s.quote.destAmount)
  }, 40_000)
})
