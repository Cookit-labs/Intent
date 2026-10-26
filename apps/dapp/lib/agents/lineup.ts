import type { RosterAgent } from './registry'

/**
 * Which of the roster's agents run in this race.
 *
 * The free OpenRouter tier is 50 requests a day per key, shared by every free
 * model. With all five curated models in every race that is ten races before
 * each OpenRouter card reads "rate limited" until midnight UTC. Two of them
 * per race, taken in turn, is twenty-five races, and every model still gets
 * its turn.
 *
 * An agent that answered 429 sits out until the reset it named. Benched per
 * model, not per provider: a free OpenRouter model is often rate-limited
 * upstream on its own while the others answer, and benching the whole
 * provider for one of them emptied the race of every OpenRouter agent. When
 * the key itself is spent, each model learns it from its own 429.
 *
 * Kept in memory, so per server instance: a cold instance learns of a limit
 * from its own first 429. That costs one wasted request, not a wrong answer.
 */

/** OpenRouter agents per race. */
export const OPENROUTER_SEATS = 2

/** How long to bench a provider whose 429 named no reset. */
const DEFAULT_COOLDOWN_MS = 60_000
/** A reset further out than this is treated as this: a bad header should not bench a provider for a week. */
const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000

const benchedUntil = new Map<string, number>()
let turn = 0

export function noteRateLimited(
  agentKey: string,
  retryAfterMs: number | undefined,
  now: number = Date.now()
): void {
  const wait = Math.min(Math.max(retryAfterMs ?? DEFAULT_COOLDOWN_MS, 0), MAX_COOLDOWN_MS)
  benchedUntil.set(agentKey, Math.max(benchedUntil.get(agentKey) ?? 0, now + wait))
}

/** When the earliest benched agent comes back, if every one is benched. */
export function benchedUntilFor(
  roster: RosterAgent[],
  now: number = Date.now()
): number | undefined {
  const until = roster.map((a) => benchedUntil.get(a.key) ?? 0)
  return until.every((t) => t > now) ? Math.min(...until) : undefined
}

export function lineUp(roster: RosterAgent[], now: number = Date.now()): RosterAgent[] {
  const available = roster.filter((a) => (benchedUntil.get(a.key) ?? 0) <= now)
  const openrouter = available.filter((a) => a.provider === 'openrouter')
  if (openrouter.length <= OPENROUTER_SEATS) return available

  const start = turn % openrouter.length
  turn += OPENROUTER_SEATS
  const seated = new Set(
    Array.from({ length: OPENROUTER_SEATS }, (_, i) => openrouter[(start + i) % openrouter.length])
  )
  return available.filter((a) => a.provider !== 'openrouter' || seated.has(a))
}

/** For tests. */
export function resetLineUp(): void {
  benchedUntil.clear()
  turn = 0
}
