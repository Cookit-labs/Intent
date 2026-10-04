/** The mainnet per-trade cap as one plain sentence, or nothing where there is no cap. */
export function tradeCapNote(capUsd: number | undefined): string | undefined {
  if (capUsd === undefined) return undefined
  return `Each trade is capped at $${capUsd.toLocaleString('en-US')} on mainnet.`
}
