import type { SwapQuote } from './quote'

/**
 * Deciding which builder signs a given quote.
 *
 * Three builders exist and they are not interchangeable, because each asserts
 * a different security property:
 *
 * - `build-tx` asserts a path payment whose destination equals its source.
 * - `build-offer` asserts a lone offer operation, which has no destination at
 *   all and therefore cannot pay a third party.
 * - `build-soroban` asserts the recipient *argument* passed to the router,
 *   since a contract call has no destination field to pin.
 *
 * Handing a quote to the wrong one either throws — the good outcome — or
 * builds a transaction whose guarantee does not match the shape being signed.
 * That decision is made here, once, rather than at each call site.
 *
 * The build endpoint previously hardcoded Horizon, so a Soroswap route could
 * never be signed however good its price. On identical assets Soroswap quotes
 * roughly 473 XLM for 50 USDC against Horizon's 128, so "however good" was
 * doing real work.
 */

export type VenueKind = 'classic' | 'soroban'

/**
 * Which builder a quote must go to.
 *
 * Throws rather than defaulting. A source with no builder is a wiring mistake,
 * and inheriting one by accident is how a route gets signed with the wrong
 * guarantee attached.
 */
export function builderFor(quote: SwapQuote): VenueKind {
  // Checked before the venue, because it disqualifies a route whatever the
  // venue is. A quote that settles in a contract token merely sharing a ticker
  // would hand the user an asset they did not choose — the failure the asset
  // registry exists to prevent, arriving through a different door.
  if (quote.deliversAsset !== undefined) {
    throw new Error(
      `route from ${quote.source} settles in a different asset than the ${quote.to.code} it names`
    )
  }

  switch (quote.source) {
    case 'horizon':
      return 'classic'
    case 'soroswap':
      return 'soroban'
    default:
      throw new Error(`no builder for quotes from ${String(quote.source)}`)
  }
}
