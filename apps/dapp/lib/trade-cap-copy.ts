import type { ChainSlug } from '@intent/types'

/**
 * The mainnet per-trade cap as one plain sentence, or nothing where there is
 * no cap. The cap is a Stellar one: on Arc it does not apply, so saying it
 * there would promise a limit nothing enforces.
 */
export function tradeCapNote(capUsd: number | undefined, chain: ChainSlug): string | undefined {
  if (capUsd === undefined || chain !== 'stellar') return undefined
  return `Each trade is capped at $${capUsd.toLocaleString('en-US')} on mainnet.`
}
