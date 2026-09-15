import type { AgentProposalView } from './mock-competition'

/**
 * Past conversations, kept across reloads.
 *
 * The chat held everything in component state, so a refresh erased what the
 * agents had said and submitting a second intent overwrote the first. The
 * reasoning is the substance of a competition — why one agent won, what the
 * runner-up would have paid — and it was being discarded the moment the trade
 * settled.
 *
 * Stored per chain, because an intent belongs to the network it was placed on.
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
}

const STORAGE_KEY = 'intent.chat.v1'

/**
 * Enough to look back over a session's work without letting the store grow
 * without bound. Old turns are dropped oldest-first.
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
    // Private-mode browsers throw on access. The session still works, it just
    // will not remember across reloads.
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

export function loadTurns(chain: string): ChatTurn[] {
  return read().filter((t) => t.chain === chain)
}

/** Records a conversation, newest first. */
export function saveTurn(turn: ChatTurn): void {
  const existing = read().filter((t) => t.id !== turn.id)
  write([turn, ...existing])
}

/**
 * Attaches an outcome to a conversation already recorded.
 *
 * Separate from `saveTurn` because the competition finishes long before the
 * signature does, and the turn should be readable in between.
 */
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
    write([
      {
        id,
        chain: fallback.chain,
        text: fallback.text,
        createdAt: new Date().toISOString(),
        proposals: {},
        winner: null,
        ...patch,
      },
      ...all,
    ])
    return
  }

  write(all.map((t) => (t.id === id ? { ...t, ...patch } : t)))
}

export function clearTurns(chain: string): void {
  write(read().filter((t) => t.chain !== chain))
}

/**
 * What a bundled intent did, keyed by each transaction it produced.
 *
 * The ledger cannot answer this. A Soroban router swap carries no memo, and the
 * supply that follows it is a separate transaction the chain does not associate
 * with the first — so "these two transactions were one instruction" exists only
 * in the app's own record of the conversation.
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
    if (steps === undefined || steps.length === 0) continue

    for (const step of steps) {
      if (step.hash === undefined) continue
      byHash.set(step.hash, { steps, text: turn.text })
    }
  }

  return byHash
}
