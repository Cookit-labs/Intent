import type { StandingIntent, StandingStatus } from '../standing-intent'

/**
 * Standing rules, on the server.
 *
 * These talk to the dApp's own routes under /api/standing, not the Go
 * backend: the tick that evaluates rules runs there, so the record has to be
 * there too. The session is a cookie the browser sends on its own, so there
 * is no token to carry.
 *
 * A missing session is not an error. Every call answers "nothing" on a 401
 * rather than throwing — the rules still work locally, and a sign-in prompt
 * belongs at connect time, not in the console on every save.
 */

/** A rule as the server returns it. Mirrors `StoredStandingRule` server-side. */
export interface StandingRuleRecord {
  id: string
  wallet: string
  chain: string
  /** The intent, with `status` and `lastFiredAt` already reconciled from the columns. */
  rule: StandingIntent
  status: StandingStatus
  createdAt: string
  firedAt: string | null
  firedPrice: number | null
  notifiedAt: string | null
  seenAt: string | null
}

/** What the client tells the server when a rule fired on its side. */
export interface FiredReport {
  at: string
  /** The price that crossed the level, when there was one. */
  price?: number
  /** True when the user signed it: nothing to email, nothing to show. */
  executed?: boolean
}

type FetchImpl = typeof fetch

/**
 * One request. Undefined on 401 (no session), the parsed body otherwise; any
 * other failure throws with the status and the server's reason.
 */
async function request<T>(
  fetchImpl: FetchImpl,
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<T | undefined> {
  const res = await fetchImpl(path, {
    method: init.method ?? 'GET',
    credentials: 'same-origin',
    ...(init.body !== undefined
      ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) }
      : {}),
  })

  if (res.status === 401) return undefined
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`)
  return (await res.json()) as T
}

export async function listRulesRemote(
  chain: string,
  wallet?: string,
  fetchImpl: FetchImpl = fetch
): Promise<StandingRuleRecord[]> {
  const params = new URLSearchParams({ chain })
  if (wallet !== undefined && wallet !== '') params.set('wallet', wallet)

  const body = await request<{ rules: StandingRuleRecord[] }>(
    fetchImpl,
    `/api/standing?${params.toString()}`
  )
  return body?.rules ?? []
}

export async function saveRuleRemote(
  rule: StandingIntent,
  wallet: string,
  fetchImpl: FetchImpl = fetch
): Promise<void> {
  await request(fetchImpl, '/api/standing', { method: 'POST', body: { wallet, rule } })
}

export async function cancelRuleRemote(id: string, fetchImpl: FetchImpl = fetch): Promise<void> {
  await request(fetchImpl, `/api/standing?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function reportFiredRemote(
  id: string,
  report: FiredReport,
  fetchImpl: FetchImpl = fetch
): Promise<void> {
  await request(fetchImpl, '/api/standing', { method: 'PATCH', body: { id, ...report } })
}

export async function listInboxRemote(
  chain: string,
  fetchImpl: FetchImpl = fetch
): Promise<StandingRuleRecord[]> {
  const body = await request<{ rules: StandingRuleRecord[] }>(
    fetchImpl,
    `/api/standing/inbox?chain=${encodeURIComponent(chain)}`
  )
  return body?.rules ?? []
}

export async function markInboxSeenRemote(
  ids: string[],
  fetchImpl: FetchImpl = fetch
): Promise<void> {
  if (ids.length === 0) return
  await request(fetchImpl, '/api/standing/inbox', { method: 'POST', body: { ids } })
}
