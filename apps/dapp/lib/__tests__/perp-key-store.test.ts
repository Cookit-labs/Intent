import { describe, expect, it } from 'vitest'

import { clearKey, keyStoreKey, loadKey, saveKey } from '../perps/key-store'

/**
 * Where the Noether API key lives between renders.
 *
 * A key is a standing credential with the gateway for this wallet, not a
 * short-lived token, so it is held only for the tab's session and re-read
 * only within a day. The gateway caps active keys per wallet, and a tab that
 * minted one on every reload would hit that cap; a tab that kept one forever
 * would hold a credential long after anyone remembered minting it.
 */

function fakeStore(): {
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

const ACCOUNT = 'GDA4JVVUE6CTF7FEGOFMKA3YE4E5J7SAAK7RACZLNIMXYF24OLLR3KZO'
const NOW = 1_790_000_000

describe('the perp key store', () => {
  it('is keyed by account under its own namespace', () => {
    expect(keyStoreKey(ACCOUNT)).toBe(`intent.perps.noether.${ACCOUNT}`)
  })

  it('round-trips a key within the day', () => {
    const store = fakeStore()
    saveKey(store, ACCOUNT, { keyId: 'nk_1', secret: 's3' }, NOW)
    expect(loadKey(store, ACCOUNT, NOW + 3600)).toEqual({ keyId: 'nk_1', secret: 's3' })
  })

  it('forgets a key older than a day', () => {
    const store = fakeStore()
    saveKey(store, ACCOUNT, { keyId: 'nk_1', secret: 's3' }, NOW)
    expect(loadKey(store, ACCOUNT, NOW + 86_401)).toBeUndefined()
  })

  it('returns nothing for another account', () => {
    const store = fakeStore()
    saveKey(store, ACCOUNT, { keyId: 'nk_1', secret: 's3' }, NOW)
    expect(loadKey(store, 'GOTHER', NOW)).toBeUndefined()
  })

  it('survives a store that refuses writes', () => {
    const store = {
      ...fakeStore(),
      setItem: () => {
        throw new Error('quota')
      },
    }
    expect(() => saveKey(store, ACCOUNT, { keyId: 'nk_1', secret: 's3' }, NOW)).not.toThrow()
  })

  it('clears', () => {
    const store = fakeStore()
    saveKey(store, ACCOUNT, { keyId: 'nk_1', secret: 's3' }, NOW)
    clearKey(store, ACCOUNT)
    expect(loadKey(store, ACCOUNT, NOW)).toBeUndefined()
  })
})
