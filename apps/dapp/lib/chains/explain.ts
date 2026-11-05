import { looksLikeChainAction } from './parse-action'
import type { ChainActionKind } from './types'

const EXAMPLE: Record<ChainActionKind, (symbol: string, venue: string) => string> = {
  swap: (symbol) => `swap 10 USDC to ${symbol}`,
  supply: (_symbol, venue) => `supply 25 USDC on ${venue}`,
  stake: (symbol, venue) => `stake 1 ${symbol} with ${venue}`,
  send: (symbol) => `send 5 ${symbol} to an address`,
}

/** What can come after a swap, in the words someone types. */
export type SwapThen = 'cashout' | 'supply' | 'send'

const THEN: Record<SwapThen, string> = {
  cashout: 'cash out',
  supply: 'deposit',
  send: 'send to an address',
}

export interface ChainCapability {
  kind: ChainActionKind
  venue: string
  symbol: string
  /** On a swap: what can follow it on this chain, as one request. */
  then?: readonly SwapThen[]
}

/** What works on this chain today, said as instructions someone can copy. */
export function chainHelp(chainName: string, capabilities: readonly ChainCapability[]): string {
  if (capabilities.length === 0) {
    return `I can't do that on ${chainName} yet.`
  }
  const examples = capabilities.flatMap((c) => [
    `"${EXAMPLE[c.kind](c.symbol, c.venue)}"`,
    ...(c.then ?? []).map((next) => `"swap 5 ${c.symbol} to USDC then ${THEN[next]}"`),
  ])
  // A plain send is read wherever a swap can end in one, though no capability lists it.
  if (
    capabilities.some((c) => c.then?.includes('send')) &&
    !examples.some((e) => e.startsWith('"send '))
  ) {
    examples.push(`"${EXAMPLE.send('USDC', '')}"`)
  }
  return `I couldn't read that as something I can do on ${chainName}. Try ${examples.join(' or ')}.`
}

/**
 * What to say when the model could not read a message that asks to do something. Nothing for one
 * that doesn't, which gets the ordinary answer about the model being out of reach.
 */
export function helpForUnread(
  said: readonly string[],
  chainName: string,
  capabilities: readonly ChainCapability[]
): string | undefined {
  return said.some(looksLikeChainAction) ? chainHelp(chainName, capabilities) : undefined
}
