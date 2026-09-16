import { describe, expect, it } from 'vitest'

import { parseIntent } from '../parse-intent'

/**
 * A limit price the user did not state is not a limit price.
 *
 * `targetPriceUsd` falls back to the reference spot price when the text names
 * no figure, and that fallback is non-zero — so `targetPriceUsd > 0` was true
 * for every intent, priced or not. Harmless while nothing acted on it: the
 * value only reached the agent prompt as a hint.
 *
 * It stops being harmless once a limit order rests on the orderbook. An offer
 * placed at the current spot price crosses the spread and fills at once, which
 * is a market order wearing a limit order's label — exactly the behaviour a
 * limit order exists to avoid.
 *
 * So a stated price gets its own field. `targetPriceUsd` keeps its fallback for
 * the prompt callers that rely on it.
 */
describe('a stated limit price is distinguishable from no price', () => {
  it('reads a price the user actually named', () => {
    const parsed = parseIntent('Buy $200 of XLM below $0.19')
    expect(parsed.limitPriceUsd).toBe(0.19)
  })

  it('leaves the price undefined when the text names none', () => {
    // Classified as a limit type by the word "limit", but with no figure to
    // rest at. This is the case that would have placed an offer at spot.
    const parsed = parseIntent('Limit buy XLM')
    expect(parsed.limitPriceUsd).toBeUndefined()
  })

  it('does not treat a market order as priced', () => {
    const parsed = parseIntent('Swap 50 USDC to XLM')
    expect(parsed.limitPriceUsd).toBeUndefined()
  })

  it('keeps the budget out of the limit price', () => {
    // "$200" is what is being spent. The cap is the second figure, and reading
    // the first one made a $200-per-XLM limit out of a $200 budget.
    const parsed = parseIntent('Accumulate $200 of XLM under $0.25')
    expect(parsed.limitPriceUsd).toBe(0.25)
  })

  it('reads a sell limit', () => {
    const parsed = parseIntent('Sell 1000 XLM above $0.42')
    expect(parsed.limitPriceUsd).toBe(0.42)
  })

  it('scales a suffixed price', () => {
    const parsed = parseIntent('Buy WBTC below $30k')
    expect(parsed.limitPriceUsd).toBe(30_000)
  })

  it('still falls back for the agent prompt', () => {
    // `targetPriceUsd` is a reasoning hint and keeps its old behaviour: agents
    // are given a scale to argue about even when the user named no target.
    const parsed = parseIntent('Limit buy XLM')
    expect(parsed.targetPriceUsd).toBeGreaterThan(0)
    expect(parsed.targetPriceUsd).toBe(parsed.referencePriceUsd)
  })

  it('agrees with the stated price when there is one', () => {
    const parsed = parseIntent('Buy $200 of XLM below $0.19')
    expect(parsed.targetPriceUsd).toBe(parsed.limitPriceUsd)
  })
})
