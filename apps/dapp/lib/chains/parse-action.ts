import type { ChainActionRequest } from './types'

const AMOUNT = String.raw`\$?([\d,]*\.?\d+)`
const TOKEN = String.raw`([a-z][a-z0-9.+]{0,11})`
const VENUE = String.raw`(?:\s+(?:on|via|with|using|in|into|at|to)\s+([a-z0-9][a-z0-9 .-]{1,30}?))?`
const END = String.raw`\s*[.!]?\s*$`

const SWAP = new RegExp(
  String.raw`^(?:please\s+)?(?:swap|convert|exchange|trade|change)\s+${AMOUNT}\s*${TOKEN}\s+(?:to|for|into)\s+${TOKEN}${VENUE}${END}`,
  'i'
)
const SUPPLY = new RegExp(
  String.raw`^(?:please\s+)?(?:supply|lend|deposit|save|earn on|put)\s+${AMOUNT}\s*${TOKEN}${VENUE}${END}`,
  'i'
)
const STAKE = new RegExp(
  String.raw`^(?:please\s+)?(?:liquid\s+)?stake\s+${AMOUNT}\s*${TOKEN}${VENUE}${END}`,
  'i'
)

/** Sentences that ask to do something, so a miss gets told what works rather than a guess. */
const ACTION_VERB =
  /\b(swap|convert|exchange|trade|buy|sell|supply|lend|deposit|save|earn|stake|borrow|cash out|send|bridge|long|short)\b/i

/** Plain decimal text: no separators, and a leading zero on ".5", which nothing downstream reads. */
function amountOf(text: string): string {
  const plain = text.replace(/,/g, '')
  return plain.startsWith('.') ? `0${plain}` : plain
}

/**
 * Reads a plain instruction into an action, or nothing.
 *
 * Deliberately a strict shape and not a guess. An instruction that moves money
 * and is read wrongly costs money, so anything looser falls through to being
 * told what works. Tokens and venues are checked on the server.
 */
export function parseChainAction(text: string): ChainActionRequest | null {
  const swap = SWAP.exec(text.trim())
  if (swap !== null) {
    return {
      kind: 'swap',
      amount: amountOf(swap[1] as string),
      tokenIn: swap[2] as string,
      tokenOut: swap[3] as string,
      venue: swap[4]?.trim(),
    }
  }
  const supply = SUPPLY.exec(text.trim())
  if (supply !== null) {
    return {
      kind: 'supply',
      amount: amountOf(supply[1] as string),
      tokenIn: supply[2] as string,
      venue: supply[3]?.trim(),
    }
  }
  const stake = STAKE.exec(text.trim())
  if (stake !== null) {
    return {
      kind: 'stake',
      amount: amountOf(stake[1] as string),
      tokenIn: stake[2] as string,
      venue: stake[3]?.trim(),
    }
  }
  return null
}

export function looksLikeChainAction(text: string): boolean {
  return ACTION_VERB.test(text)
}
