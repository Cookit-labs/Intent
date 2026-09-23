import {
  cancelRuleRemote,
  listRulesRemote,
  reportFiredRemote,
  saveRuleRemote,
} from './api/standing-client'
import type { StandingIntent } from './standing-intent'

/**
 * Where standing rules live between visits.
 *
 * **The server is the record; this cache is a convenience.** Rules used to
 * live only here, in localStorage, and the file said why: a rule only fires
 * while something is watching it, and the only watcher was an open tab, so
 * storing rules server-side would have implied they fire without one. That
 * watcher now exists — a scheduled tick evaluates every armed rule against
 * live prices — and the store has moved with it, as promised.
 *
 * The local copy is kept because the call sites are synchronous and the
 * panel should not blank while a request is in flight. It is refilled from
 * the server by `syncRules`. Nothing depends on it surviving.
 *
 * Writes are fire-and-forget, as they are for chat history. The local copy is
 * written first and the server told after; a failure is logged rather than
 * thrown, and the next `syncRules` reconciles. A rule that the user has just
 * set up must not fail to appear because a request did.
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
    // Private-mode browsers throw on access. The server still has everything;
    // only the instant read is lost.
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

/**
 * Reports a failed sync without breaking the caller.
 *
 * A rule the user just wrote must not be reported as failed because its
 * record did not reach the server. The local copy already holds it and the
 * next `syncRules` reconciles, so this is a warning rather than an error.
 */
function reportSyncFailure(what: string, e: unknown): void {
  // eslint-disable-next-line no-console
  console.warn(`[standing] ${what} was not saved to the server:`, e)
}

/**
 * Replaces the local cache with what the server holds.
 *
 * The server's status wins: a rule the tick fired while no tab was open is
 * `fired` there and still `armed` here, and the point of syncing is to learn
 * that. Two things are kept from the local copy — the transaction hash of an
 * execution, which the server does not store, and any rule the server has
 * not seen, because a save made moments ago may still be in flight.
 */
export async function syncRules(chain: string, wallet?: string): Promise<StoredRule[]> {
  let remote: Awaited<ReturnType<typeof listRulesRemote>>
  try {
    remote = await listRulesRemote(chain, wallet)
  } catch (e) {
    reportSyncFailure('the rule list', e)
    return loadRules(chain)
  }

  const local = read()
  const byId = new Map<string, StoredRule>()
  for (const record of remote) {
    const mine = local.find((r) => r.id === record.id)
    byId.set(record.id, {
      ...record.rule,
      ...(mine?.lastTxHash !== undefined ? { lastTxHash: mine.lastTxHash } : {}),
    })
  }
  for (const rule of local) {
    if (!byId.has(rule.id)) byId.set(rule.id, rule)
  }

  const merged = [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  write(merged)
  return merged.filter((r) => r.chain === chain)
}

export function loadRules(chain: string): StoredRule[] {
  return read().filter((r) => r.chain === chain)
}

/**
 * Records a rule, replacing any earlier version of it, locally and on the
 * server.
 *
 * The wallet is the account the rule would trade from. It is sent so the
 * server can scope the list to it; a rule made before a wallet is connected
 * is filed under an empty one.
 */
export function saveRule(rule: StandingIntent, wallet = ''): void {
  const existing = read().filter((r) => r.id !== rule.id)
  write([rule as StoredRule, ...existing])

  void saveRuleRemote(rule, wallet).catch((e) => reportSyncFailure('a rule', e))
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
 *
 * The server is told the firing was executed: the tick must not fire it
 * again, and there is nothing to email or to show in the inbox for a trade
 * the user just signed.
 */
export function markFired(id: string, txHash: string): void {
  const all = read()
  const found = all.find((r) => r.id === id)
  if (found === undefined) return

  const at = new Date().toISOString()
  write(
    all.map((r) =>
      r.id === id
        ? {
            ...r,
            status: r.trigger.kind === 'schedule' ? 'armed' : 'fired',
            lastFiredAt: at,
            lastTxHash: txHash,
          }
        : r
    )
  )

  void reportFiredRemote(id, { at, executed: true }).catch((e) =>
    reportSyncFailure('an execution', e)
  )
}

/**
 * Tells the server a rule came due in this tab.
 *
 * The in-tab watcher and the tick judge the same rules against the same
 * prices, so whichever sees the condition first reports it and the other
 * finds the rule already fired. Without this the tick would prompt a second
 * time, by email, for a rule the user is already looking at. The local copy
 * is untouched: locally a rule is "due" until it is signed or synced.
 */
export function reportDue(id: string, price: number | undefined, at: Date): void {
  void reportFiredRemote(id, {
    at: at.toISOString(),
    ...(price !== undefined ? { price } : {}),
  }).catch((e) => reportSyncFailure('a firing', e))
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

  void cancelRuleRemote(id).catch((e) => reportSyncFailure('a cancellation', e))
}

/**
 * Forgets a chain's rules locally and stops them on the server.
 *
 * Stopped rather than deleted there, for the reason above; a cleared rule
 * must not come back armed on the next sync.
 */
export function clearRules(chain: string): void {
  const all = read()
  write(all.filter((r) => r.chain !== chain))

  for (const rule of all) {
    if (rule.chain !== chain || rule.status !== 'armed') continue
    void cancelRuleRemote(rule.id).catch((e) => reportSyncFailure('a cancellation', e))
  }
}

/** Rules still waiting on their condition, for the watcher to evaluate. */
export function armedRules(chain: string): StoredRule[] {
  return loadRules(chain).filter((r) => r.status === 'armed')
}
