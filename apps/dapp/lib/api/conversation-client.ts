import type { BundleStep, ChatTurn } from '../chat-history'

import { apiRequest } from './http-client'
import { currentToken } from './auth'

/**
 * Conversation history, kept on the server rather than in the browser.
 *
 * The dApp stored turns in localStorage, which meant a trade's record — which
 * agent won, what it reasoned, which transactions a bundled intent produced —
 * lived only in the browser that made it. Clearing site data destroyed it, and
 * a second device never had it at all. A transaction that really happened must
 * not be recoverable only from the machine that happened to submit it.
 *
 * Every call needs a session, because the server scopes turns by the
 * authenticated wallet. Callers treat a missing session as "no history yet"
 * rather than as an error: the wallet still works for on-chain trading, and a
 * sign-in prompt belongs at connect time, not in a history panel.
 */

/** What the backend stores. Snake case, and shaped by the Go handler. */
interface ApiTurn {
  id: string
  chain: string
  text: string
  winner: string
  proposals: Record<string, unknown>
  routes_by_agent?: Record<string, unknown>
  tx_hash?: string
  executed_by?: string
  bundle?: BundleStep[]
  created_at: string
}

interface ListTurnsResponse {
  turns: ApiTurn[]
  total: number
}

function toChatTurn(row: ApiTurn): ChatTurn {
  return {
    id: row.id,
    chain: row.chain,
    text: row.text,
    createdAt: row.created_at,
    proposals: (row.proposals ?? {}) as ChatTurn['proposals'],
    // The backend stores an empty winner as "", and the dApp distinguishes
    // "nobody won" from "not decided yet" by null.
    winner: row.winner === '' ? null : row.winner,
    ...(row.routes_by_agent !== undefined ? { routesByAgent: row.routes_by_agent } : {}),
    ...(row.tx_hash !== undefined && row.tx_hash !== '' ? { txHash: row.tx_hash } : {}),
    ...(row.executed_by !== undefined && row.executed_by !== ''
      ? { executedBy: row.executed_by }
      : {}),
    ...(row.bundle !== undefined && row.bundle.length > 0 ? { bundle: row.bundle } : {}),
  }
}

/** Whether a call can be attempted at all. */
export function canSyncTurns(): boolean {
  return currentToken() !== undefined
}

/**
 * A wallet's turns on one chain, newest first.
 *
 * Returns nothing without a session rather than throwing: an unauthenticated
 * history panel should read as empty, not as broken.
 */
export async function listTurns(chain: string): Promise<ChatTurn[]> {
  const token = currentToken()
  if (token === undefined) return []

  const body = await apiRequest<ListTurnsResponse>(
    `/conversations?chain=${encodeURIComponent(chain)}`,
    { token }
  )
  return (body.turns ?? []).map(toChatTurn)
}

/**
 * Records a turn, replacing any turn already stored under the same id.
 *
 * The id comes from the client because the dApp creates a turn when the
 * competition opens and saves it again as agents report in. A second save is a
 * correction, not a duplicate.
 */
export async function saveTurnRemote(turn: ChatTurn): Promise<void> {
  const token = currentToken()
  if (token === undefined) return

  await apiRequest('/conversations', {
    method: 'POST',
    token,
    body: {
      id: turn.id,
      chain: turn.chain,
      text: turn.text,
      winner: turn.winner ?? '',
      proposals: turn.proposals,
      created_at: turn.createdAt,
      ...(turn.routesByAgent !== undefined ? { routes_by_agent: turn.routesByAgent } : {}),
      ...(turn.txHash !== undefined ? { tx_hash: turn.txHash } : {}),
      ...(turn.executedBy !== undefined ? { executed_by: turn.executedBy } : {}),
      ...(turn.bundle !== undefined ? { bundle: turn.bundle } : {}),
    },
  })
}

/**
 * Merges fields into a stored turn.
 *
 * Separate from saving because the competition finishes long before the
 * signature does: an outcome is attached later, and the turn has to stay
 * readable in between.
 */
export async function updateTurnRemote(id: string, patch: Partial<ChatTurn>): Promise<void> {
  const token = currentToken()
  if (token === undefined) return

  await apiRequest(`/conversations/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    token,
    body: {
      ...(patch.text !== undefined ? { text: patch.text } : {}),
      ...(patch.winner !== undefined ? { winner: patch.winner ?? '' } : {}),
      ...(patch.proposals !== undefined ? { proposals: patch.proposals } : {}),
      ...(patch.routesByAgent !== undefined ? { routes_by_agent: patch.routesByAgent } : {}),
      ...(patch.txHash !== undefined ? { tx_hash: patch.txHash } : {}),
      ...(patch.executedBy !== undefined ? { executed_by: patch.executedBy } : {}),
      ...(patch.bundle !== undefined ? { bundle: patch.bundle } : {}),
    },
  })
}

/** Deletes a wallet's turns on one chain, leaving the other chain's intact. */
export async function clearTurnsRemote(chain: string): Promise<void> {
  const token = currentToken()
  if (token === undefined) return

  await apiRequest(`/conversations?chain=${encodeURIComponent(chain)}`, {
    method: 'DELETE',
    token,
  })
}
