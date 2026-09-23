import type { SessionStore } from '../offramp/session-store'
import type { NoetherKey } from './noether-client'

/**
 * Where the Noether API key lives between renders and across a reload.
 *
 * A key is a standing credential with the gateway for this wallet, not a
 * fifteen-minute token, which argues for holding it *less* readily than the
 * SEP-10 token, not more. It is kept in `sessionStorage` so it dies with the
 * tab, and re-read only within a day so a tab left open does not keep a
 * credential nobody remembers minting. Never `localStorage`.
 *
 * The gateway caps active keys per wallet (`key_limit_reached`). Minting one
 * per order would hit that cap within an afternoon, which is why the key is
 * kept at all rather than requested fresh each time. Revoking it on reset is
 * deferred; the gateway's key page lists and revokes them.
 */

const TTL_SECONDS = 86_400

export function keyStoreKey(account: string): string {
  return `intent.perps.noether.${account}`
}

export function saveKey(
  store: SessionStore,
  account: string,
  key: NoetherKey,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): void {
  try {
    store.setItem(
      keyStoreKey(account),
      JSON.stringify({ ...key, expiresAt: nowSeconds + TTL_SECONDS })
    )
  } catch {
    // Quota exceeded, or storage denied. The key still works for this page
    // load; the next reload mints another.
  }
}

export function loadKey(
  store: SessionStore,
  account: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): NoetherKey | undefined {
  const raw = store.getItem(keyStoreKey(account))
  if (raw === null) return undefined
  try {
    const parsed = JSON.parse(raw) as Partial<NoetherKey & { expiresAt: number }>
    if (typeof parsed.keyId !== 'string' || typeof parsed.secret !== 'string') return undefined
    if (typeof parsed.expiresAt !== 'number' || parsed.expiresAt <= nowSeconds) return undefined
    return { keyId: parsed.keyId, secret: parsed.secret }
  } catch {
    return undefined
  }
}

export function clearKey(store: SessionStore, account: string): void {
  store.removeItem(keyStoreKey(account))
}
