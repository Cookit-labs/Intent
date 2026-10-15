/**
 * Fixes a misspelled instruction word before anything tries to read the
 * sentence.
 *
 * "edge 5 USDC exposure" is "hedge" with a letter missing, and the regex
 * reading of it is a buy of ETH, which does not exist here. A verb one edit
 * away from a known one is corrected; anything further, or a word that is
 * itself a real word the user may have meant, is left for the clarifier.
 */

const VERBS = [
  'swap',
  'buy',
  'sell',
  'convert',
  'exchange',
  'trade',
  'send',
  'transfer',
  'supply',
  'lend',
  'borrow',
  'repay',
  'withdraw',
  'hedge',
  'rebalance',
  'accumulate',
  'cashout',
  'offramp',
]

/** Words one edit from a verb that are real words in their own right. */
const KEEP = new Set(['sale', 'sand', 'bay', 'bus', 'bur', 'send', 'sent', 'lens', 'lent', 'end'])

function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true
  if (Math.abs(a.length - b.length) > 1) return false
  let i = 0
  let j = 0
  let edits = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1
      j += 1
      continue
    }
    edits += 1
    if (edits > 1) return false
    if (a.length > b.length) i += 1
    else if (a.length < b.length) j += 1
    else {
      i += 1
      j += 1
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1
}

/** The sentence with its first word corrected to the instruction verb it is one typo from. */
export function fixVerbTypo(text: string): string {
  const match = /^(\s*)([A-Za-z]{3,10})\b/.exec(text)
  if (match === null) return text
  const word = (match[2] as string).toLowerCase()
  if (VERBS.includes(word) || KEEP.has(word)) return text

  const candidates = VERBS.filter((v) => v.length >= 4 && withinOneEdit(word, v))
  // Two different verbs equally close is a guess; leave it to be asked.
  if (candidates.length !== 1) return text

  const fixed = candidates[0] as string
  const cased = (match[2] as string)[0] === (match[2] as string)[0]?.toUpperCase()
  const replacement = cased ? fixed[0]?.toUpperCase() + fixed.slice(1) : fixed
  return `${match[1] ?? ''}${replacement}${text.slice(match[0].length)}`
}
