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
export function updateTurn(id: string, patch: Partial<ChatTurn>): void {
  const all = read()
  const found = all.find((t) => t.id === id)
  if (found === undefined) return
  write(all.map((t) => (t.id === id ? { ...t, ...patch } : t)))
}

export function clearTurns(chain: string): void {
  write(read().filter((t) => t.chain !== chain))
}
