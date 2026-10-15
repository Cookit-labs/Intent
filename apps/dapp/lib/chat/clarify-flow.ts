import type { ClarifyTurn } from '../clarify/clarify'

/**
 * The parts of asking a question first that do not need a page.
 */

/**
 * The stand-in for an assistant turn the user never saw: when a note on an open
 * intent is sent for rewriting, the open intent is the first user turn and this
 * is the reply between it and the note. It is not drawn.
 */
export const ACKNOWLEDGED = 'Understood.'

/** Assets and currencies a request can name. */
const TICKER = /\b(xlm|usdc|usd|eth|btc|wbtc|weth|cetes|eurc|naira|ngn)\b/gi

/** An instruction word. Matches the follow-up rule's own list, so the two agree. */
const ACTION =
  /\b(swap|buy|sell|convert|exchange|trade|send|pay|transfer|supply|lend|borrow|repay|withdraw|cash\s*out|cashout|off-?ramp\w*|long|short|accumulate|hedge|rebalance|stake|deposit)\b/i

/** Words that point back at something said before. */
const REFERENCE = /\b(it|that|those|them|these|same|again|half|rest|both|all of it|the other)\b/i

/**
 * Whether an instruction can go straight to the agents with no question.
 *
 * Asking costs a model round trip, which is wasted on "swap $2 of XLM to USDC".
 * A request is complete when it has an action, an amount and two different
 * assets (or an asset and a payout currency), and does not lean on an earlier
 * turn. Anything short of that goes to the clarifier, which may well answer
 * "ready" at once; the shortcut is only about not waiting for it when the
 * answer is plainly yes.
 */
export function isSelfContained(text: string, hasEarlierTurns: boolean): boolean {
  if (!ACTION.test(text)) return false
  if (!/\d/.test(text)) return false
  if (hasEarlierTurns && REFERENCE.test(text)) return false

  const named = new Set((text.match(TICKER) ?? []).map((t) => t.toLowerCase()))
  // "$2 worth of XLM to USDC": the dollar sign is an amount, and USDC a second asset.
  return named.size >= 2
}

/**
 * What to run when the clarifier could not be reached or ran out of questions:
 * everything the user said, in order, as one request. Their own words, not a
 * guess at what they meant.
 */
export function fallbackInstruction(turns: ClarifyTurn[]): string {
  return turns
    .filter((t) => t.role === 'user')
    .map((t) => t.content.trim())
    .filter((t) => t !== '')
    .join('. ')
}
