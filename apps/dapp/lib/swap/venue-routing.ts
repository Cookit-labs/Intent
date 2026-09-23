import { stellarTestnet } from '@intent/config'
import { FeeBumpTransaction, TransactionBuilder } from '@stellar/stellar-sdk'

import { assertSelfAquariusSwap } from './build-aquarius'
import { assertSelfSoroswapSwap } from './build-soroban'
import { assertSelfSwap } from './build-tx'
import { AQUARIUS_ROUTER, SOROSWAP_AGGREGATOR, SOROSWAP_ROUTER } from './contract-registry'
import { readContractCall } from './plan-validator'
import type { SwapQuote } from './quote'

/**
 * Deciding which builder signs a given quote, and which assertion re-checks
 * the envelope that comes back signed.
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

/**
 * Which builder a quote belongs to.
 *
 * `soroban` is Soroswap's router and `aquarius` is Aquarius's, kept apart
 * rather than folded into one "contract call" kind because each builder
 * asserts a different argument layout — the recipient sits in the fourth
 * argument on one and the first on the other, and only one takes a pool
 * index. A shared kind would mean a shared assertion, and a shared assertion
 * proves less than either alone.
 *
 * `aggregator` is Soroswap's hosted route-finder: the transaction is built
 * by its API rather than here, and takes one of three shapes the API chooses
 * per quote. `build-aggregator` re-reads whichever arrives against the quote
 * — the recipient sits sixth on the aggregator contract, fourth on the
 * router, and in `destination` on a classic path payment.
 */
export type VenueKind = 'classic' | 'soroban' | 'aquarius' | 'aggregator'

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
    case 'aquarius':
      return 'aquarius'
    case 'soroswap-aggregator':
      return 'aggregator'
    default:
      throw new Error(`no builder for quotes from ${String(quote.source)}`)
  }
}

/**
 * Re-asserts a signed envelope with the check its shape calls for.
 *
 * Each builder's assertion proves a different thing, and the submit route
 * used to pick between two of them by trial: the path-payment check first,
 * and on failure the Soroswap one, which reads the source and the operation
 * type and nothing else. An Aquarius envelope satisfied that fallback with
 * any address in its first argument — the one the router pays — so the
 * builder's guarantee held at build time and was dropped after the bytes had
 * been through a browser and a wallet extension, which is the only point the
 * re-check exists for.
 *
 * The shape is read from the bytes, not from a venue the client names. A
 * lone call to the Aquarius router gets the Aquarius assertion; one to the
 * Soroswap router or aggregator gets the Soroswap one, which reads the
 * recipient where that contract keeps it; a lone call to any other contract
 * is refused, since no swap is built against one. Everything else is held to
 * the path-payment check, whose message stays the one a malformed classic
 * swap has always produced.
 */
export function assertSelfSubmission(signedXdr: string, account: string): void {
  const decoded = TransactionBuilder.fromXDR(signedXdr, stellarTestnet.networkPassphrase)
  if (decoded instanceof FeeBumpTransaction) {
    throw new Error('fee-bump transactions are not supported here')
  }

  const op = decoded.operations.length === 1 ? decoded.operations[0] : undefined
  if (op === undefined || op.type !== 'invokeHostFunction') {
    assertSelfSwap(signedXdr, account)
    return
  }

  const { contractId } = readContractCall(op)
  switch (contractId) {
    case AQUARIUS_ROUTER:
      assertSelfAquariusSwap(signedXdr, account)
      return
    case SOROSWAP_ROUTER:
      assertSelfSoroswapSwap(signedXdr, account, 'router')
      return
    case SOROSWAP_AGGREGATOR:
      assertSelfSoroswapSwap(signedXdr, account, 'aggregator')
      return
    default:
      throw new Error(
        `refusing to submit: ${contractId ?? 'the contract called'} is not a swap contract this app builds calls to`
      )
  }
}
