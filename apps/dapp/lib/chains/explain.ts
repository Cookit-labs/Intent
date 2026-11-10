import { looksLikeChainAction } from './parse-action'
import type { ChainActionKind } from './types'

const EXAMPLE: Record<ChainActionKind, (symbol: string, venue: string) => string> = {
  swap: (symbol) => `swap 10 USDC to ${symbol}`,
  supply: (_symbol, venue) => `supply 25 USDC on ${venue}`,
  stake: (symbol, venue) => `stake 1 ${symbol} with ${venue}`,
  send: (symbol) => `send 5 ${symbol} to an address`,
  limit: (symbol) => `sell 1 ${symbol} at $110`,
  withdraw: (symbol, venue) => `withdraw 25 ${symbol} from ${venue}`,
  unstake: (symbol, venue) => `unstake 1 ${symbol} from ${venue}`,
  borrow: (symbol, venue) => `borrow 25 ${symbol} on ${venue}`,
  repay: (symbol, venue) => `repay 25 ${symbol} on ${venue}`,
  stream: (symbol) => `stream 100 ${symbol} to an address over 30 days`,
  invoice: (symbol) => `invoice an address 100 ${symbol} due 2027-01-31`,
  pay_invoice: (symbol) => `pay invoice 12 with 100 ${symbol}`,
  claim: (symbol) => `claim my ${symbol}`,
  cancel: () => 'cancel stream 12',
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
  const orders = capabilities.some((c) => c.kind === 'limit')
    ? ' Say "my orders" to see, cancel or collect a limit order.'
    : ''
  return `I couldn't read that as something I can do on ${chainName}. Try ${examples.join(' or ')}.${orders}`
}

/**
 * One short question when a message could not be read: what the person wants, with two examples
 * at most. Asked as a question, so the answer is read together with what came before it.
 */
export function askAgain(chainName: string, capabilities: readonly ChainCapability[]): string {
  const examples: string[] = []
  const swap = capabilities.find((c) => c.kind === 'swap')
  if (swap !== undefined) examples.push(`"swap 5 ${swap.symbol} to USDC"`)
  const supply = capabilities.find((c) => c.kind === 'supply')
  if (capabilities.some((c) => c.then?.includes('cashout'))) examples.push('"cash out 5 USDC"')
  else if (supply !== undefined) examples.push(`"${EXAMPLE.supply(supply.symbol, supply.venue)}"`)
  const tail = examples.length === 0 ? '' : ` You can say something like ${examples.join(' or ')}.`
  return `I didn't quite follow that. What would you like to do on ${chainName}?${tail}`
}

export const RATE_LIMITED = "You're sending messages quickly. Wait a minute and try again."

const RATE_LIMITED_TODAY = "You've sent a lot of messages today. Try again later."

/**
 * What to say when the model did not read a message. Being held back by the rate limit says nothing
 * about the words. A message that asks to do something is told what works. Nothing for any other,
 * which gets the ordinary answer about the model being out of reach.
 */
export function helpForUnread(
  reason: string,
  said: readonly string[],
  chainName: string,
  capabilities: readonly ChainCapability[]
): string | undefined {
  if (reason === 'rate_limited') return RATE_LIMITED
  if (reason === 'rate_limited_today') return RATE_LIMITED_TODAY
  return said.some(looksLikeChainAction) ? askAgain(chainName, capabilities) : undefined
}
