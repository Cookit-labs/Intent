import { CHAIN_DESCRIPTORS, isChainSlug } from '@intent/config'

import type { MarketContext, QuotedRoute } from './brain'
import { fromBaseUnits, resolveAsset } from '../swap/assets'
import { collectQuotes } from '../swap/quote'
import { createHorizonQuoter } from '../swap/sources/horizon-quoter'
import { fetchMarketPrices, toPriceTable } from '../swap/prices'
import { REFERENCE_PRICES_USD } from '../parse-intent'
import { venues } from '../venues'

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
export async function quoteRoutes(
  chain: string,
  fromSymbol: string,
  toSymbol: string,
  amount: string,
  signal?: AbortSignal
): Promise<QuotedRoute[]> {
  if (chain !== 'stellar') return []

  const from = resolveAsset(fromSymbol)
  const to = resolveAsset(toSymbol)
  if (from === undefined || to === undefined) return []
  if (from.code === to.code && from.issuer === to.issuer) return []

  const { quotes } = await collectQuotes(
    [createHorizonQuoter()],
    { kind: 'strict_send', from, to, sendAmount: amount },
    signal
  )

  return quotes.map((quote, index) => ({
    // Indexed by source so an agent naming a route cannot accidentally match
    // one from a different competition.
    id: `${quote.source}-${index + 1}`,
    source: quote.source,
    // Human-scale, because asking a model to divide by 10^7 invites arithmetic
    // errors in exactly the number the user reads.
    sendAmount: `${fromBaseUnits(quote.sendAmount)} ${quote.from.code}`,
    receiveAmount: `${fromBaseUnits(quote.destAmount)} ${quote.to.code}`,
    hops: quote.path.length,
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

  const prices = await fetchMarketPrices()
  return {
    ...base,
    // Real mainnet prices replace the indicative table. Testnet execution
    // still quotes its own synthetic rate; agents are told which is which.
    prices: { ...base.prices, ...toPriceTable(prices) },
  }
}

export function buildMarketContext(chain: string): MarketContext {
  const family = isChainSlug(chain) ? CHAIN_DESCRIPTORS[chain].family : 'evm'

  return {
    asOf: new Date().toISOString(),
    prices: { ...REFERENCE_PRICES_USD },
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
