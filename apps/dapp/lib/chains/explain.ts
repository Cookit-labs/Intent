import type { ChainActionKind } from './types'

const EXAMPLE: Record<ChainActionKind, (symbol: string, venue: string) => string> = {
  swap: (symbol) => `swap 10 USDC to ${symbol}`,
  supply: (_symbol, venue) => `supply 25 USDC on ${venue}`,
  stake: (symbol, venue) => `stake 1 ${symbol} with ${venue}`,
}

export interface ChainCapability {
  kind: ChainActionKind
  venue: string
  symbol: string
}

/** What works on this chain today, said as instructions someone can copy. */
export function chainHelp(chainName: string, capabilities: readonly ChainCapability[]): string {
  if (capabilities.length === 0) {
    return `I can't do that on ${chainName} yet.`
  }
  const examples = capabilities.map((c) => `"${EXAMPLE[c.kind](c.symbol, c.venue)}"`)
  return `I couldn't read that as something I can do on ${chainName}. Try ${examples.join(' or ')}.`
}
