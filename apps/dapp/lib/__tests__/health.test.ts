import { describe, expect, it } from 'vitest'

import {
  LIQUIDATION_HF,
  liquidationPrice,
  maxBorrow,
  positionHealth,
  type HealthLeg,
} from '../lend/health'

/**
 * How close a position is to being seized.
 *
 * These are the numbers a user decides on. A health factor that disagrees with
 * the pool is worse than showing nothing at all: it tells somebody they are
 * safe at a price where their collateral is already being auctioned. So the
 * cases below are worked by hand from the contract's own formulas rather than
 * from this implementation's output — a test written by running the code and
 * pasting the result would pass against any arithmetic, including wrong
 * arithmetic.
 *
 * The figures come from the live testnet pool: XLM at $0.42 with c_factor
 * 0.90, wBTC at $100,000 with l_factor 0.90.
 */

const SCALAR_7 = BigInt(10_000_000)

/** Asset units to base units. */
function units(n: number): bigint {
  return BigInt(Math.round(n * 10_000_000))
}

const XLM_PRICE = units(0.42)
const WBTC_PRICE = units(100_000)
const FACTOR_90 = units(0.9)

function xlmCollateral(amount: number): HealthLeg {
  return { symbol: 'XLM', amount: units(amount), price: XLM_PRICE, factor: FACTOR_90 }
}

function wbtcDebt(amount: number): HealthLeg {
  return { symbol: 'wBTC', amount: units(amount), price: WBTC_PRICE, factor: FACTOR_90 }
}

describe('a position with nothing borrowed', () => {
  it('has no health factor at all', () => {
    // Not infinity, and not a very large number. The pool's `is_hf_under`
    // returns false outright when there are no liabilities, which is the
    // mechanism behind "a supply-only position cannot be liquidated" — so the
    // absence is the meaningful answer and a caller must handle it.
    const health = positionHealth([xlmCollateral(5000)], [])

    expect(health.healthFactor).toBeUndefined()
    expect(health.liquidatable).toBe(false)
  })

  it('cannot be liquidated however little collateral it holds', () => {
    const health = positionHealth([xlmCollateral(0.0000001)], [])
    expect(health.liquidatable).toBe(false)
  })

  it('has no liquidation price', () => {
    expect(liquidationPrice([xlmCollateral(5000)], [])).toBeUndefined()
  })
})

describe('health factor, against hand-worked figures', () => {
  it('values collateral after its factor', () => {
    // 500 XLM x $0.42 = $210.00, x 0.90 = $189.00
    const health = positionHealth([xlmCollateral(500)], [])
    expect(health.collateralBase).toBeCloseTo(189, 6)
  })

  it('values a liability by dividing by its factor', () => {
    // 0.001 wBTC x $100,000 = $100.00, / 0.90 = $111.11...
    // Dividing rather than multiplying is the point: a liability is worth
    // *more* against the position than its face value, where collateral is
    // worth less.
    const health = positionHealth([], [wbtcDebt(0.001)])
    expect(health.liabilityBase).toBeCloseTo(111.1111111, 6)
  })

  it('divides the one by the other', () => {
    // $189.00 / $111.111... = 1.701
    const health = positionHealth([xlmCollateral(500)], [wbtcDebt(0.001)])
    expect(health.healthFactor).toBeCloseTo(1.701, 3)
    expect(health.liquidatable).toBe(false)
  })

  it('sums several assets on each side', () => {
    const health = positionHealth([xlmCollateral(500), xlmCollateral(500)], [wbtcDebt(0.001)])
    expect(health.collateralBase).toBeCloseTo(378, 6)
  })

  it('marks a position below one as liquidatable', () => {
    // 500 XLM of collateral against 0.002 wBTC: $189.00 / $222.22 = 0.85
    const health = positionHealth([xlmCollateral(500)], [wbtcDebt(0.002)])

    expect(health.healthFactor).toBeLessThan(LIQUIDATION_HF)
    expect(health.liquidatable).toBe(true)
  })

  it('treats exactly one as not yet liquidatable', () => {
    // The pool liquidates *below* one, not at it.
    const health = positionHealth(
      [{ symbol: 'USDC', amount: units(100), price: units(1), factor: SCALAR_7 }],
      [{ symbol: 'USDC', amount: units(100), price: units(1), factor: SCALAR_7 }]
    )

    expect(health.healthFactor).toBe(1)
    expect(health.liquidatable).toBe(false)
  })
})

describe('the rounding leans the same way the pool does', () => {
  it('rounds a liability up rather than to nearest', () => {
    // The contract uses fixed_div_ceil on liabilities. A value that divides
    // inexactly must land above the true quotient, never below — reporting a
    // debt as smaller than the pool does would overstate health.
    const odd: HealthLeg = { symbol: 'X', amount: BigInt(3), price: BigInt(1), factor: BigInt(3) }
    const health = positionHealth([], [odd])

    expect(health.liabilityBase).toBeGreaterThan(0)
  })

  it('rounds collateral down rather than to nearest', () => {
    // fixed_mul_floor. Truncation here understates collateral, which is the
    // conservative direction.
    const odd: HealthLeg = {
      symbol: 'X',
      amount: BigInt(1),
      price: BigInt(1),
      factor: SCALAR_7 - BigInt(1),
    }
    const health = positionHealth([odd], [])

    expect(health.collateralBase).toBe(0)
  })

  it('never reports a position as healthier than symmetric rounding would', () => {
    // The property that matters, stated directly. Both roundings push the
    // health factor down, so this implementation can only ever be more
    // cautious than a naive one — never less.
    const collateral = [xlmCollateral(1234.5678901)]
    const liabilities = [wbtcDebt(0.0012345)]

    const health = positionHealth(collateral, liabilities)

    const naive = (1234.5678901 * 0.42 * 0.9) / ((0.0012345 * 100_000) / 0.9)

    expect(health.healthFactor).toBeLessThanOrEqual(naive + 1e-9)
  })
})

describe('the price at which collateral is seized', () => {
  it('is where collateral value meets liability value', () => {
    // 0.001 wBTC = $111.111 effective. 500 XLM x 0.90 = 450 effective units.
    // $111.111 / 450 = $0.2469
    const price = liquidationPrice([xlmCollateral(500)], [wbtcDebt(0.001)])
    expect(price).toBeCloseTo(0.2469, 4)
  })

  it('sits below the current price for a healthy position', () => {
    const price = liquidationPrice([xlmCollateral(500)], [wbtcDebt(0.001)])
    expect(price).toBeLessThan(0.42)
  })

  it('sits above the current price for an underwater one', () => {
    const price = liquidationPrice([xlmCollateral(500)], [wbtcDebt(0.002)])
    expect(price as number).toBeGreaterThan(0.42)
  })

  it('declines to answer when several assets are collateral', () => {
    // One price moving does not decide the outcome, so quoting a figure for
    // one asset would imply the others are pinned. Undefined is the honest
    // answer rather than a number with a hidden assumption.
    const price = liquidationPrice(
      [
        xlmCollateral(500),
        { symbol: 'USDC', amount: units(100), price: units(1), factor: FACTOR_90 },
      ],
      [wbtcDebt(0.001)]
    )

    expect(price).toBeUndefined()
  })

  it('declines when there is no collateral at all', () => {
    expect(liquidationPrice([], [wbtcDebt(0.001)])).toBeUndefined()
  })
})

describe('how much can be borrowed', () => {
  it('leaves a margin above the liquidation threshold', () => {
    // $189 of collateral at the default 1.25 minimum: $151.20 of borrowing
    // budget, x 0.90 l_factor = $136.08, / $100,000 = 0.00136 wBTC.
    const most = maxBorrow([xlmCollateral(500)], WBTC_PRICE, FACTOR_90)
    expect(most).toBeCloseTo(0.0013608, 6)
  })

  it('borrowing that much lands at the minimum health factor', () => {
    // The two functions have to agree, or the UI offers a maximum the builder
    // then refuses.
    const most = maxBorrow([xlmCollateral(500)], WBTC_PRICE, FACTOR_90)
    const health = positionHealth([xlmCollateral(500)], [wbtcDebt(most)])

    expect(health.healthFactor).toBeCloseTo(1.25, 2)
  })

  it('is zero without collateral', () => {
    expect(maxBorrow([], WBTC_PRICE, FACTOR_90)).toBe(0)
  })

  it('is zero when the asset has no price', () => {
    // A missing oracle price must not divide by zero into an infinite
    // borrowing limit.
    expect(maxBorrow([xlmCollateral(500)], BigInt(0), FACTOR_90)).toBe(0)
  })

  it('allows more at a lower safety margin', () => {
    const cautious = maxBorrow([xlmCollateral(500)], WBTC_PRICE, FACTOR_90, 2)
    const permissive = maxBorrow([xlmCollateral(500)], WBTC_PRICE, FACTOR_90, 1.1)

    expect(permissive).toBeGreaterThan(cautious)
  })
})
