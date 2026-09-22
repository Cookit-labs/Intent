import type { ChatTurn } from '../chat-history'

/**
 * Standing computed from the races that actually ran.
 *
 * The board used to show reputation, volume and fill counts that were typed
 * in. Now it shows two numbers per agent, both counted from the user's own
 * history: how many races it proposed in, and how many it was picked as best.
 * Small numbers, but real ones.
 */
export interface LeaderboardRow {
  key: string
  name: string
  races: number
  wins: number
  winRate: number
}

export function rankAgents(turns: ChatTurn[]): LeaderboardRow[] {
  const rows = new Map<string, LeaderboardRow>()

  for (const turn of turns) {
    for (const view of Object.values(turn.proposals)) {
      if (view.failed !== undefined) continue
      const row = rows.get(view.key) ?? {
        key: view.key,
        name: view.name,
        races: 0,
        wins: 0,
        winRate: 0,
      }
      row.races += 1
      if (turn.winner === view.key) row.wins += 1
      // The latest name wins; a curated display name may have changed.
      row.name = view.name
      rows.set(view.key, row)
    }
  }

  return [...rows.values()]
    .map((r) => ({ ...r, winRate: r.races === 0 ? 0 : r.wins / r.races }))
    .sort((a, b) => b.wins - a.wins || b.races - a.races || a.name.localeCompare(b.name))
}
