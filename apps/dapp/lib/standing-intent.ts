/**
 * Intents that outlive the moment they were created.
 *
 * An intent currently dies at its deadline: it fills while the user is
 * watching, or it expires. A standing intent is a different thing — "if XLM
 * drops 10%, buy" is not a trade, it is a rule about when to trade, and it is
 * the difference between a tool you visit and one that works while you sleep.
 *
 * **Deciding is not executing.** A trigger firing means the condition was met.
 * Nothing has moved until a transaction is signed and confirmed. That
 * distinction is load-bearing here: this app once marked every intent settled
 * on a fourteen-second timer, filling history with completed trades that never
 * happened, and a trigger that advanced state by itself would recreate exactly
 * that fiction with a more convincing story attached.
 *
 * So everything in this file answers one question — *should this fire now?* —
 * and nothing in it moves funds.
 */

export type TriggerKind = 'price_below' | 'price_above' | 'schedule'

/** Fires when an asset trades at or beyond a price. */
export interface PriceTrigger {
  kind: 'price_below' | 'price_above'
  asset: string
  priceUsd: number
}

/** Fires on an interval, regardless of price. */
export interface ScheduleTrigger {
  kind: 'schedule'
  everyHours: number
}

export type Trigger = PriceTrigger | ScheduleTrigger

/** What to do when it fires. Deliberately narrow: a rule, not a program. */
export interface StandingAction {
  kind: 'swap'
  from: string
  to: string
  /** Display units of `from`. */
  amountIn: string
}

export type StandingStatus = 'armed' | 'fired' | 'cancelled' | 'expired'

export interface StandingIntent {
  id: string
  chain: string
  /** What the user typed, kept so the rule can be shown as they expressed it. */
  text: string
  createdAt: string
  trigger: Trigger
  action: StandingAction
  status: StandingStatus
  /** After this, the rule stops watching. Absent means it watches indefinitely. */
  expiresAt?: string
  /** Set each time a scheduled intent fires, so the next interval is measured from it. */
  lastFiredAt?: string
}

export interface TriggerEvaluation {
  fires: boolean
  /** Why not, when it does not. Shown to the user rather than logged and lost. */
  reason?: string
}

/**
 * Whether a standing intent should fire right now.
 *
 * Pure, and takes the clock as an argument, so the decision is reproducible
 * and testable without waiting for real time to pass. Every reason for *not*
 * firing is returned rather than collapsed into a bare false — "no price
 * available" and "the market has not reached your level" are very different
 * things to show someone waiting on a rule.
 */
export function evaluateTrigger(
  intent: StandingIntent,
  prices: Record<string, number>,
  now: Date = new Date()
): TriggerEvaluation {
  if (intent.status === 'cancelled') {
    return { fires: false, reason: 'This rule was cancelled.' }
  }

  // A one-off condition fires once. Without this, "if it drops, buy" would
  // trade repeatedly for as long as the price stayed there — which is not what
  // anybody means by that sentence.
  if (intent.status === 'fired' && intent.trigger.kind !== 'schedule') {
    return { fires: false, reason: 'This rule has already run.' }
  }

  if (intent.expiresAt !== undefined && now.getTime() > new Date(intent.expiresAt).getTime()) {
    return { fires: false, reason: 'This rule has expired.' }
  }

  if (intent.trigger.kind === 'schedule') {
    return evaluateSchedule(intent, intent.trigger, now)
  }

  const price = prices[intent.trigger.asset]
  if (price === undefined || !Number.isFinite(price)) {
    // Missing data is not a signal. Firing on an absent price would mean
    // trading on the failure of a price feed rather than on the market.
    return { fires: false, reason: `No price available for ${intent.trigger.asset}.` }
  }

  const met =
    intent.trigger.kind === 'price_below'
      ? price <= intent.trigger.priceUsd
      : price >= intent.trigger.priceUsd

  if (!met) {
    const direction = intent.trigger.kind === 'price_below' ? 'above' : 'below'
    return {
      fires: false,
      reason: `${intent.trigger.asset} is ${price}, still ${direction} your ${intent.trigger.priceUsd} level.`,
    }
  }

  return { fires: true }
}

function evaluateSchedule(
  intent: StandingIntent,
  trigger: ScheduleTrigger,
  now: Date
): TriggerEvaluation {
  const due = nextFireAt(intent)
  // A rule that has never fired is due immediately: the user set it up to
  // start, not to wait one interval before starting.
  if (due === null) return { fires: true }

  if (now.getTime() < due.getTime()) {
    return { fires: false, reason: `Next due ${due.toISOString()}.` }
  }
  void trigger
  return { fires: true }
}

/**
 * When a scheduled intent is next due.
 *
 * Null when it has never fired, which reads as "now". Measured from the last
 * firing rather than from creation, so a rule that ran late does not then fire
 * twice in quick succession catching up.
 */
export function nextFireAt(intent: StandingIntent): Date | null {
  if (intent.trigger.kind !== 'schedule') return null
  if (intent.lastFiredAt === undefined) return null

  const last = new Date(intent.lastFiredAt).getTime()
  return new Date(last + intent.trigger.everyHours * 3_600_000)
}

/**
 * A short description of the rule, in the user's terms.
 *
 * Shown in a list where the original sentence may be long. "Buy 50 USDC of XLM
 * when it falls to $0.16" is a rule someone can verify at a glance; a row
 * saying "standing intent, armed" is not.
 */
export function describeTrigger(intent: StandingIntent): string {
  const { trigger, action } = intent
  const what = `${action.amountIn} ${action.from} → ${action.to}`

  switch (trigger.kind) {
    case 'price_below':
      return `${what} when ${trigger.asset} falls to $${trigger.priceUsd}`
    case 'price_above':
      return `${what} when ${trigger.asset} rises to $${trigger.priceUsd}`
    case 'schedule': {
      const hours = trigger.everyHours
      const every =
        hours % 168 === 0
          ? `${hours / 168} week${hours === 168 ? '' : 's'}`
          : hours % 24 === 0
            ? `${hours / 24} day${hours === 24 ? '' : 's'}`
            : `${hours} hours`
      return `${what} every ${every}`
    }
  }
}
