import type { AgentProposalView } from './agents/competition'

import { listTurns, saveTurnRemote, updateTurnRemote } from './api/conversation-client'

/**
 * Past conversations, kept across reloads — and across devices.
 *
 * **The database is the record; this cache is a convenience.** Turns used to
 * live only in `localStorage`, which meant a trade's history — which agent won,
 * what it reasoned, which transactions a bundled intent produced — existed only
 * in the browser that made it. Clearing site data destroyed it and a second
 * device never had it. A transaction that really happened must not be
 * recoverable only from the machine that submitted it.
 *
 * Every write now goes to the server. The local copy is kept because the call
 * sites are synchronous and a history panel should not blank while a request is
 * in flight, but it is a read-through cache, refilled from the server whenever
 * `syncTurns` runs. Nothing depends on it surviving.
 *
 * Writes are fire-and-forget by design. A failed sync must not block a trade
 * that already settled on-chain, so the local copy is written first and the
 * server is told after; a failure is logged rather than thrown, and the next
 * `syncTurns` reconciles.
 */

export interface ChatTurn {
  id: string
  chain: string
  /** What the user typed. */
  text: string
  createdAt: string
  /** Each agent's proposal, keyed by strategy. */
  proposals: Record<string, AgentProposalView>
  winner: string | null
  /**
   * Each agent's executable route, keyed by strategy.
   *
   * Kept so a reopened conversation can still be signed. Without it, restoring
   * a turn would show proposals with no way to act on them, which is a
   * transcript rather than a conversation.
   */
  routesByAgent?: Record<string, unknown>
  /** Set once a swap from this conversation settles. */
  txHash?: string
  /** Which agent the user chose, when they chose one. */
  executedBy?: string
  /**
   * The steps of a bundled intent, when this turn was one.
   *
   * A bundle is several transactions fulfilling a single instruction, and
   * listing it as "swap" would describe only its first third. Each entry keeps
   * its own hash, so the row can link to every transaction rather than to
   * whichever one happened to settle first.
   */
  bundle?: BundleStep[]
}

/** One transaction inside a bundled intent. */
export interface BundleStep {
  /** What this step did, in words. */
  label: string
  hash?: string
  /** Where the transaction can be seen. */
  explorerUrl?: string
  /**
   * Where the *result* can be seen, when that is a different protocol.
   *
   * A supply's explorer link proves the transaction happened; the position it
   * created lives in the lending protocol's own interface, and that is what
   * someone tracking a bundle actually wants to open.
   */
  positionUrl?: string
  /** The protocol this step touched, for labelling its link. */
  venue?: string
  /**
   * The anchor's side of an offramp step, when this step was one.
   *
   * The transaction hash proves the payment; it says nothing about whether
   * the anchor has paid out. That lives with the anchor, under this id, and
   * is what someone tracking a withdrawal actually wants.
   */
  anchor?: { id: string; transactionId: string; moreInfoUrl?: string; lastStatus?: string }
}

const STORAGE_KEY = 'intent.chat.v1'

/**
 * Enough to look back over a session's work without letting the cache grow
 * without bound. Matches the server's own cap, so switching between them does
 * not change how far back a list reaches.
 */
const MAX_TURNS = 50

function read(): ChatTurn[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as ChatTurn[]) : []
  } catch {
    // Private-mode browsers throw on access. The server still has everything;
    // only the instant read is lost.
    return []
  }
}

function write(turns: ChatTurn[]): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(turns.slice(0, MAX_TURNS)))
  } catch {
    /* see read() */
  }
}

/**
 * Who to tell when the stored turns change.
 *
 * Open positions reads withdrawals out of history, and the chat writes them
 * there — two components with no parent holding the list, so a withdrawal
 * settled in this session did not appear until a reload. A module-level
 * notification is the smallest thing that closes that: no context, no store,
 * and nothing to keep in sync beyond "the rows changed, read them again".
 */
type TurnsListener = () => void
const turnsListeners = new Set<TurnsListener>()

export function onTurnsChanged(listener: TurnsListener): () => void {
  turnsListeners.add(listener)
  return () => {
    turnsListeners.delete(listener)
  }
}

function notifyTurnsChanged(): void {
  for (const listener of turnsListeners) {
    try {
      listener()
    } catch {
      // A listener that throws must not stop the others, and must never fail
      // the write that has already happened.
    }
  }
}

/**
 * Reports a failed sync without breaking the caller.
 *
 * A trade that settled on-chain must not be reported as failed because its
 * record did not reach the server. The local copy already holds it and the next
 * `syncTurns` reconciles, so this is a warning rather than an error.
 */
function reportSyncFailure(what: string, e: unknown): void {
  // eslint-disable-next-line no-console
  console.warn(`[history] ${what} was not saved to the server:`, e)
}

/**
 * Replaces the local cache with what the server holds.
 *
 * Called when a history view opens, so a fresh browser — or a cleared one —
 * shows the trades this wallet actually made rather than an empty list.
 * Returns what it loaded, so a caller can render without a second read.
 */
export async function syncTurns(chain: string): Promise<ChatTurn[]> {
  let remote: ChatTurn[]
  try {
    remote = await listTurns(chain)
  } catch (e) {
    reportSyncFailure('history', e)
    return loadTurns(chain)
  }

  // Merged rather than replaced. A turn recorded moments ago may not have
  // reached the server yet, and dropping it here would make it vanish from the
  // panel it was just added to.
  const byId = new Map(remote.map((t) => [t.id, t]))
  for (const local of read()) {
    if (!byId.has(local.id)) byId.set(local.id, local)
  }

  const merged = [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  write(merged)
  return merged.filter((t) => t.chain === chain)
}

export function loadTurns(chain: string): ChatTurn[] {
  return read().filter((t) => t.chain === chain)
}

/** Records a conversation, newest first, locally and on the server. */
export function saveTurn(turn: ChatTurn): void {
  const existing = read().filter((t) => t.id !== turn.id)
  write([turn, ...existing])
  notifyTurnsChanged()

  void saveTurnRemote(turn).catch((e) => reportSyncFailure('a conversation', e))
}

/**
 * Patches a turn, or creates one when the patch carries enough to stand alone.
 *
 * Returning silently for an unknown id was losing real outcomes. A turn is
 * written when its competition is decided, but a settled trade can arrive
 * before that — or after a tab switch that never wrote one — and the hash was
 * then discarded with no error anywhere. A transaction that happened on-chain
 * must not vanish because the conversation around it was not saved first.
 *
 * `fallback` supplies the fields a turn cannot be reconstructed without. Given
 * one, an unknown id becomes a new row rather than a no-op.
 */
export function updateTurn(
  id: string,
  patch: Partial<ChatTurn>,
  fallback?: Pick<ChatTurn, 'chain' | 'text'>
): void {
  const all = read()
  const found = all.find((t) => t.id === id)

  if (found === undefined) {
    if (fallback === undefined) return

    // Created rather than patched, so the server has a row to hold the outcome.
    // A PATCH against an id the server has never seen returns not-found and the
    // trade's record would be lost exactly as it was before.
    const created: ChatTurn = {
      id,
      chain: fallback.chain,
      text: fallback.text,
      createdAt: new Date().toISOString(),
      proposals: {},
      winner: null,
      ...patch,
    }
    write([created, ...all])
    notifyTurnsChanged()
    void saveTurnRemote(created).catch((e) => reportSyncFailure('a settled trade', e))
    return
  }

  write(all.map((t) => (t.id === id ? { ...t, ...patch } : t)))
  notifyTurnsChanged()
  void updateTurnRemote(id, patch).catch((e) => reportSyncFailure('a trade outcome', e))
}

/**
 * Empties the panel on this device and nothing else.
 *
 * The server keeps every turn. Clear used to delete there too, which made a
 * tidy-up button in a history overlay the one thing in the app that could
 * erase the record of a trade that really happened. Now it drops the local
 * cache for this chain; the next `syncTurns` refills it from the record.
 */
export function clearTurns(chain: string): void {
  write(read().filter((t) => t.chain !== chain))
  notifyTurnsChanged()
}

/**
 * What a bundled intent did, keyed by each transaction it produced.
 *
 * The ledger cannot answer this. A Soroban router swap carries no memo, and the
 * supply that follows it is a separate transaction the chain does not associate
 * with the first — so "these two transactions were one instruction" exists only
 * in the app's record of the conversation, which is why that record has to
 * outlive the browser.
 *
 * Keyed by every step's hash rather than the first, so opening history and
 * finding the *supply* row also identifies the bundle it belonged to.
 */
export interface BundleLookup {
  steps: BundleStep[]
  /** The instruction as typed, so a row can show what was actually asked for. */
  text: string
}

export function bundlesByTxHash(chain: string): Map<string, BundleLookup> {
  const byHash = new Map<string, BundleLookup>()

  for (const turn of loadTurns(chain)) {
    const steps = turn.bundle
    // More than one step, not merely some. A single-transaction turn is an
    // ordinary swap however it was recorded, and promoting it to a bundle
    // renames it in history and promises links it does not have.
    if (steps === undefined || steps.length < 2) continue

    for (const step of steps) {
      if (step.hash === undefined) continue
      byHash.set(step.hash, { steps, text: turn.text })
    }
  }

  return byHash
}
