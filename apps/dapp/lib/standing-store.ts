import type { StandingIntent } from './standing-intent'

/**
 * Where standing rules live between visits.
 *
 * A rule that vanishes on reload is not a standing rule, so this exists for
 * the same reason the chat history store does — and deliberately in the same
 * place, rather than on the server.
 *
 * That is a claim about honesty rather than convenience. A rule only fires
 * while something is watching it, and today the only watcher is an open
 * browser tab. Storing rules server-side would imply they fire without one,
 * which would be untrue until a server-side watcher exists. The store moves
 * when the watcher does.
 */

const STORAGE_KEY = 'intent.standing.v1'

/** Enough to be useful without letting the store grow unbounded. */
const MAX_RULES = 50

/** A rule plus what has happened to it since. */
export interface StoredRule extends StandingIntent {
  /** The transaction that executed the most recent firing. */
  lastTxHash?: string
}

function read(): StoredRule[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as StoredRule[]) : []
  } catch {
    // Private-mode browsers throw on access. The session still works; it
    // simply will not remember rules across reloads.
    return []
  }
}

function write(rules: StoredRule[]): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(rules.slice(0, MAX_RULES)))
  } catch {
    /* see read() */
  }
}

export function loadRules(chain: string): StoredRule[] {
  return read().filter((r) => r.chain === chain)
}

/** Records a rule, replacing any earlier version of it. */
export function saveRule(rule: StandingIntent): void {
  const existing = read().filter((r) => r.id !== rule.id)
  write([rule as StoredRule, ...existing])
}

/**
 * Records that a rule fired and what it produced.
 *
 * The hash is the point. A trigger firing is a decision; only a transaction
 * makes it a trade, and storing one without the other is how this app once
 * filled its history with settled rows that had never touched a network.
 *
 * A scheduled rule stays armed — a weekly buy is meant to recur, and marking
 * it spent on its first run would turn every recurring rule into a one-off.
 */
export function markFired(id: string, txHash: string): void {
  const all = read()
  const found = all.find((r) => r.id === id)
  if (found === undefined) return

  write(
    all.map((r) =>
      r.id === id
        ? {
            ...r,
            status: r.trigger.kind === 'schedule' ? 'armed' : 'fired',
            lastFiredAt: new Date().toISOString(),
            lastTxHash: txHash,
          }
        : r
    )
  )
}

/**
 * Stops a rule without erasing it.
 *
 * Kept rather than deleted so a user can see that a rule existed and was
 * stopped. A rule that silently disappears leaves them wondering whether it
 * fired.
 */
export function cancelRule(id: string): void {
  const all = read()
  if (!all.some((r) => r.id === id)) return
  write(all.map((r) => (r.id === id ? { ...r, status: 'cancelled' } : r)))
}

export function clearRules(chain: string): void {
  write(read().filter((r) => r.chain !== chain))
}

/** Rules still waiting on their condition, for the watcher to evaluate. */
export function armedRules(chain: string): StoredRule[] {
  return loadRules(chain).filter((r) => r.status === 'armed')
}
