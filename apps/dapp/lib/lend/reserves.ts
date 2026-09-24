import { activeNetwork, stellarNetwork } from '@intent/config'
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  rpc,
  scValToNative,
  type xdr,
} from '@stellar/stellar-sdk'

import { BLEND_POOL } from '../swap/contract-registry'

/**
 * Reading Blend's reserves, and turning them into a rate a person can read.
 *
 * Read-only and unsigned: every call is a simulation, so this file is
 * verifiable against testnet without a wallet and without spending anything.
 *
 * **No field returns APY.** The pool exposes rate *state* — two accumulators
 * and the parameters of a kinked curve — and the yield has to be derived. A
 * wrong derivation puts a confident wrong number in front of somebody deciding
 * whether to lend, which is worse than showing nothing.
 *
 * Every constant below was verified against `blend-contracts-v2` and confirmed
 * against the live chain, because two of them are the kind of mistake that
 * produces a plausible number rather than an obvious one. See `SCALAR_12` and
 * `IR_MOD_SCALAR`.
 */

/** Factors, utilisation and the `r_*` curve constants. */
const SCALAR_7 = BigInt(10_000_000)

/**
 * The scale of `b_rate` and `d_rate` — **twelve** decimals in Blend v2, not
 * seven like everything else on the reserve.
 *
 * v1 used nine. Reading a v2 rate at the v1 scale is off by a thousand and
 * still looks like a rate, which is the whole danger.
 */
const SCALAR_12 = BigInt(1_000_000_000_000)

/**
 * The scale of `ir_mod` — **seven** decimals in v2, where v1 used nine.
 *
 * This one is worth the paragraph. Read at the v1 scale, this pool's `ir_mod`
 * of 100000000 becomes 0.1 rather than 10.0, and the supply APY comes out at a
 * comfortable-looking 1.70% instead of the real figure two orders of magnitude
 * above it. Both are believable on sight; only one is true. Settled empirically
 * rather than by reading: `d_rate` drifted 2579870925643 to 2580608571322 over
 * 4330 seconds, which annualises to 208% and matches the seven-decimal reading.
 */
const IR_MOD_SCALAR = BigInt(10_000_000)

/**
 * Where the second and third segments of the curve meet, and the width of the
 * third.
 *
 * Hardcoded literals in the contract rather than `max_util`, which is only a
 * borrow guard. Using `max_util` here would be wrong on any pool whose guard is
 * not 95%.
 */
const KINK_HIGH = BigInt(9_500_000)
const KINK_HIGH_WIDTH = BigInt(500_000)

/**
 * Blend compounds supply weekly and borrow daily in its own interface.
 *
 * Matching it is not cosmetic: a rate compounded at another frequency is a
 * different number, and disagreeing with the figure on Blend's own site would
 * look like a bug in whichever the user read second. Each is the more
 * conservative estimate for the person facing it.
 */
const SUPPLY_COMPOUNDS_PER_YEAR = 52
const BORROW_COMPOUNDS_PER_YEAR = 365

/** Any account works: a simulation touches neither balance nor sequence. */
const READ_ONLY_SOURCE = 'GCYQ3NXJHGD7P36OVKII6GKVLAENQ6ZETYOBAPZTI4R6ZWUU6QLHVVUX'

/**
 * Blend's XLM reserve, as a contract id.
 *
 * Taken from the pool's own `get_reserve_list` rather than derived with
 * `sacFor`. The distinction is not pedantic: Blend's *USDC* is a third distinct
 * issuer from Circle's and Soroswap's, so a ticker-derived id would name an
 * asset this pool has never heard of. XLM happens to be the canonical SAC, and
 * hardcoding a derived one anyway would set the precedent that breaks on the
 * next asset.
 *
 * Callers that accept user input should still check `readReserveList` rather
 * than trusting this constant; it exists for the one asset the app supplies
 * today.
 *
 * Both ids are the `XLM` entries of Blend's own deployment files,
 * https://github.com/blend-capital/blend-utils/blob/main/testnet.contracts.json
 * and `mainnet.contracts.json` (read 2026-09-24); the mainnet one is the
 * first reserve the `Fixed` pool listed on the public network that day.
 */
export const BLEND_XLM =
  activeNetwork() === 'mainnet'
    ? 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA'
    : 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'

export interface ReserveConfig {
  index: number
  decimals: number
  enabled: boolean
  /** Utilisation the first kink sits at, as a fraction. */
  util: number
  /** Utilisation above which new borrows are refused, as a fraction. */
  maxUtil: number
  /**
   * How much of this asset's value counts as collateral, as a fraction.
   *
   * 0.90 for XLM here: $100 of it backs $90 of borrowing. Read rather than
   * assumed, because it differs per reserve — USDC is 0.95, wETH 0.85 — and a
   * health factor computed with the wrong one is wrong in the direction of
   * looking safer than it is.
   */
  cFactor: number
  /**
   * How much a liability in this asset counts against the position.
   *
   * Applied as a *division*, so a factor below one makes a debt weigh more
   * than its face value. The asymmetry with `cFactor` is the pool's margin of
   * safety and must survive into anything that recomputes health.
   */
  lFactor: number
  rBase: bigint
  rOne: bigint
  rTwo: bigint
  rThree: bigint
  supplyCap: bigint
}

export interface ReserveData {
  bRate: bigint
  dRate: bigint
  bSupply: bigint
  dSupply: bigint
  backstopCredit: bigint
  irMod: bigint
  lastTime: bigint
}

export interface Reserve {
  /** The reserve's asset, as a contract id. Read from the pool, never derived. */
  asset: string
  config: ReserveConfig
  data: ReserveData
  /** Borrowed over supplied, as a fraction. */
  utilisation: number
  /** What a supplier earns before compounding, as a percentage. */
  supplyApr: number
  /** What a supplier earns, compounded weekly, as a percentage. */
  supplyApy: number
  /** What a borrower pays, compounded daily, as a percentage. */
  borrowApy: number
}

export interface ReadReserveOptions {
  poolId?: string
  rpcUrl?: string
  /** Injected in tests, so the rate maths is checkable without a network. */
  serverImpl?: Pick<rpc.Server, 'simulateTransaction'>
}

/**
 * The pool's cut of borrower interest, which suppliers do not receive.
 *
 * Lives on the pool config rather than the reserve. Read live rather than
 * assumed: a hardcoded take rate would silently overstate yield on any pool
 * configured differently, and overstating yield is the specific error this
 * whole file exists to avoid.
 */
export interface PoolRates {
  backstopTakeRate: bigint
}

function serverFor(options: ReadReserveOptions): Pick<rpc.Server, 'simulateTransaction'> {
  return options.serverImpl ?? new rpc.Server(options.rpcUrl ?? stellarNetwork.sorobanRpcUrl)
}

async function simulate(
  fn: string,
  args: xdr.ScVal[],
  options: ReadReserveOptions
): Promise<unknown> {
  const poolId = options.poolId ?? BLEND_POOL

  const tx = new TransactionBuilder(new Account(READ_ONLY_SOURCE, '0'), {
    fee: BASE_FEE,
    networkPassphrase: stellarNetwork.networkPassphrase,
  })
    .addOperation(new Contract(poolId).call(fn, ...args))
    .setTimeout(60)
    .build()

  const sim = await serverFor(options).simulateTransaction(tx)

  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`Blend ${fn} failed: ${sim.error}`)
  }
  if (sim.result === undefined) {
    throw new Error(`Blend ${fn} returned nothing`)
  }

  return scValToNative(sim.result.retval)
}

/** Ceiling division on integers, matching the contract's `fixed_div_ceil`. */
function divCeil(a: bigint, b: bigint): bigint {
  if (b === BigInt(0)) return BigInt(0)
  return (a + b - BigInt(1)) / b
}

function mulCeil(a: bigint, b: bigint, scale: bigint): bigint {
  return divCeil(a * b, scale)
}

function mulFloor(a: bigint, b: bigint, scale: bigint): bigint {
  return (a * b) / scale
}

/**
 * Borrowed over supplied.
 *
 * Both sides are accumulator-scaled rather than raw token counts, so this is
 * not `dSupply / bSupply`. `backstopCredit` is deliberately **not** subtracted:
 * `b_rate` is already net of it, and removing it again double-counts — it would
 * report 90.26% where the contract reports 90.00%.
 */
export function utilisationOf(data: ReserveData): bigint {
  const liabilities = mulCeil(data.dSupply, data.dRate, SCALAR_12)
  const supplied = mulFloor(data.bSupply, data.bRate, SCALAR_12)
  if (supplied === BigInt(0)) return BigInt(0)

  const util = divCeil(liabilities * SCALAR_7, supplied)
  return util > SCALAR_7 ? SCALAR_7 : util
}

/**
 * The borrow interest rate, from the kinked curve.
 *
 * Three segments, and the third is not simply the second continued: above 95%
 * the modifier stops applying to the steep part, so borrowing gets sharply more
 * expensive exactly where the pool most needs repaying.
 */
export function borrowRateOf(config: ReserveConfig, data: ReserveData, util: bigint): bigint {
  const target = BigInt(Math.round(config.util * Number(SCALAR_7)))

  if (util <= target) {
    const scalar = target === BigInt(0) ? BigInt(0) : divCeil(util * SCALAR_7, target)
    const base = mulCeil(scalar, config.rOne, SCALAR_7) + config.rBase
    return mulCeil(base, data.irMod, IR_MOD_SCALAR)
  }

  if (util <= KINK_HIGH) {
    const span = KINK_HIGH - target
    const scalar = span === BigInt(0) ? BigInt(0) : divCeil((util - target) * SCALAR_7, span)
    const base = mulCeil(scalar, config.rTwo, SCALAR_7) + config.rOne + config.rBase
    return mulCeil(base, data.irMod, IR_MOD_SCALAR)
  }

  const scalar = divCeil((util - KINK_HIGH) * SCALAR_7, KINK_HIGH_WIDTH)
  const extra = mulCeil(scalar, config.rThree, SCALAR_7)
  const base = config.rTwo + config.rOne + config.rBase
  // The modifier applies to the base segments but not to `extra`.
  return extra + mulCeil(base, data.irMod, IR_MOD_SCALAR)
}

/**
 * What a supplier earns, before compounding.
 *
 * Suppliers receive borrower interest scaled by two things: how much of the
 * pool is actually lent out, and the share the backstop takes first.
 */
export function supplyRateOf(borrowRate: bigint, util: bigint, takeRate: bigint): bigint {
  const capture = mulFloor(SCALAR_7 - takeRate, util, SCALAR_7)
  return mulFloor(borrowRate, capture, SCALAR_7)
}

function toApy(apr: number, periods: number): number {
  return ((1 + apr / periods) ** periods - 1) * 100
}

function toFraction(raw: bigint): number {
  return Number(raw) / Number(SCALAR_7)
}

/**
 * Which assets the pool accepts, in index order.
 *
 * Read from the pool rather than derived with `sacFor`. Blend's USDC is a
 * different issuer from Circle's and from Soroswap's, so an id derived from a
 * ticker would name an asset this pool has never heard of — the same
 * impersonation trap the quoter fell into once already.
 */
export async function readReserveList(options: ReadReserveOptions = {}): Promise<string[]> {
  const list = await simulate('get_reserve_list', [], options)
  if (!Array.isArray(list)) throw new Error('Blend returned an unreadable reserve list')
  return list.map((entry) => String(entry))
}

interface RawReserve {
  asset?: unknown
  config?: Record<string, unknown>
  data?: Record<string, unknown>
}

function asBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') return BigInt(Math.trunc(value))
  if (typeof value === 'string') return BigInt(value)
  return BigInt(0)
}

function asNumber(value: unknown): number {
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'number') return value
  if (typeof value === 'string') return Number(value)
  return 0
}

/**
 * The pool's backstop take rate.
 *
 * Read rather than assumed, for the reason given on `PoolRates`.
 */
export async function readPoolRates(options: ReadReserveOptions = {}): Promise<PoolRates> {
  const config = (await simulate('get_config', [], options)) as Record<string, unknown> | undefined
  return { backstopTakeRate: asBigInt(config?.['bstop_rate']) }
}

/**
 * One reserve, with its rates derived.
 *
 * Takes an asset contract id rather than a ticker, deliberately. A ticker would
 * have to be resolved to an id somewhere, and the only correct place to resolve
 * it is against `get_reserve_list`.
 */
export async function readReserve(
  asset: string,
  options: ReadReserveOptions = {}
): Promise<Reserve> {
  const [raw, rates] = await Promise.all([
    simulate('get_reserve', [new Address(asset).toScVal()], options) as Promise<RawReserve>,
    readPoolRates(options),
  ])

  if (raw?.config === undefined || raw.data === undefined) {
    throw new Error(`Blend has no reserve for ${asset}`)
  }

  const config: ReserveConfig = {
    index: asNumber(raw.config['index']),
    decimals: asNumber(raw.config['decimals']),
    enabled: raw.config['enabled'] !== false,
    util: asNumber(raw.config['util']) / Number(SCALAR_7),
    maxUtil: asNumber(raw.config['max_util']) / Number(SCALAR_7),
    cFactor: asNumber(raw.config['c_factor']) / Number(SCALAR_7),
    lFactor: asNumber(raw.config['l_factor']) / Number(SCALAR_7),
    rBase: asBigInt(raw.config['r_base']),
    rOne: asBigInt(raw.config['r_one']),
    rTwo: asBigInt(raw.config['r_two']),
    rThree: asBigInt(raw.config['r_three']),
    supplyCap: asBigInt(raw.config['supply_cap']),
  }

  const data: ReserveData = {
    bRate: asBigInt(raw.data['b_rate']),
    dRate: asBigInt(raw.data['d_rate']),
    bSupply: asBigInt(raw.data['b_supply']),
    dSupply: asBigInt(raw.data['d_supply']),
    backstopCredit: asBigInt(raw.data['backstop_credit']),
    irMod: asBigInt(raw.data['ir_mod']),
    lastTime: asBigInt(raw.data['last_time']),
  }

  const util = utilisationOf(data)
  const borrowRate = borrowRateOf(config, data, util)
  const supplyRate = supplyRateOf(borrowRate, util, rates.backstopTakeRate)
  const supplyApr = toFraction(supplyRate)

  return {
    asset: typeof raw.asset === 'string' ? raw.asset : asset,
    config,
    data,
    utilisation: toFraction(util),
    supplyApr: supplyApr * 100,
    supplyApy: toApy(supplyApr, SUPPLY_COMPOUNDS_PER_YEAR),
    borrowApy: toApy(toFraction(borrowRate), BORROW_COMPOUNDS_PER_YEAR),
  }
}
