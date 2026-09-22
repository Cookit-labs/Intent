// apps/dapp/lib/__tests__/offramp-session-store.test.ts
import { describe, expect, it } from 'vitest'

import { clearSession, loadSession, saveSession, sessionKey } from '../offramp/session-store'

/**
 * The JWT and the anchor's transaction id, kept across a reload.
 *
 * A withdrawal's KYC happens in the anchor's popup and can take a while; a
 * reload mid-flow that lost the token and the id would strand a transaction
 * the anchor is still holding open. Session storage, not local: the token is
 * a fifteen-minute credential and should not outlive the tab.
 */

function memoryStore(): {
  getItem: (k: string) => string | null
  setItem: (k: string, v: string) => void
  removeItem: (k: string) => void
} {
  const m = new Map<string, string>()
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  }
}

const ACCOUNT = 'GCYQ3NXJHGD7P36OVKII6GKVLAENQ6ZETYOBAPZTI4R6ZWUU6QLHVVUX'

describe('session store', () => {
  it('keys by anchor and account', () => {
    expect(sessionKey('testanchor', ACCOUNT)).toBe(`intent.offramp.testanchor.${ACCOUNT}`)
  })

  it('round-trips a session', () => {
    const store = memoryStore()
    saveSession(store, 'testanchor', ACCOUNT, {
      token: 't',
      expiresAt: 2_000,
      transactionId: 'tx-1',
    })
    expect(loadSession(store, 'testanchor', ACCOUNT, 1_000)).toEqual({
      token: 't',
      expiresAt: 2_000,
      transactionId: 'tx-1',
    })
  })

  it('drops an expired token', () => {
    const store = memoryStore()
    saveSession(store, 'testanchor', ACCOUNT, { token: 't', expiresAt: 1_000 })
    expect(loadSession(store, 'testanchor', ACCOUNT, 1_001)).toBeUndefined()
  })

  it('keeps sessions for different anchors apart', () => {
    const store = memoryStore()
    saveSession(store, 'testanchor', ACCOUNT, { token: 'a', expiresAt: 9_999 })
    saveSession(store, 'moneygram', ACCOUNT, { token: 'b', expiresAt: 9_999 })
    expect(loadSession(store, 'testanchor', ACCOUNT, 0)?.token).toBe('a')
    expect(loadSession(store, 'moneygram', ACCOUNT, 0)?.token).toBe('b')
  })

  it('clears', () => {
    const store = memoryStore()
    saveSession(store, 'testanchor', ACCOUNT, { token: 'a', expiresAt: 9_999 })
    clearSession(store, 'testanchor', ACCOUNT)
    expect(loadSession(store, 'testanchor', ACCOUNT, 0)).toBeUndefined()
  })

  it('survives a corrupt entry', () => {
    const store = memoryStore()
    store.setItem(sessionKey('testanchor', ACCOUNT), '{not json')
    expect(loadSession(store, 'testanchor', ACCOUNT, 0)).toBeUndefined()
  })

  it('does not throw when the store refuses to write', () => {
    const store = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded')
      },
      removeItem: () => {},
    }
    expect(() =>
      saveSession(store, 'testanchor', ACCOUNT, { token: 't', expiresAt: 9_999 })
    ).not.toThrow()
  })
})
