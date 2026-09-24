import { activeNetwork, type StellarNetworkName } from '@intent/config'

import { BLEND_XLM } from '../lend/reserves'
import { fromBaseUnits } from '../swap/assets'
import type { PlanAction } from '../swap/build-plan'
import { fetchPools, type Pool } from '../swap/liquidity-pools'
import type { MarketPrice } from '../swap/price-types'
import { fetchMarketPrices } from '../swap/prices'

/**
 * A small per-trade cap on mainnet, and none on testnet.
 *
 * Real money on new rails: until the app has been watched keeping its
 * promises with real volume, no single trade may be worth more than a few
 * tens of dollars. The cap is in dollars rather than units so it means the
 * same thing for XLM and for USDC, and it is checked against the same price
 * table the agents reason from.
 *
 * A trade that cannot be valued is refused rather than waved through. A
 * fallback price is a guess, and a cap checked against a guess is no cap;
 * the price sources are Reflector and the mainnet book, and both being
 * unreachable is the moment to stop, not the moment to estimate.
 */

type Env = Record<string, string | undefined>

export const TRADE_CAP_ENV = 'MAINNET_MAX_TRADE_USD'

export const DEFAULT_MAINNET_MAX_TRADE_USD = 50

/** The cap in dollars, or nothing on testnet, where there is none. */
export function tradeCapUsd(
  env: Env = process.env,
  network: StellarNetworkName = activeNetwork()
): number | undefined {
  if (network !== 'mainnet') return undefined
  const raw = env[TRADE_CAP_ENV]?.trim()
  if (raw === undefined || raw === '') return DEFAULT_MAINNET_MAX_TRADE_USD
  const cap = Number(raw)
  if (!Number.isFinite(cap) || cap <= 0) {
    throw new Error(`${TRADE_CAP_ENV} must be a positive number of dollars, not "${raw}"`)
  }
  return cap
}

/** Thrown for a trade over the cap, or one the cap cannot be checked against. */
export class TradeCapExceeded extends Error {}

/** Refuses a dollar value above the cap. A no-op on testnet. */
export function assertWithinCap(
  usd: number,
  env: Env = process.env,
  network: StellarNetworkName = activeNetwork()
): void {
  const cap = tradeCapUsd(env, network)
  if (cap === undefined) return
  if (!Number.isFinite(usd)) {
    throw new TradeCapExceeded(
      `this trade could not be valued in dollars, so the mainnet cap of $${cap} cannot be checked`
    )
  }
  if (usd > cap) {
    throw new TradeCapExceeded(
      `this deployment caps each trade at $${cap} on mainnet, and this one is about ` +
        `$${usd.toFixed(2)}. Set ${TRADE_CAP_ENV} to change it.`
    )
  }
}

/**
 * Dollars for an amount of an asset in display units, from a price table;
 * `NaN` when the table has no real price for it. A fallback entry counts as
 * no price, for the reason given above.
 */
export function usdValue(
  symbol: string,
  amount: string,
  prices: Record<string, MarketPrice>
): number {
  const price = prices[symbol]
  if (price === undefined || price.source === 'fallback') return Number.NaN
  return Number(amount) * price.usd
}

export interface TradeCapOptions {
  env?: Env
  network?: StellarNetworkName
  /** Injected in tests. The live table otherwise. */
  prices?: () => Promise<Record<string, MarketPrice>>
}

/**
 * Checks one trade against the cap: what leaves the account, as a symbol
 * and a display-unit amount. On testnet this returns before pricing anything,
 * so nothing about a testnet build changes.
 */
export async function assertTradeWithinCap(
  symbol: string,
  amount: string,
  options: TradeCapOptions = {}
): Promise<void> {
  const env = options.env ?? process.env
  const network = options.network ?? activeNetwork()
  if (tradeCapUsd(env, network) === undefined) return
  const table = await (options.prices ?? fetchMarketPrices)()
  assertWithinCap(usdValue(symbol, amount, table), env, network)
}

/**
 * Checks a plan against the cap: each step on its own, and then every step
 * together per asset. One signature over ten steps could otherwise move ten
 * times the cap out of an account in independent outflows. A pool deposit
 * spends both sides, so both are valued; a pool that cannot be found cannot
 * be valued, and is refused for that. On testnet nothing is read.
 */
export async function assertPlanWithinCap(
  actions: PlanAction[],
  options: TradeCapOptions & { pools?: () => Promise<Pool[]> } = {}
): Promise<void> {
  const env = options.env ?? process.env
  const network = options.network ?? activeNetwork()
  const cap = tradeCapUsd(env, network)
  if (cap === undefined) return
  const table = await (options.prices ?? fetchMarketPrices)()

  const spentBySymbol = new Map<string, number>()
  const spend = (symbol: string, amount: string): void => {
    const usd = usdValue(symbol, amount, table)
    assertWithinCap(usd, env, network)
    spentBySymbol.set(symbol, (spentBySymbol.get(symbol) ?? 0) + usd)
  }

  let pools: Pool[] | undefined
  for (const action of actions) {
    switch (action.kind) {
      case 'swap':
        spend(action.from.code, fromBaseUnits(action.sendAmount))
        break
      case 'rest':
        spend(action.selling.code, action.amount)
        break
      case 'lend':
        // Named by contract. XLM is the one reserve this app supplies, and
        // anything else has no price here to cap by.
        spend(action.asset === BLEND_XLM ? 'XLM' : action.asset, fromBaseUnits(action.amount))
        break
      case 'pool': {
        pools ??= await (options.pools ?? fetchPools)()
        const [a, b] = pools.find((p) => p.id === action.poolId)?.assets ?? []
        if (a === undefined || b === undefined) assertWithinCap(Number.NaN, env, network)
        else {
          // Both sides leave together, so the deposit is one trade of their sum.
          assertWithinCap(
            usdValue(a.code, action.maxAmountA, table) + usdValue(b.code, action.maxAmountB, table),
            env,
            network
          )
          spend(a.code, action.maxAmountA)
          spend(b.code, action.maxAmountB)
        }
        break
      }
      case 'trust':
        break
    }
  }

  for (const [symbol, usd] of spentBySymbol) {
    if (usd > cap) {
      throw new TradeCapExceeded(
        `this deployment caps each trade at $${cap} on mainnet, and these steps together spend ` +
          `about $${usd.toFixed(2)} in ${symbol} across this plan. Set ${TRADE_CAP_ENV} to change it.`
      )
    }
  }
}
