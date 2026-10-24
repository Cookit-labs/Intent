/**
 * The conversation around an intent.
 *
 * A chat used to hold exactly one intent: sending anything replaced it, so
 * nothing could be continued, added to, or referred back to. These are the
 * pieces that make it a thread, kept pure so the rules can be read and tested
 * without a page.
 */

export interface ThreadTurn {
  id: string
  /** What the user typed. */
  text: string
  /** Whether a transaction came out of it, or the intent was only placed. */
  executed: boolean
  /** Whether it asked for something to happen, as opposed to a question. */
  attempted?: boolean
  /** What was said back, kept so the chat shows both sides once the turn is behind it. */
  reply?: { text: string; agentKey?: string; agentName?: string }
}

export type FollowUpKind = 'note' | 'new'

/** Words that start an instruction rather than adjust one. */
const ACTION =
  /\b(swap|buy|sell|convert|exchange|trade|send|pay|transfer|supply|lend|borrow|repay|withdraw|cash\s*out|cashout|off-?ramp\w*|long|short|accumulate|hedge|rebalance|stake|deposit)\b/i

/** Something an instruction is about: an amount with a unit, or a named asset or currency. */
const SUBJECT =
  /(\$\s*\d|\d+(?:\.\d+)?\s*(?:xlm|usdc|usd|eth|btc|cetes|naira|ngn)\b|\b(?:xlm|usdc|usd|eth|btc|cetes|naira|ngn)\b)/i

/**
 * Whether a message sent while an intent is still open adds to it or starts
 * another.
 *
 * "use a lower slippage", "make it $5", "only Soroswap" refine the intent in
 * front of the user; "swap 5 USDC to XLM" is a different instruction. A verb
 * plus a subject is a new intent. Anything else is a note, because replacing
 * an open intent on a guess would throw away agents' answers the user may
 * still want, and a note that was meant as a new intent costs only a second
 * message.
 */
export function classifyFollowUp(text: string): FollowUpKind {
  return ACTION.test(text) && SUBJECT.test(text) ? 'new' : 'note'
}

/** How many earlier turns are carried into the next one. */
const CONTEXT_TURNS = 2

/**
 * What the agents are told about the conversation so far, one line each.
 *
 * Earlier turns are named as earlier and as done or not, so an agent does not
 * mistake a finished trade for a pending one. Notes are the user's own
 * additions to the intent in front of them.
 */
export function raceContext(turns: ThreadTurn[], notes: string[]): string[] {
  const earlier = turns
    .slice(-CONTEXT_TURNS)
    .map((t) => `Earlier in this chat (${t.executed ? 'done' : 'not executed'}): ${t.text}`)
  const added = notes.map((n) => `The user added: ${n}`)
  return [...earlier, ...added]
}
