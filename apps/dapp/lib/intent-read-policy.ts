import { configuredLendingVenues } from './lend/venues'
import { resolveVerifiedAsset } from './swap/asset-registry'

/**
 * What a reading of a typed instruction is allowed to name on a given chain.
 *
 * Shared by every route that reads an instruction, so the answer to "can this
 * app do that here" is held in one place and cannot differ between them.
 */

/**
 * Lending venues that exist per chain. Empty means the chain has none.
 *
 * Read per request rather than once: on Stellar the list is whatever this
 * deployment is configured for, and DeFindex is in it only while its key is.
 */
export function lendingVenuesOn(chain: string): string[] {
  return chain === 'stellar' ? configuredLendingVenues() : []
}

/** Anchors that withdraw to fiat, per chain. */
export const OFFRAMP_ANCHORS: Record<string, string[]> = {
  stellar: ['testanchor', 'moneygram'],
  arc: [],
}

/**
 * Assets that can be borrowed but not traded here.
 *
 * The two vocabularies genuinely differ. `tradeableSymbols()` answers "what can
 * this app swap" — XLM, USDC and CETES — while Blend's pool lends four
 * reserves including wBTC and wETH, which have no route in this app's registry.
 *
 * Without these the model reads "borrow wBTC" perfectly and the reading is then
 * thrown away for naming an unknown ticker, which looks exactly like a parse
 * failure. Confirmed by reading each reserve contract's own `symbol` rather
 * than assuming, since Blend's USDC is a different issuer from Circle's.
 */
export const LENDABLE_ONLY: Record<string, string[]> = {
  stellar: ['WBTC', 'WETH'],
  arc: [],
}

/** Words people capitalise that are not tokens. */
const NOT_TOKENS = new Set([
  'SWAP',
  'BUY',
  'SELL',
  'SEND',
  'FOR',
  'THE',
  'AND',
  'ALL',
  'MAX',
  'NOW',
  'USD',
  'USDS',
  'LIMIT',
  'ORDER',
  'WORTH',
  'CASH',
  'OUT',
  'NGN',
  'APY',
  'TVL',
  'DEX',
  'ETF',
  'ASAP',
])

/** Capitalised 3-8 letter words that are not known assets, in the order they appear. */
export function unknownTickers(text: string): string[] {
  const seen = new Set<string>()
  for (const word of text.match(/[A-Z][A-Z0-9]{2,7}/g) ?? []) {
    if (NOT_TOKENS.has(word) || resolveVerifiedAsset(word) !== undefined) continue
    seen.add(word)
  }
  return [...seen].slice(0, 3)
}
