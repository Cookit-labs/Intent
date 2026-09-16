/**
 * How close a borrowing position is to liquidation.
 *
 * Every formula here is transcribed from `pool/src/pool/health_factor.rs` and
 * `pool/src/pool/reserve.rs` in `blend-contracts-v2`, not derived. A health
 * factor this app computes differently from the pool is worse than none: it
 * would tell someone they are safe at a price where the pool is already
 * seizing their collateral.
 *
 * **The rounding is asymmetric on purpose and must stay that way.** Collateral
 * is multiplied by `c_factor` and rounded *down*; liabilities are divided by
 * `l_factor` and rounded *up*. Both lean the same way — toward reporting a
 * position as less healthy than a naive reading would. Using symmetric
 * rounding would produce numbers that look right, agree with the pool most of
 * the time, and overstate safety exactly at the boundary where it matters.
 *
 * A position with no liabilities has no health factor at all, rather than an
 * infinite one. That is not a special case bolted on: the pool's `is_hf_under`
 * returns false outright when `liability_base == 0`, which is the mechanism
 * behind the guarantee that a supply-only position cannot be liquidated.
 */

/** Oracle prices and the factors are seven-decimal fixed point. */
const SCALAR_7 = BigInt(10_000_000)

/**
 * Liquidation becomes possible below this.
 *
 * One, exactly — `is_hf_under(SCALAR_7)`. Not a safety margin this app chose.
 */
export const LIQUIDATION_HF = 1

/**
 * Refuse to build a borrow that lands below this.
 *
 * A margin this app imposes, not the pool. Borrowing to the very edge of
 * solvency means the next ledger's interest can open a liquidation, so a
 * position that is legal to create is not necessarily one worth creating.
 */
export const MINIMUM_SAFE_HF = 1.25

/** One asset's contribution to a position. */
export interface HealthLeg {
  symbol: string
  /** Base units held, as supplied by the position reader. */
  amount: bigint
  /** Oracle price in USD, seven-decimal fixed point. */
  price: bigint
  /** `c_factor` for collateral, `l_factor` for a liability. Seven decimals. */
  factor: bigint
}

export interface PositionHealth {
  /** Collateral after `c_factor`, in USD. */
  collateralBase: number
  /** Liabilities after `l_factor`, in USD. */
  liabilityBase: number
  /**
   * Collateral over liabilities, or undefined when nothing is borrowed.
   *
   * Undefined rather than Infinity, so a caller has to decide what to render
   * for a position that cannot be liquidated rather than printing a symbol.
   */
  healthFactor: number | undefined
  /** True when the pool could open a liquidation auction right now. */
  liquidatable: boolean
}

/** Ceiling division, matching the contract's `fixed_div_ceil`. */
function divCeil(a: bigint, b: bigint): bigint {
  if (b === BigInt(0)) return BigInt(0)
  return (a + b - BigInt(1)) / b
}

/**
 * The USD value of collateral, after its factor and rounded down.
 *
 * `price × amount ÷ scalar × c_factor ÷ scalar`, in the contract's order so the
 * intermediate truncations land where the pool's do.
 */
function effectiveCollateral(leg: HealthLeg): bigint {
  const base = (leg.price * leg.amount) / SCALAR_7
  return (base * leg.factor) / SCALAR_7
}

/** The USD value of a liability, after its factor and rounded up. */
function effectiveLiability(leg: HealthLeg): bigint {
  const base = divCeil(leg.price * leg.amount, SCALAR_7)
  return divCeil(base * SCALAR_7, leg.factor)
}

function toUsd(fixed: bigint): number {
  return Number(fixed) / Number(SCALAR_7)
}

/**
 * Where a position stands.
 *
 * Both sides are summed across assets, because a position can hold several of
 * each and the pool judges the whole rather than any one pair.
 */
export function positionHealth(collateral: HealthLeg[], liabilities: HealthLeg[]): PositionHealth {
  const collateralFixed = collateral.reduce(
    (total, leg) => total + effectiveCollateral(leg),
    BigInt(0)
  )
  const liabilityFixed = liabilities.reduce(
    (total, leg) => total + effectiveLiability(leg),
    BigInt(0)
  )

  const collateralBase = toUsd(collateralFixed)
  const liabilityBase = toUsd(liabilityFixed)

  if (liabilityFixed === BigInt(0)) {
    // Nothing borrowed: no health factor exists, and no liquidation is
    // possible however small the collateral.
    return { collateralBase, liabilityBase: 0, healthFactor: undefined, liquidatable: false }
  }

  const healthFactor = collateralBase / liabilityBase

  return {
    collateralBase,
    liabilityBase,
    healthFactor,
    liquidatable: healthFactor < LIQUIDATION_HF,
  }
}

/**
 * The most that can be borrowed of one asset, in its own units.
 *
 * Bounded by collateral alone. The pool has a second, independent limit — a
 * borrow that would push the reserve past `max_util` is refused however well
 * collateralised it is — and that one cannot be computed from a position, so
 * callers must still simulate rather than trusting this figure.
 */
export function maxBorrow(
  collateral: HealthLeg[],
  borrowPrice: bigint,
  borrowFactor: bigint,
  minimumHf: number = MINIMUM_SAFE_HF
): number {
  const collateralFixed = collateral.reduce(
    (total, leg) => total + effectiveCollateral(leg),
    BigInt(0)
  )
  if (collateralFixed === BigInt(0) || borrowPrice === BigInt(0)) return 0

  // Invert the health factor: liability_base = collateral_base / minimumHf,
  // then undo the l_factor division and the price to reach asset units.
  const budgetUsd = toUsd(collateralFixed) / minimumHf
  const factor = Number(borrowFactor) / Number(SCALAR_7)
  const price = Number(borrowPrice) / Number(SCALAR_7)

  return (budgetUsd * factor) / price
}

/**
 * The collateral price at which this position becomes liquidatable.
 *
 * Only meaningful with a single collateral asset — with several, one price
 * moving does not determine the outcome, and quoting a figure for one of them
 * would imply the others are fixed. Undefined in that case rather than
 * misleading.
 *
 * Undefined too when nothing is borrowed, since there is no such price.
 */
export function liquidationPrice(
  collateral: HealthLeg[],
  liabilities: HealthLeg[]
): number | undefined {
  if (collateral.length !== 1 || liabilities.length === 0) return undefined

  const leg = collateral[0]
  if (leg === undefined || leg.amount === BigInt(0)) return undefined

  const liabilityFixed = liabilities.reduce(
    (total, each) => total + effectiveLiability(each),
    BigInt(0)
  )
  if (liabilityFixed === BigInt(0)) return undefined

  // At the liquidation boundary: collateral_base == liability_base, so
  // price × qty × c_factor == liability_base.
  const qty = Number(leg.amount) / Number(SCALAR_7)
  const factor = Number(leg.factor) / Number(SCALAR_7)
  if (qty === 0 || factor === 0) return undefined

  return toUsd(liabilityFixed) / (qty * factor)
}
