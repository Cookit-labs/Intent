import { parseIntent } from './parse-intent'
import type { StandingIntent, Trigger } from './standing-intent'

/**
 * Recognising a rule rather than a trade.
 *
 * "Buy XLM" is an instruction to act now. "Buy XLM if it drops to $0.16" is a
 * rule about *when* to act, and reading the second as the first would execute
 * immediately at a price the user explicitly said they did not want.
 *
 * The hard distinction is not rule-versus-trade, it is rule-versus-limit.
 * "Buy below $0.16" and "buy if it drops to $0.16" read almost identically and
 * mean different things: the first is an order the network holds on its own
 * book, the second is a condition this app watches. Getting it wrong would
 * replace a real on-chain order with a browser-side promise, which is strictly
 * worse — so anything expressible as a resting order is left to be one.
 */

/** Words that make a sentence conditional rather than immediate. */
const CONDITIONAL = /\b(if|when|once|whenever)\b/i

/**
 * Words that name a resting order instead of a rule.
 *
 * Checked first and given priority. A limit order rests on Stellar's own book
 * and fills without this app running; a rule only fires while something is
 * watching. Where both readings are available, the one that does not depend on
 * us is the better answer.
 */
const LIMIT_PHRASING = /\b(below|above|under|over|at\s*\$)\b/i

const SCHEDULE_PATTERNS: [RegExp, number][] = [
  [/\bevery\s+(?:week|friday|monday|tuesday|wednesday|thursday|saturday|sunday)\b/i, 168],
  [/\bweekly\b/i, 168],
  [/\bevery\s+day\b/i, 24],
  [/\bdaily\b/i, 24],
  [/\bevery\s+(\d+)\s*hours?\b/i, 0],
  [/\bevery\s+(\d+)\s*days?\b/i, 0],
]

function detectSchedule(text: string): Trigger | null {
  for (const [pattern, fixedHours] of SCHEDULE_PATTERNS) {
    const m = pattern.exec(text)
    if (m === null) continue

    if (fixedHours > 0) return { kind: 'schedule', everyHours: fixedHours }

    const n = Number(m[1])
    if (!Number.isFinite(n) || n <= 0) continue
    // The two variable patterns differ only in unit.
    const hours = /days?/i.test(m[0]) ? n * 24 : n
    return { kind: 'schedule', everyHours: hours }
  }
  return null
}

/** "drops to $0.16", "hits $0.15", "rises to $0.30". */
const ABSOLUTE_LEVEL =
  /\b(drops?|falls?|dips?|hits?|reaches?|rises?|climbs?|goes?\s+(?:up|down))\b[^$\d]{0,12}\$?\s?([\d,]+(?:\.\d+)?)/i

/** "drops 10%", "falls by 5%". */
const PERCENT_MOVE = /\b(drops?|falls?|dips?|rises?|climbs?|gains?)\b(?:\s+by)?\s+([\d.]+)\s?%/i

const DOWNWARD = /\b(drops?|falls?|dips?|down)\b/i

function detectPriceTrigger(
  text: string,
  asset: string,
  prices: Record<string, number>
): Trigger | null {
  const percent = PERCENT_MOVE.exec(text)
  if (percent !== null) {
    const reference = prices[asset]
    // A percentage is meaningless without a level to apply it to. Declining
    // beats guessing: a rule armed at the wrong price trades at a level the
    // user never agreed to, and they would not find out until it fired.
    if (reference === undefined || !Number.isFinite(reference)) return null

    const pct = Number(percent[2]) / 100
    const down = DOWNWARD.test(percent[1] ?? '')
    const level = down ? reference * (1 - pct) : reference * (1 + pct)
    return {
      kind: down ? 'price_below' : 'price_above',
      asset,
      // Rounded to the precision prices are quoted at, so the stored level
      // matches what the user would read back.
      priceUsd: Number(level.toFixed(7)),
    }
  }

  const absolute = ABSOLUTE_LEVEL.exec(text)
  if (absolute !== null) {
    const level = Number((absolute[2] ?? '').replace(/,/g, ''))
    if (!Number.isFinite(level) || level <= 0) return null

    const verb = absolute[1] ?? ''
    // "hits" and "reaches" name a level without a direction, so the direction
    // comes from the trade: someone buying is waiting for a fall, someone
    // selling for a rise. Guessing the other way would arm the rule to fire
    // immediately, which is the opposite of what waiting means.
    const DIRECTIONLESS = /\b(hits?|reaches?)\b/i
    const BUYING = /\bbuy\b/i

    return {
      kind: DIRECTIONLESS.test(verb)
        ? BUYING.test(text)
          ? 'price_below'
          : 'price_above'
        : DOWNWARD.test(verb)
          ? 'price_below'
          : 'price_above',
      asset,
      priceUsd: level,
    }
  }

  return null
}

/**
 * Reads a standing rule out of free text, or returns null.
 *
 * Null is the common and correct answer: most intents are trades. Returning a
 * rule for an ordinary swap would delay execution the user expected
 * immediately.
 */
export function parseStandingIntent(
  raw: string,
  prices: Record<string, number> = {},
  chain = 'stellar'
): StandingIntent | null {
  const text = raw.trim()

  // A schedule is unambiguous — nothing about "every week" describes a
  // resting order — so it is checked before the limit-order guard.
  const schedule = detectSchedule(text)

  if (schedule === null) {
    if (!CONDITIONAL.test(text)) return null
    // Left to be a real order on the book. See the note above LIMIT_PHRASING.
    if (LIMIT_PHRASING.test(text)) return null
  }

  // The action is parsed by the existing intent parser, so a rule and a trade
  // describe their assets and amounts the same way.
  const parsed = parseIntent(text, prices)

  // The asset the condition is *about* is the volatile one, which on a sell is
  // what leaves the account rather than what arrives. "Sell XLM if it rises"
  // is a statement about XLM, and reading it as a statement about the
  // stablecoin it converts to would watch a price that never moves.
  const STABLE = new Set(['USDC', 'USDT'])
  const watched = STABLE.has(parsed.input.tokenOut) ? parsed.input.tokenIn : parsed.input.tokenOut

  const trigger = schedule ?? detectPriceTrigger(text, watched, prices)
  if (trigger === null) return null

  return {
    id: `si_${Date.now().toString(36)}`,
    chain,
    text,
    createdAt: new Date().toISOString(),
    trigger,
    action: {
      kind: 'swap',
      from: parsed.input.tokenIn,
      to: parsed.input.tokenOut,
      amountIn: parsed.input.amountIn,
    },
    status: 'armed',
  }
}
