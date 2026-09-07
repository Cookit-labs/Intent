import { CHAIN_DESCRIPTORS, isChainSlug } from '@intent/config'

import type { MarketContext } from './brain'
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
