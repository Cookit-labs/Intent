/**
 * "All my USDC", "half my SOL", "100% of my AVAX": a share of what the wallet holds, worked out
 * from the balance read now and written into the sentence as a number, so every path after this
 * reads an amount the person can check, and nothing guesses one.
 */

export interface FoundShare {
  /** The words that said the share, as typed. */
  phrase: string
  percent: number
  /** The coin it is a share of, as typed. */
  word: string
}

const OF_MY = String.raw`(?:\s+(?:of|in))?\s*(?:my|the)?\s*`
const COIN = String.raw`([a-z][a-z0-9.]{1,11})`

const PATTERNS: { re: RegExp; percent: (m: RegExpExecArray) => number }[] = [
  {
    re: new RegExp(String.raw`(\d{1,3}(?:\.\d+)?)\s*(?:%|percent|per cent)${OF_MY}${COIN}\b`, 'i'),
    percent: (m) => Number(m[1]),
  },
  {
    re: new RegExp(String.raw`\b(?:all|everything|max|maximum)${OF_MY}${COIN}\b`, 'i'),
    percent: () => 100,
  },
  {
    re: new RegExp(String.raw`\bmy\s+(?:entire|whole|full)\s+${COIN}\b`, 'i'),
    percent: () => 100,
  },
  { re: new RegExp(String.raw`\bhalf${OF_MY}${COIN}\b`, 'i'), percent: () => 50 },
  { re: new RegExp(String.raw`\ba\s+quarter${OF_MY}${COIN}\b`, 'i'), percent: () => 25 },
]

/** Words that follow "all" or "everything" and are not a coin. */
const NOT_A_COIN = new Set([
  'this',
  'that',
  'it',
  'them',
  'these',
  'those',
  'is',
  'are',
  'of',
  'the',
])

export function findShare(text: string): FoundShare | undefined {
  for (const { re, percent } of PATTERNS) {
    const match = re.exec(text)
    if (match === null) continue
    const word = match[match.length - 1] ?? ''
    const share = percent(match)
    if (NOT_A_COIN.has(word.toLowerCase())) continue
    if (!(share > 0 && share <= 100)) return undefined
    return { phrase: match[0], percent: share, word }
  }
  return undefined
}

/** The share of an amount held, rounded down to the places it is held in. Nothing when it is zero. */
export function unitsForShare(held: string, percent: number): string | undefined {
  if (!/^\d+(?:\.\d+)?$/.test(held)) return undefined
  const [whole = '0', given = ''] = held.split('.')
  // At least six places, so a share of a whole number still has somewhere to go.
  const fraction = given.padEnd(6, '0')
  const places = fraction.length
  const base = BigInt(whole + fraction)
  // Percent to two places, as an integer, so the sum stays exact.
  const hundredths = BigInt(Math.round(percent * 100))
  const part = (base * hundredths) / BigInt(10000)
  if (part <= BigInt(0)) return undefined
  const digits = part.toString().padStart(places + 1, '0')
  if (places === 0) return digits
  const text = `${digits.slice(0, -places)}.${digits.slice(-places)}`
  return text.replace(/\.?0+$/, '')
}

/**
 * A bare answer to "how much USDC?", such as "all", "half" or "50%", as a share of that coin, so
 * it can be read like any other. Any other answer is left as it was.
 */
export function shareOfCoin(answer: string, coin: string): string {
  const bare = answer
    .trim()
    .replace(/[.!]+$/, '')
    .toLowerCase()
  if (/^(?:all|all of it|everything|max|maximum|the whole lot)$/.test(bare)) {
    return `all of my ${coin}`
  }
  if (/^half(?: of it)?$/.test(bare)) return `half of my ${coin}`
  const percent = /^(\d{1,3}(?:\.\d+)?)\s*(%|percent)$/.exec(bare)
  if (percent !== null) return `${percent[1]}${percent[2] === '%' ? '%' : ' percent'} of my ${coin}`
  return answer
}

function shareWords(percent: number): string {
  return percent === 100 ? 'all' : `${percent}%`
}

/**
 * The sentence with the share as a number of the coin, and a line saying how it was worked out;
 * a refusal when the wallet holds none of it; nothing when no share was said.
 */
export function sizeShare(
  text: string,
  held: Readonly<Record<string, string>>
): { text: string; line: string } | { refusal: string } | undefined {
  const found = findShare(text)
  if (found === undefined) return undefined
  const symbol = found.word.toUpperCase()
  const key = Object.keys(held).find((k) => k.toUpperCase() === symbol)
  const units = key === undefined ? undefined : unitsForShare(held[key] as string, found.percent)
  if (units === undefined) {
    return {
      refusal: `Your wallet holds no ${symbol} here, so there is nothing to take ${shareWords(found.percent)} of. Nothing was signed or sent.`,
    }
  }
  return {
    text: text.replace(found.phrase, `${units} ${symbol}`),
    line: `${found.percent}% of your ${symbol} is ${units} ${symbol}.`,
  }
}
