import { describe, expect, it } from 'vitest'

import {
  borrowRateOf,
  supplyRateOf,
  utilisationOf,
  type ReserveConfig,
  type ReserveData,
} from '../lend/reserves'

/**
 * The rate maths, pinned to figures read off the live pool.
 *
 * Worth testing precisely because every wrong answer here still *looks* like a
 * rate. There is no crash to catch the mistake and no obviously silly number to
 * notice — just a plausible percentage in front of somebody deciding whether to
 * lend. Two of the scales below were originally wrong in exactly that way.
 */

/** Read from `get_reserve` on the testnet pool for the XLM reserve. */
const LIVE_CONFIG: ReserveConfig = {
  index: 0,
  decimals: 7,
  enabled: true,
  util: 0.5,
  maxUtil: 0.95,
  // Both 0.90 for XLM on the live pool. They matter to the health factor
  // rather than to the rate maths this file tests, but the shape has to be
  // complete for the fixture to stand in for a real reserve.
  cFactor: 0.9,
  lFactor: 0.9,
  rBase: BigInt(5000),
  rOne: BigInt(300000),
  rTwo: BigInt(2000000),
  rThree: BigInt(10000000),
  supplyCap: BigInt(170141183460469231731687303715884105727),
}

const LIVE_DATA: ReserveData = {
  bRate: BigInt(2011211621886),
  dRate: BigInt(2580608571322),
  bSupply: BigInt(525242833256272),
  dSupply: BigInt(368402964569849),
  backstopCredit: BigInt(3080721336935),
  irMod: BigInt(100000000),
  lastTime: BigInt(1789319532),
}

/** The pool's own `bstop_rate`, read from its config: 10%. */
const TAKE_RATE = BigInt(1000000)

describe('utilisation matches what the contract computes', () => {
  it('reads the rate accumulators at twelve decimals', () => {
    // The scale that matters most. At the v1 scale of nine decimals this is out
    // by a thousand and still returns something shaped like a fraction.
    expect(utilisationOf(LIVE_DATA)).toBe(BigInt(8999686))
  })

  it('does not subtract the backstop credit', () => {
    // `b_rate` is already net of it. Subtracting again would report 90.26%
    // where the contract reports 90.00% — close enough to look right.
    const inflated = utilisationOf({
      ...LIVE_DATA,
      bSupply: LIVE_DATA.bSupply - LIVE_DATA.backstopCredit,
    })
    expect(inflated).not.toBe(BigInt(8999686))
  })

  it('reports nothing borrowed against an empty reserve', () => {
    expect(utilisationOf({ ...LIVE_DATA, bSupply: BigInt(0), dSupply: BigInt(0) })).toBe(BigInt(0))
  })

  it('never exceeds one', () => {
    const overdrawn = utilisationOf({ ...LIVE_DATA, dSupply: LIVE_DATA.bSupply * BigInt(10) })
    expect(overdrawn).toBe(BigInt(10000000))
  })
})

describe('the borrow curve', () => {
  it('reads the rate modifier at seven decimals', () => {
    // The error this test exists for. Read at nine decimals the modifier
    // becomes 0.1 rather than 10.0, and the supply APY lands on a comfortable
    // 1.70% instead of the real figure — off by exactly 100x, and believable.
    const util = utilisationOf(LIVE_DATA)
    expect(borrowRateOf(LIVE_CONFIG, LIVE_DATA, util)).toBe(BigInt(20826390))
  })

  it('takes the middle segment at this utilisation', () => {
    // 90% sits between the 50% target and the 95% kink.
    const util = utilisationOf(LIVE_DATA)
    expect(util).toBeGreaterThan(BigInt(5000000))
    expect(util).toBeLessThan(BigInt(9500000))
  })

  it('charges only the base rate at zero utilisation', () => {
    // Nothing borrowed, so the curve contributes nothing above `r_base`,
    // scaled by an unmodified modifier.
    const quiet: ReserveData = { ...LIVE_DATA, irMod: BigInt(10000000) }
    expect(borrowRateOf(LIVE_CONFIG, quiet, BigInt(0))).toBe(LIVE_CONFIG.rBase)
  })

  it('climbs steeply past the high kink', () => {
    const quiet: ReserveData = { ...LIVE_DATA, irMod: BigInt(10000000) }
    const below = borrowRateOf(LIVE_CONFIG, quiet, BigInt(9400000))
    const above = borrowRateOf(LIVE_CONFIG, quiet, BigInt(9900000))
    // The third segment exists to make borrowing painful exactly where the
    // pool most needs repaying, so this gap should be large rather than smooth.
    expect(above).toBeGreaterThan(below * BigInt(3))
  })

  it('stops applying the modifier to the steepest segment', () => {
    // Above 95% the modifier scales only the base segments. A modifier applied
    // to the whole thing would make the two differ by the modifier itself.
    const maxed: ReserveData = { ...LIVE_DATA, irMod: BigInt(100000000) }
    const unmodified: ReserveData = { ...LIVE_DATA, irMod: BigInt(10000000) }
    const withMod = borrowRateOf(LIVE_CONFIG, maxed, BigInt(9900000))
    const without = borrowRateOf(LIVE_CONFIG, unmodified, BigInt(9900000))
    expect(withMod).toBeLessThan(without * BigInt(10))
  })
})

describe('the supply rate is a share of what borrowers pay', () => {
  it('scales borrower interest by utilisation and the backstop take', () => {
    const util = utilisationOf(LIVE_DATA)
    const borrow = borrowRateOf(LIVE_CONFIG, LIVE_DATA, util)
    // Two sequential floors, matching `setRates` in the Blend SDK. The order
    // matters: the capture is truncated to seven decimals before it multiplies
    // the borrow rate, so a fused single-rounding version lands a unit higher.
    expect(supplyRateOf(borrow, util, TAKE_RATE)).toBe(BigInt(16868786))
  })

  it('pays suppliers nothing when nothing is borrowed', () => {
    // Idle capital earns nothing: there is no borrower paying for it.
    expect(supplyRateOf(BigInt(20826390), BigInt(0), TAKE_RATE)).toBe(BigInt(0))
  })

  it('pays less as the backstop takes more', () => {
    const util = utilisationOf(LIVE_DATA)
    const borrow = borrowRateOf(LIVE_CONFIG, LIVE_DATA, util)
    const greedy = supplyRateOf(borrow, util, BigInt(5000000))
    expect(greedy).toBeLessThan(supplyRateOf(borrow, util, TAKE_RATE))
  })

  it('never pays suppliers more than borrowers pay', () => {
    // A supply rate above the borrow rate would mean the pool inventing money.
    const util = utilisationOf(LIVE_DATA)
    const borrow = borrowRateOf(LIVE_CONFIG, LIVE_DATA, util)
    expect(supplyRateOf(borrow, util, TAKE_RATE)).toBeLessThan(borrow)
  })
})
