import { stellarTestnet } from '@intent/config'
import {
  Address,
  BASE_FEE,
  Contract,
  Networks,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk'

import { BLEND_POOL } from '../swap/contract-registry'
import { liquidationPrice, positionHealth, type HealthLeg, type PositionHealth } from './health'
import { readPrices } from './oracle'
import { BLEND_XLM, readReserve, readReserveList } from './reserves'

/**
 * What an account holds in the Blend pool, and how close it is to liquidation.
 *
 * The pool stores balances as **bTokens** and **dTokens**, not as assets. Each
 * is a claim on a growing pot: `b_rate` rises as borrowers pay interest, and
 * `d_rate` rises as debt accrues. So a raw token balance is a number that never
 * moves while the position quietly changes value, and reporting one as if it
 * were the asset understates a supply and — more dangerously — understates a
 * debt.
 *
 * Both conversions use twelve-decimal scaling, which is v2. v1 used seven, and
 * reading v2 at v1's decimals is the mistake that once put this app's APY out
 * by a factor of a hundred.
 *
 * **Three balances, and the difference between them is the whole risk model.**
 * A plain supply earns and cannot be seized. Collateral earns, and backs
 * liabilities, and can be seized. A liability is owed. Anything showing these
 * to a user has to keep them apart — telling someone their supply is at risk
 * would be false, and telling them their collateral is safe would be worse.
 */

/** `b_rate` and `d_rate` are twelve-decimal fixed point in Blend v2. */
const RATE_SCALAR = BigInt('1000000000000')

export interface BlendBalance {
  /** The reserve's asset contract. */
  assetId: string
  symbol: string
  /** The raw pool balance, in bTokens or dTokens. */
  tokens: string
  /** What those tokens are worth right now, in stroops of the asset. */
  amount: string
  /** Human-readable, for display. */
  display: string
}

export interface BlendPosition extends BlendBalance {
  /** Kept for the supply-only callers that predate collateral. */
  bTokens: string
}

export interface BlendPositions {
  /** Earning, and not liquidatable. */
  supplied: BlendBalance[]
  /** Earning, backing liabilities, and liquidatable. */
  collateral: BlendBalance[]
  /** Owed, and accruing. */
  borrowed: BlendBalance[]
  /**
   * Where the position stands, from the pool's own formulas.
   *
   * `healthFactor` is undefined when nothing is borrowed — which is not a
   * missing value but the meaningful answer: no liabilities means no
   * liquidation is possible at all.
   */
  health: PositionHealth
  /**
   * The collateral price at which liquidation begins, when one asset backs
   * everything. Undefined when several do, since no single price decides it.
   */
  liquidationPrice: number | undefined
}

export interface ReadPositionOptions {
  rpcUrl?: string
  networkPassphrase?: string
}

/**
 * Simulating a read needs a source account, and any funded account will do —
 * `get_positions` takes the account it reports on as an argument rather than
 * reading the invoker. The account being asked about is therefore always a
 * valid choice and needs no separate key.
 */
async function simulate(server: rpc.Server, account: string, passphrase: string): Promise<unknown> {
  const source = await server.getAccount(account)
  const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(new Contract(BLEND_POOL).call('get_positions', new Address(account).toScVal()))
    .setTimeout(60)
    .build()

  const sim = await server.simulateTransaction(tx)
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(sim.error)
  }
  return scValToNative(sim.result?.retval as xdr.ScVal)
}

interface RawPositions {
  supply?: Record<string, bigint | number | string>
  collateral?: Record<string, bigint | number | string>
  liabilities?: Record<string, bigint | number | string>
}

/** Reserve indices are numbers in the position maps, not asset addresses. */
function entriesOf(map: Record<string, bigint | number | string> | undefined): [number, bigint][] {
  if (map === undefined) return []

  return Object.entries(map)
    .map(([index, raw]): [number, bigint] => [Number(index), BigInt(String(raw))])
    .filter(([index, tokens]) => Number.isInteger(index) && tokens > BigInt(0))
}

/**
 * Everything the account holds in the pool, priced and assessed.
 *
 * Reserves, prices and rates are read live rather than cached. A position's
 * value moves every ledger and its safety moves with the oracle, so a figure
 * this app stored would be wrong by the time it was shown — and wrong in the
 * direction of looking safer than it is, since debt grows faster than nothing.
 */
export async function readBlendPositions(
  account: string,
  options: ReadPositionOptions = {}
): Promise<BlendPositions> {
  const rpcUrl = options.rpcUrl ?? stellarTestnet.sorobanRpcUrl
  const passphrase = options.networkPassphrase ?? Networks.TESTNET
  const server = new rpc.Server(rpcUrl)

  const raw = (await simulate(server, account, passphrase)) as RawPositions | undefined

  const supplyEntries = entriesOf(raw?.supply)
  const collateralEntries = entriesOf(raw?.collateral)
  const liabilityEntries = entriesOf(raw?.liabilities)

  const empty: BlendPositions = {
    supplied: [],
    collateral: [],
    borrowed: [],
    health: { collateralBase: 0, liabilityBase: 0, healthFactor: undefined, liquidatable: false },
    liquidationPrice: undefined,
  }

  if (
    supplyEntries.length === 0 &&
    collateralEntries.length === 0 &&
    liabilityEntries.length === 0
  ) {
    return empty
  }

  // Indices are meaningless without the list that orders them, and reading an
  // index as an address would report the wrong asset entirely.
  const reserveList = await readReserveList({ rpcUrl })

  const touched = new Set<number>([
    ...supplyEntries.map(([index]) => index),
    ...collateralEntries.map(([index]) => index),
    ...liabilityEntries.map(([index]) => index),
  ])

  const reserves = new Map<number, Awaited<ReturnType<typeof readReserve>>>()
  for (const index of touched) {
    const asset = reserveList[index]
    if (asset === undefined) continue
    reserves.set(index, await readReserve(asset, { rpcUrl }))
  }

  const assets = [...reserves.values()].map((reserve) => reserve.asset)
  const prices = await readPrices(assets, { rpcUrl })

  function symbolFor(assetId: string): string {
    // Only XLM is named here because it is the only asset this app supplies.
    // Anything else shows its contract id rather than a guessed ticker — the
    // ticker-impersonation trap this codebase has hit before.
    return assetId === BLEND_XLM ? 'XLM' : `${assetId.slice(0, 4)}…${assetId.slice(-4)}`
  }

  function balanceFor(index: number, tokens: bigint, rate: bigint): BlendBalance | undefined {
    const reserve = reserves.get(index)
    if (reserve === undefined) return undefined

    const amount = (tokens * rate) / RATE_SCALAR
    return {
      assetId: reserve.asset,
      symbol: symbolFor(reserve.asset),
      tokens: tokens.toString(),
      amount: amount.toString(),
      display: (Number(amount) / 1e7).toFixed(7),
    }
  }

  function legsFor(
    entries: [number, bigint][],
    rateOf: (index: number) => bigint,
    factorOf: (index: number) => bigint
  ): { balances: BlendBalance[]; legs: HealthLeg[] } {
    const balances: BlendBalance[] = []
    const legs: HealthLeg[] = []

    for (const [index, tokens] of entries) {
      const balance = balanceFor(index, tokens, rateOf(index))
      if (balance === undefined) continue
      balances.push(balance)

      const price = prices[balance.assetId]?.price
      // No price means the leg cannot be valued. Skipped rather than counted
      // as zero: treating an unpriceable liability as worthless would report a
      // dangerous position as a healthy one.
      if (price === undefined) continue

      legs.push({
        symbol: balance.symbol,
        amount: BigInt(balance.amount),
        price,
        factor: factorOf(index),
      })
    }

    return { balances, legs }
  }

  const bRateOf = (index: number): bigint => BigInt(reserves.get(index)?.data.bRate ?? BigInt(0))
  const dRateOf = (index: number): bigint => BigInt(reserves.get(index)?.data.dRate ?? BigInt(0))
  const cFactorOf = (index: number): bigint =>
    BigInt(Math.round((reserves.get(index)?.config.cFactor ?? 0) * 10_000_000))
  const lFactorOf = (index: number): bigint =>
    BigInt(Math.round((reserves.get(index)?.config.lFactor ?? 0) * 10_000_000))

  const supplied = legsFor(supplyEntries, bRateOf, cFactorOf)
  const collateral = legsFor(collateralEntries, bRateOf, cFactorOf)
  const borrowed = legsFor(liabilityEntries, dRateOf, lFactorOf)

  // Only collateral counts toward health. A plain supply is deliberately
  // excluded — the pool does not count it either, which is exactly why a
  // supply-only position cannot be liquidated.
  const health = positionHealth(collateral.legs, borrowed.legs)

  return {
    supplied: supplied.balances,
    collateral: collateral.balances,
    borrowed: borrowed.balances,
    health,
    liquidationPrice: liquidationPrice(collateral.legs, borrowed.legs),
  }
}

/**
 * The account's XLM supply, or null if it has none.
 *
 * Kept for the callers written before collateral existed. Reports the plain
 * supply only, which is what those callers mean by "position".
 */
export async function readBlendPosition(
  account: string,
  options: ReadPositionOptions = {}
): Promise<BlendPosition | null> {
  const positions = await readBlendPositions(account, options)
  const xlm = positions.supplied.find((balance) => balance.assetId === BLEND_XLM)
  if (xlm === undefined) return null

  return { ...xlm, bTokens: xlm.tokens }
}
