// apps/dapp/lib/offramp/session-store.ts
/**
 * Where a withdrawal-in-progress lives between renders and across a reload.
 *
 * The SEP-10 token is a credential with one anchor for about fifteen minutes.
 * It is held in `sessionStorage`, keyed by anchor and account, so a reload in
 * the middle of the anchor's KYC page does not strand the withdrawal the
 * anchor is holding open — and so it dies with the tab. Never `localStorage`.
 *
 * The store is injected so this is testable in node; the hook passes
 * `window.sessionStorage`.
 */

export interface StoredSession {
  token: string
  /** Unix seconds. */
  expiresAt: number
  transactionId?: string
  interactiveUrl?: string
}

export interface SessionStore {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

export function sessionKey(anchorId: string, account: string): string {
  return `intent.offramp.${anchorId}.${account}`
}

export function saveSession(
  store: SessionStore,
  anchorId: string,
  account: string,
  session: StoredSession
): void {
  store.setItem(sessionKey(anchorId, account), JSON.stringify(session))
}

export function loadSession(
  store: SessionStore,
  anchorId: string,
  account: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): StoredSession | undefined {
  const raw = store.getItem(sessionKey(anchorId, account))
  if (raw === null) return undefined
  try {
    const parsed = JSON.parse(raw) as Partial<StoredSession>
    if (typeof parsed.token !== 'string' || typeof parsed.expiresAt !== 'number') return undefined
    if (parsed.expiresAt <= nowSeconds) return undefined
    return {
      token: parsed.token,
      expiresAt: parsed.expiresAt,
      ...(typeof parsed.transactionId === 'string' ? { transactionId: parsed.transactionId } : {}),
      ...(typeof parsed.interactiveUrl === 'string'
        ? { interactiveUrl: parsed.interactiveUrl }
        : {}),
    }
  } catch {
    return undefined
  }
}

export function clearSession(store: SessionStore, anchorId: string, account: string): void {
  store.removeItem(sessionKey(anchorId, account))
}
