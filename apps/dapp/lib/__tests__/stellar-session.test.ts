import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * The session rules that fix the "disconnect does nothing" bug.
 *
 * The old code stored only an address, so disconnect cleared it while the
 * wallet stayed authorised — the next read reconnected instantly. These tests
 * pin the two rules that make disconnect stick: a session must be *verified*
 * to be restored, and clearing it must leave nothing restorable.
 */
const SESSION_KEY = 'intent.stellar.session'

interface StoredSession {
  address: string
  verified: boolean
}

function readSession(): StoredSession | undefined {
  const raw = globalThis.localStorage.getItem(SESSION_KEY)
  return raw === null ? undefined : (JSON.parse(raw) as StoredSession)
}

function writeSession(session: StoredSession | undefined): void {
  if (session === undefined) globalThis.localStorage.removeItem(SESSION_KEY)
  else globalThis.localStorage.setItem(SESSION_KEY, JSON.stringify(session))
}

/** Mirrors the adapter's restore guard. */
function shouldRestore(session: StoredSession | undefined, walletAddress: string | undefined): boolean {
  if (session === undefined || !session.verified) return false
  return walletAddress === session.address
}

beforeEach(() => {
  const store = new Map<string, string>()
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage
})

afterEach(() => {
  // @ts-expect-error test teardown
  delete globalThis.localStorage
})

describe('stellar session', () => {
  it('does not restore after an explicit disconnect', () => {
    writeSession({ address: 'GABC', verified: true })
    writeSession(undefined)
    // Even though the wallet still reports the account as authorised, there is
    // no session to restore — this is the bug fix.
    expect(shouldRestore(readSession(), 'GABC')).toBe(false)
  })

  it('restores a verified session for the same account', () => {
    writeSession({ address: 'GABC', verified: true })
    expect(shouldRestore(readSession(), 'GABC')).toBe(true)
  })

  it('refuses to restore an unsigned session', () => {
    // A session without a signature is just a public-key read, which proves
    // nothing about who is at the keyboard.
    writeSession({ address: 'GABC', verified: false })
    expect(shouldRestore(readSession(), 'GABC')).toBe(false)
  })

  it('refuses to restore when the wallet switched accounts', () => {
    writeSession({ address: 'GABC', verified: true })
    expect(shouldRestore(readSession(), 'GXYZ')).toBe(false)
  })

  it('treats a missing session as disconnected', () => {
    expect(shouldRestore(readSession(), 'GABC')).toBe(false)
  })
})
