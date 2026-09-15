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
 * Only lending, today. The vocabulary is deliberately narrow: a marker that
 * matched anything would turn every "then" into a second action, including the
 * many that are not one.
 */
export type FollowOnKind = 'lend'

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

/** Which venue the clause names, if any. */
function detectVenue(clause: string): string | undefined {
  for (const [pattern, venue] of VENUE_PHRASING) {
    if (pattern.test(clause)) return venue
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
