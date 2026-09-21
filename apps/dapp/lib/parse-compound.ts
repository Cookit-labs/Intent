import { DEFAULT_ANCHOR, isAnchorId } from './offramp/anchors'
import { parseIntent } from './parse-intent'
import type { ParsedIntent } from './parse-intent'

/**
 * Reading an intent that asks for two things in order.
 *
 * "Buy XLM with USDC, then deposit it into Blend" is one sentence describing
 * two actions, and every layer below this reads one action. The failure is not
 * that the second clause is ignored — it is worse than that. `detectType`
 * matches keywords anywhere in the string, so the *second* clause silently
 * reclassifies the first, and "buy XLM then lend it" parses as a liquidity
 * action that buys nothing.
 *
 * Splitting before the parser sees the text fixes both at the source. Each
 * clause is parsed independently by the existing parser, so a clause in a
 * sequence and the same clause alone produce identical results, and no keyword
 * can leak across the boundary.
 *
 * **Declining is the common and correct answer.** Most intents are one action.
 * This layers over `parseIntent` the way `parse-standing.ts` does, and follows
 * the same discipline: where the reading is ambiguous, return nothing and let
 * the single-action path handle it. Inventing a step the user did not ask for
 * is worse than missing one they did.
 */

/**
 * Words that mark a second action following the first.
 *
 * Bare `and` is included, and that needs justifying. It was deliberately left
 * out at first because "buy XLM and USDC" is a single purchase of two things,
 * and reading it as a sequence would invent a trade nobody asked for.
 *
 * But that reasoning only holds when `and` joins two *assets*. "Swap USDC to
 * XLM **and** supply it to Blend" is as plainly a sequence as the same sentence
 * with "then", and declining it told the user the app had not understood a
 * perfectly clear instruction — while the near-identical wording worked.
 *
 * What keeps the ambiguity safe is not this pattern but the check immediately
 * after the split: the second clause must name a lending action. "USDC" does
 * not, so the single-purchase reading survives; "supply it to Blend" does. A
 * marker alone never creates a sequence here.
 */
const SEQUENCE_MARKERS = /\b(?:and\s+then|then|after\s+that|afterwards|followed\s+by|and)\b/i

/**
 * What the follow-on action does.
 *
 * Two kinds. The vocabulary is deliberately narrow: a marker that matched
 * anything would turn every "then" into a second action, including the many
 * that are not one. Offramp is checked before lending, because "put it in my
 * bank" contains lending's "put it in" and the bank decides.
 */
export type FollowOnKind = 'lend' | 'offramp'

/**
 * An instruction to supply an asset already held, with no trade first.
 *
 * "Supply my XLM to Blend" parsed as a market buy of XLM — it would have
 * *bought* XLM rather than supplying what the account already holds, which is
 * worse than refusing it. The single-action parser assumes every intent is a
 * trade, and nothing in its vocabulary expresses "use what I have".
 */
export interface SupplyOnlyIntent {
  kind: 'supply-only'
  /** Ticker of the asset to supply. */
  asset: string
  /**
   * The size the user named. Absent means the whole balance.
   *
   * Read with `amountIsUsd`: "20 XLM" and "$20 of XLM" are different amounts of
   * the same asset, and supplying one where the other was meant moves roughly a
   * hundred times too much or too little.
   */
  amount?: string
  /** True when `amount` is dollars rather than units of the asset. */
  amountIsUsd?: boolean
  venue: string
}

/**
 * Words that name supplying to a lending pool.
 *
 * Inflected forms are matched explicitly rather than by stemming. "Followed by
 * supply**ing** it" is ordinary phrasing, and a list covering only the bare verb
 * declined it — which reads to the user as the app failing to understand a
 * perfectly clear instruction.
 */
const LEND_PHRASING =
  /\b(?:lend(?:s|ing)?|suppl(?:y|ies|ied|ying)|deposit(?:s|ed|ing)?|earn\s+yield|put\s+it\s+(?:in|into))\b/i

/** Venues the follow-on may name. */
const VENUE_PHRASING: [RegExp, string][] = [[/\bblend\b/i, 'blend']]

/**
 * Words that name sending the proceeds to fiat.
 *
 * "to my bank" is the common phrasing; "cash out" and "off-ramp" are the
 * jargon. "send" alone is not here: "send it to my friend" is a payment, and
 * the offramp reading needs the bank, the fiat, or the cash-out verb.
 */
const OFFRAMP_PHRASING =
  /\b(?:(?:to|into|in)\s+(?:my\s+)?bank(?:\s+account)?|cash\s*out|cash\s+it\s+out|off-?ramp(?:s|ed|ing)?|to\s+fiat|to\s+dollars|to\s+usd\b|the\s+dollars\s+to)/i

/** Anchors the offramp may name. Ids match `lib/offramp/anchors.ts`. */
const ANCHOR_PHRASING: [RegExp, string][] = [
  [/\bmoney\s*gram\b/i, 'moneygram'],
  [/\btest\s*anchor\b/i, 'testanchor'],
]

/** Which anchor the clause names, if any; the default when none is named. */
function detectAnchor(clause: string): string | null | undefined {
  for (const [pattern, id] of ANCHOR_PHRASING) {
    if (pattern.test(clause)) return id
  }
  // "via Coinbase", "through Wise": somewhere named that this app does not
  // integrate. Refused rather than sent to the default.
  const named = /\b(?:via|through|using|with|on)\s+([a-z]+)/i.exec(clause)?.[1]?.toLowerCase()
  const NOT_ANCHORS = new Set([
    'my',
    'the',
    'a',
    'an',
    'it',
    'this',
    'that',
    'bank',
    'fiat',
    'usd',
    'cash',
  ])
  if (named !== undefined && !NOT_ANCHORS.has(named) && !isAnchorId(named)) return null
  return undefined
}

export interface FollowOnAction {
  kind: FollowOnKind
  /** The venue named, or the only one integrated when none was. */
  venue: string
  /**
   * The asset to supply, when the text named one.
   *
   * Usually absent and deliberately so: "deposit **it**" refers to whatever the
   * first step produced, and the amount is not known until that step confirms.
   */
  asset?: string
}

export interface CompoundIntent {
  /** The first action, in the shape every existing caller already handles. */
  head: ParsedIntent
  /** What follows it. */
  followOn: FollowOnAction
  /** The clause each action was read from, for showing the user what was understood. */
  clauses: [string, string]
}

/**
 * Splits a sentence at a sequence marker, if it has exactly one usable split.
 *
 * Returns nothing when there is no marker, or when either side is too short to
 * be an action. A marker inside a single clause — "buy the token then" trailing
 * off — should not produce an empty second action.
 */
function splitClauses(text: string): [string, string] | undefined {
  const match = SEQUENCE_MARKERS.exec(text)
  if (match === null || match.index === undefined) return undefined

  const before = text
    .slice(0, match.index)
    .trim()
    .replace(/[,;]\s*$/, '')
  const after = text.slice(match.index + match[0].length).trim()

  // Both sides must carry enough to be an instruction. A bare fragment is a
  // sign the marker was punctuation rather than a sequence.
  if (before.length < 3 || after.length < 3) return undefined

  return [before, after]
}

/**
 * Words that are never a venue, however much they resemble one.
 *
 * "lend" is one character from "blend", so without this the fuzzy match below
 * would read the lending *verb* as the venue and supply somewhere the user
 * never named — from a sentence that names no venue at all.
 */
const NEVER_A_VENUE = new Set([
  'lend',
  'lends',
  'lending',
  'supply',
  'supplies',
  'supplied',
  'supplying',
  'deposit',
  'deposits',
  'deposited',
  'depositing',
  'stake',
  'staked',
  'staking',
  'earn',
  'yield',
  'protocol',
  'pool',
])

/** Edit distance, for recognising a venue somebody typed slightly wrong. */
function editDistance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  )

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const substitute = (rows[i - 1]?.[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1)
      rows[i]![j] = Math.min((rows[i - 1]?.[j] ?? 0) + 1, (rows[i]?.[j - 1] ?? 0) + 1, substitute)
    }
  }

  return rows[a.length]?.[b.length] ?? Math.max(a.length, b.length)
}

/**
 * Which venue the clause names, if any.
 *
 * Exact first, then near-misses. "Supply $20 worth of XLM to Blende protocol"
 * named Blend unmistakably to any reader, and an exact-match rule declined it —
 * so the sentence fell through to the trade parser and was executed as a swap,
 * which is a different instruction entirely.
 *
 * Two characters of tolerance, and only on words long enough for that to mean
 * something. Loose enough for a typo, tight enough that "Aave" is still refused
 * rather than silently redirected to a protocol the user did not choose.
 */
function detectVenue(clause: string): string | undefined {
  for (const [pattern, venue] of VENUE_PHRASING) {
    if (pattern.test(clause)) return venue
  }

  for (const word of clause.toLowerCase().match(/[a-z]+/g) ?? []) {
    if (word.length < 4 || NEVER_A_VENUE.has(word)) continue
    for (const [, venue] of VENUE_PHRASING) {
      if (editDistance(word, venue) <= 2) return venue
    }
  }

  return undefined
}

/**
 * Reads a two-step intent out of free text, or returns null.
 *
 * Null means "this is one action" and is the expected answer for most input.
 * The caller keeps using `parseIntent` unchanged in that case.
 */
export function parseCompoundIntent(
  raw: string,
  prices: Record<string, number> = {}
): CompoundIntent | null {
  const text = raw.trim()

  const clauses = splitClauses(text)
  if (clauses === null || clauses === undefined) return null

  const [first, second] = clauses

  // Offramp first: "put it in my bank" contains lending's phrasing, and the
  // bank is what the user meant.
  if (OFFRAMP_PHRASING.test(second)) {
    const anchor = detectAnchor(second)
    if (anchor === null) return null
    const head = parseIntent(first, prices)
    return {
      head,
      followOn: { kind: 'offramp', venue: anchor ?? DEFAULT_ANCHOR },
      clauses: [first, second],
    }
  }

  // The second clause must actually name a follow-on this app can perform.
  // "Buy XLM then tell me the price" splits cleanly and is not a sequence of
  // two trades; without this it would become one.
  if (!LEND_PHRASING.test(second)) return null

  const venue = detectVenue(second)
  // A named venue that is not integrated is a refusal rather than a
  // substitution. Silently supplying somewhere the user did not name would be
  // the worst possible reading of an explicit instruction.
  if (venue === undefined && /\bon\s+\w+/i.test(second)) {
    const namedSomewhere = /\b(?:on|to|into)\s+([a-z]+)/i.exec(second)
    const named = namedSomewhere?.[1]?.toLowerCase()
    const KNOWN_NON_VENUES = new Set(['it', 'that', 'the', 'a', 'an', 'my', 'this', 'them'])
    if (named !== undefined && !KNOWN_NON_VENUES.has(named)) return null
  }

  // The first clause is parsed alone, so no keyword from the second can reach
  // `detectType`. This is the fix for the hijack, not a workaround for it.
  const head = parseIntent(first, prices)

  const followOn: FollowOnAction = {
    kind: 'lend',
    venue: venue ?? 'blend',
  }

  return { head, followOn, clauses: [first, second] }
}

/**
 * Words naming an amount of an asset the account already holds.
 *
 * "my XLM" and "all my XLM" mean the whole balance; "500 XLM" names a figure.
 * The distinction matters because supplying everything and supplying a stated
 * amount are different instructions, and guessing between them moves funds the
 * user did not mean to move.
 */
const SUPPLY_TARGET =
  /(?:\b(all\s+(?:of\s+)?my|my)\s+([A-Za-z]{2,12})\b|\$\s*([\d,]+(?:\.\d+)?)\s*(?:worth\s+)?(?:of\s+)?([A-Za-z]{2,12})\b|\b([\d,]+(?:\.\d+)?)\s*(?:worth\s+)?(?:of\s+)?([A-Za-z]{2,12})\b)/i

/**
 * Reads "supply what I already hold" out of free text, or returns null.
 *
 * Deliberately narrow. It fires only when the sentence names a lending action
 * and *no* trade: anything mentioning a swap, a buy or a sell is a trade whose
 * proceeds may then be supplied, which `parseCompoundIntent` already handles.
 * Reading one as the other would either skip a trade the user asked for or
 * invent one they did not.
 */
export function parseSupplyOnlyIntent(
  raw: string,
  allowedSymbols: string[] = []
): SupplyOnlyIntent | null {
  const text = raw.trim()

  if (!LEND_PHRASING.test(text)) return null
  // A trade verb means the proceeds of something are being supplied, not an
  // existing balance.
  if (/\b(?:swap|buy|purchase|sell|convert|trade|exchange)\b/i.test(text)) return null

  const venue = detectVenue(text)
  // A venue this app does not integrate is refused rather than substituted.
  if (venue === undefined && /\b(?:on|to|into)\s+([a-z]+)/i.test(text)) {
    const named = /\b(?:on|to|into)\s+([a-z]+)/i.exec(text)?.[1]?.toLowerCase()
    const NOT_VENUES = new Set(['it', 'that', 'the', 'a', 'an', 'my', 'this', 'them', 'work'])
    if (named !== undefined && !NOT_VENUES.has(named)) return null
  }

  const match = SUPPLY_TARGET.exec(text)
  if (match === null) return null

  // Three shapes, in the order the pattern lists them: the whole balance, a
  // dollar figure, or a count of the asset itself.
  const wholeBalance = match[1] !== undefined
  const usdAmount = match[3]
  const symbol = (wholeBalance ? match[2] : (match[4] ?? match[6]))?.toUpperCase()
  if (symbol === undefined) return null

  // Checked against what the app can actually trade, so a typo becomes a
  // refusal rather than an instruction naming an asset that does not exist.
  // This also catches the filler words: without the allowlist, "supply $20
  // worth of XLM" once read as twenty units of an asset called "worth".
  if (allowedSymbols.length > 0 && !allowedSymbols.includes(symbol)) return null

  const rawAmount = wholeBalance ? undefined : (usdAmount ?? match[5])
  const amount = rawAmount?.replace(/,/g, '')

  return {
    kind: 'supply-only',
    asset: symbol,
    ...(amount !== undefined ? { amount } : {}),
    // A dollar figure has to be converted at the live price before anything is
    // supplied. Saying which unit this is beats the caller guessing.
    ...(amount !== undefined && usdAmount !== undefined ? { amountIsUsd: true } : {}),
    venue: venue ?? 'blend',
  }
}

/**
 * An instruction to withdraw USDC already held, with no trade first.
 *
 * Mirrors `parseSupplyOnlyIntent`. Narrow: it fires only when the sentence
 * names an offramp and no trade, and only for USDC — the one asset the
 * integrated anchors withdraw. "Withdraw my USDC from Blend" is refused,
 * because that is a lending withdrawal and reading it as a bank transfer
 * would send funds off-chain the user meant to keep.
 */
export interface OfframpOnlyIntent {
  kind: 'offramp-only'
  asset: 'USDC'
  /** Display units. Absent means the whole balance. */
  amount?: string
  venue: string
}

const OFFRAMP_TARGET =
  /(?:\b(all\s+(?:of\s+)?my|my)\s+usdc\b|\$\s*([\d,]+(?:\.\d+)?)\s*(?:worth\s+)?(?:of\s+)?usdc\b|\b([\d,]+(?:\.\d+)?)\s*(?:worth\s+)?(?:of\s+)?usdc\b)/i

export function parseOfframpOnlyIntent(raw: string): OfframpOnlyIntent | null {
  const text = raw.trim()

  const offrampVerb = /\b(?:withdraw(?:s|ing)?|cash\s*out|off-?ramp(?:s|ed|ing)?|send)\b/i
  if (
    !offrampVerb.test(text) ||
    !(OFFRAMP_PHRASING.test(text) || /\b(?:cash\s*out|off-?ramp)/i.test(text))
  ) {
    return null
  }
  if (/\b(?:swap|buy|purchase|sell|convert|trade|exchange)\b/i.test(text)) return null
  if (/\bfrom\s+blend\b|\bblend\b/i.test(text)) return null

  // Any asset but USDC is refused outright, before the amount is read.
  if (/\b(?:xlm|lumens?|eth|btc|wbtc|weth|cetes)\b/i.test(text)) return null

  const anchor = detectAnchor(text)
  if (anchor === null) return null

  const match = OFFRAMP_TARGET.exec(text)
  if (match === null) return null

  const wholeBalance = match[1] !== undefined
  const rawAmount = wholeBalance ? undefined : (match[2] ?? match[3])
  const amount = rawAmount?.replace(/,/g, '')

  return {
    kind: 'offramp-only',
    asset: 'USDC',
    ...(amount !== undefined ? { amount } : {}),
    venue: anchor ?? DEFAULT_ANCHOR,
  }
}
