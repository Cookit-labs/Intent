/**
 * A wallet's own agent races, read from the app's own record — the one
 * thing about a past swap the ledger can never say: which agent proposed
 * it and why.
 */

export interface AgentHistoryEntry {
  raceId: string
  startedAt: string
  tokenIn: string
  tokenOut: string
  sizeUsd: number | null
  winner: string | null
  winningModel: string | null
  reasoning: string | null
  executedHash: string | null
}

export async function fetchAgentHistory(
  account: string,
  fetchImpl: typeof fetch = fetch
): Promise<AgentHistoryEntry[]> {
  try {
    const res = await fetchImpl(`/api/agents/history?account=${encodeURIComponent(account)}`)
    if (!res.ok) return []
    const body = (await res.json()) as { entries?: AgentHistoryEntry[] }
    return Array.isArray(body.entries) ? body.entries : []
  } catch {
    return []
  }
}

/** This wallet's races, keyed by the hash of the transaction each one settled as. */
export function agentHistoryByHash(entries: AgentHistoryEntry[]): Map<string, AgentHistoryEntry> {
  const byHash = new Map<string, AgentHistoryEntry>()
  for (const entry of entries) {
    if (entry.executedHash !== null) byHash.set(entry.executedHash, entry)
  }
  return byHash
}
