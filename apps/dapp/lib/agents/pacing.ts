/**
 * When to reveal an agent's card.
 *
 * The original race used fixed delays, which worked because the proposals were
 * constants. Real calls return in unpredictable order at unpredictable speed,
 * and revealing on arrival produces one of two bad outcomes: all four landing
 * at once (no race at all), or one straggler leaving a gap with nothing on
 * screen.
 *
 * So the old delays become *floors* rather than a schedule. An agent that
 * answers quickly still waits its turn, and one that answers late appears the
 * moment it can. Fast responses look like the original animation; slow ones
 * degrade to a single card still thinking.
 *
 * Kept as a pure function so it can be tested without rendering anything — the
 * vitest config only picks up `.ts` files.
 */

export interface RevealPlan {
  /** Milliseconds from race start at which this agent should appear. */
  revealAtMs: number
  /** Milliseconds to wait from now. Zero when the floor has already passed. */
  delayMs: number
}

export function planReveal(floorMs: number, elapsedMs: number): RevealPlan {
  const revealAtMs = Math.max(floorMs, elapsedMs)
  return { revealAtMs, delayMs: Math.max(0, floorMs - elapsedMs) }
}

/** Between talk messages that arrive together, so they read as a conversation. */
const TALK_GAP_MS = 700
/** The same gap once showing them that way would run past the close. */
const TALK_GAP_LATE_MS = 150
/** When talk closes, in ms from the start. */
export const TALK_CLOSE_MS = 20_000

/**
 * When the next talk item shows, in ms from the start. Never before now, since
 * nothing is shown ahead of having happened. Falling behind tightens the gap
 * rather than dropping anything, so final strategies stay near the close.
 */
export function planTalkReveal(
  lastRevealMs: number,
  elapsedMs: number,
  closeMs: number = TALK_CLOSE_MS
): number {
  const next = lastRevealMs + TALK_GAP_MS
  return Math.max(next > closeMs ? lastRevealMs + TALK_GAP_LATE_MS : next, elapsedMs)
}

/** Between final cards, once the talk they follow has been shown. */
const FINAL_GAP_MS = 400

/** When the next final card shows, in ms from the start: after whatever was shown last. */
export function planFinalReveal(lastRevealMs: number, elapsedMs: number): number {
  return Math.max(lastRevealMs + FINAL_GAP_MS, elapsedMs)
}

/**
 * When the winner may be announced: never before the scripted decision point,
 * and never on top of the last card appearing.
 */
export function planDecision(decideAtMs: number, lastRevealMs: number, minGapMs = 400): number {
  return Math.max(decideAtMs, lastRevealMs + minGapMs)
}
