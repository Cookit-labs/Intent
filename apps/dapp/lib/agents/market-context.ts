import { CHAIN_DESCRIPTORS, isChainSlug } from '@intent/config'

import type { MarketContext, QuotedRoute } from './brain'
import { fromBaseUnits, resolveAsset } from '../swap/assets'
import { collectQuotes } from '../swap/quote'
import { createHorizonQuoter } from '../swap/sources/horizon-quoter'
import { createSoroswapQuoter } from '../swap/sources/soroswap-quoter'
import { fetchMarketPrices, toPriceTable } from '../swap/prices'
import { REFERENCE_PRICES_USD } from '../parse-intent'
import { tradeableSymbols, trustSummary, verificationOf } from '../swap/asset-registry'
import { venues } from '../venues'
import { BLEND_XLM, readReserve } from '../lend/reserves'

/**
 * Assembles the facts an agent is allowed to reason from.
 *
 * Everything here is passed into the prompt rather than left to the model's
 * memory. That is the direct mitigation for the weakest part of a cheap model's
 * output: it will happily state a confident, wrong spot price, and that number
 * would flow straight into a projected fill the user sees.
 *
 * When a real price feed exists, only this file changes.
 */
/**
 * Prices the intent against live liquidity, so agents choose between real
 * routes instead of describing hypothetical ones.
 *
 * Returns an empty list rather than throwing when the pair is unswappable or
 * the chain cannot execute. A competition with no routes is still a
 * competition — the agents reason about the intent and simply cannot offer
 * execution, which is honest rather than broken.
 */
export interface QuoteRoutesOptions {
  /**
   * Minimum acceptable output, in base units.
   *
   * A limit order only makes sense if it can decline. Without this a "sell 100
   * XLM at $0.25" quote is indistinguishable from a market order and fills at
   * whatever the book offers, which is the opposite of what was asked.
   */
  minReceive?: string
}

export async function quoteRoutes(
  chain: string,
  fromSymbol: string,
  toSymbol: string,
  amount: string,
  signal?: AbortSignal,
  options: QuoteRoutesOptions = {}
): Promise<QuotedRoute[]> {
  if (chain !== 'stellar') return []

  const from = resolveAsset(fromSymbol)
  const to = resolveAsset(toSymbol)
  if (from === undefined || to === undefined) return []
  if (from.code === to.code && from.issuer === to.issuer) return []

  // Two independent pools, asked at once. Horizon covers the classic DEX and
  // its AMMs; Soroswap is a Soroban contract with its own depth. Asking both
  // is what makes this aggregation rather than a single venue with extra
  // steps, and `collectQuotes` already tolerates either one being down.
  const req = { kind: 'strict_send' as const, from, to, sendAmount: amount }

  // Every distinct Horizon path, not just its best. Stellar routes through an
  // intermediate asset when that beats going direct, and the two can differ by
  // more than a factor of two — collapsing them handed four agents a list of
  // one, which is why they kept reaching the same answer. They were not
  // failing to think; there was nothing to choose between.
  const horizon = createHorizonQuoter()
  const [horizonAll, others] = await Promise.all([
    horizon.quoteAll?.(req, signal),
    collectQuotes([createSoroswapQuoter()], req, signal),
  ])

  const quotes = [...(horizonAll?.ok === true ? horizonAll.quotes : []), ...others.quotes]

  // A limit that the market cannot meet returns nothing, so the competition
  // reports "no route" rather than offering a fill the user did not ask for.
  const acceptable =
    options.minReceive === undefined
      ? quotes
      : quotes.filter((q) => BigInt(q.destAmount) >= BigInt(options.minReceive as string))

  return acceptable.map((quote, index) => ({
    // Indexed by source so an agent naming a route cannot accidentally match
    // one from a different competition.
    id: `${quote.source}-${index + 1}`,
    source: quote.source,
    // Human-scale, because asking a model to divide by 10^7 invites arithmetic
    // errors in exactly the number the user reads.
    sendAmount: `${fromBaseUnits(quote.sendAmount)} ${quote.from.code}`,
    receiveAmount: `${fromBaseUnits(quote.destAmount)} ${quote.to.code}`,
    hops: quote.path.length,
    // Which assets the route passes through, so several Horizon paths for the
    // same pair are distinguishable. "2 hops" twice tells an agent nothing;
    // "via EURC" versus "direct" is a choice it can reason about.
    via: quote.path.length === 0 ? 'direct' : quote.path.map((h) => h.code).join(' → '),
    // Soroban tokens are separate contracts from classic issuers, so the USDC
    // Soroswap delivers is not the USDC Horizon delivers. Surfacing that keeps
    // an agent from reading two quotes as interchangeable and picking purely
    // on the larger number.
    // Only routes this app can actually build are offerable. The rest are
    // shown for comparison, which is the point of quoting two venues.
    // Executable when the route delivers the asset it names. The venue no
    // longer decides: a Soroswap route through canonical Stellar Asset
    // Contracts settles in the same XLM a path payment would, and refusing it
    // meant the agents could see a 3.7x better price and never take it.
    //
    // `deliversAsset` remains the guard, and it is the right one — it is set
    // precisely when a route would hand over a token that merely shares a
    // ticker with what the user asked for.
    executable: quote.deliversAsset === undefined,
    ...(quote.deliversAsset !== undefined
      ? { note: `settles in Soroban ${quote.to.code}, a different asset — not executable yet` }
      : {}),
    quote,
  }))
}

/**
 * Market context with live prices where they are available.
 *
 * Async because the price lookup is a network call. The synchronous version is
 * kept for callers that cannot await, and for chains with no price source.
 */
export async function buildMarketContextAsync(chain: string): Promise<MarketContext> {
  const base = buildMarketContext(chain)
  if (chain !== 'stellar') return base

  const [prices, lending] = await Promise.all([fetchMarketPrices(), fetchLendingRates()])

  return {
    ...base,
    // Real mainnet prices replace the indicative table. Testnet execution
    // still quotes its own synthetic rate; agents are told which is which.
    prices: { ...base.prices, ...toPriceTable(prices) },
    // Omitted rather than empty when the read fails, so an agent sees "no
    // lending data" instead of "lending pays nothing".
    ...(lending.length > 0 ? { lending } : {}),
  }
}

/**
 * Live supply rates from the lending pools this chain integrates.
 *
 * Failure is silent and returns nothing. A competition should not collapse
 * because a lending pool was unreachable — the trade is still the main event,
 * and an agent given no rate simply will not propose supplying.
 */
async function fetchLendingRates(): Promise<
  { venue: string; asset: string; supplyApy: number; utilisation: number }[]
> {
  try {
    const reserve = await readReserve(BLEND_XLM)
    return [
      {
        venue: 'blend',
        asset: 'XLM',
        supplyApy: Number(reserve.supplyApy.toFixed(2)),
        utilisation: Number((reserve.utilisation * 100).toFixed(2)),
      },
    ]
  } catch {
    return []
  }
}

export function buildMarketContext(chain: string): MarketContext {
  const family = isChainSlug(chain) ? CHAIN_DESCRIPTORS[chain].family : 'evm'

  return {
    asOf: new Date().toISOString(),
    prices: { ...REFERENCE_PRICES_USD },
    // What the agent may actually trade, with a plain-English description of
    // each. Without this an agent has no way to know tokenized sovereign debt
    // is on the menu, and would reason only about the currencies it has seen
    // in prior prompts.
    assets: tradeableSymbols().map((code) => ({
      code,
      what: verificationOf(code)?.description ?? code,
      // How well the issuer is established. An agent weighing an unfamiliar
      // asset should know whether the organisation named actually confirms it
      // issued the thing, and the difference is invisible from a ticker.
      trust: trustSummary(code) ?? 'Verification unknown.',
    })),
    // Naming a venue that does not exist on the active chain is a plausible
    // failure for a model, so the list it may choose from is filtered here
    // rather than validated after the fact.
    venues: venues
      .filter((v) => v.family === family)
      .map((v) => ({ id: v.id, name: v.name, category: v.category })),
    // Static until a feed exists. Stated plainly so the prompt is not implying
    // a signal the app does not actually have.
    volatilityHint: 'normal',
    gasHint: 'normal',
  }
}
