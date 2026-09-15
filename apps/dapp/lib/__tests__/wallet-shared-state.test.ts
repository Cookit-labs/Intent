import { describe, expect, it } from 'vitest'

import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * One wallet connection, shared by every component that asks for it.
 *
 * `useStellarWallet` is a plain hook and the chain context shares only the
 * adapter *object*, never its state. So when the hook held its own `useState`,
 * each of the five callers got an independent connection: clicking connect in
 * the header updated the header alone, and the swap history beside it still
 * said "Connect a wallet to see its swap history" while the address and balance
 * sat in the toolbar directly above it.
 *
 * That is a structural property rather than a behavioural one, so it is checked
 * structurally. Rendering five React components to assert it would test React's
 * scheduler more than this codebase, and this suite runs without a DOM.
 */

const adapter = readFileSync(join(process.cwd(), 'lib', 'adapters', 'stellar-adapter.ts'), 'utf8')

/** The body of `useStellarWallet`, where the defect lived. */
function hookBody(): string {
  const start = adapter.indexOf('function useStellarWallet()')
  expect(start, 'useStellarWallet should exist').toBeGreaterThan(-1)
  // Far enough to cover the hook without depending on an exact line count.
  return adapter.slice(start, start + 6000)
}

describe('the connection is shared, not per-caller', () => {
  it('keeps the address in a module-level store', () => {
    // The fix. A value outside the hook is the only thing every caller can
    // observe, since the context passes the adapter and not its state.
    expect(adapter).toMatch(/let sharedAddress: string \| undefined/)
  })

  it('notifies subscribers when the connection changes', () => {
    // Shared state with no subscription is worse than local state: the value
    // changes and nothing re-renders.
    expect(adapter).toMatch(/const listeners = new Set<\(\) => void>\(\)/)
    expect(adapter).toMatch(/function publish\(\)/)
  })

  it('does not hold the address or network in per-caller state', () => {
    // The regression this file exists to prevent. Matched by binding name
    // rather than by type: `error` is also a `string | undefined` useState and
    // is *correctly* local — an error belongs to the component that caused it,
    // unlike a connection, which every component must agree on.
    const body = hookBody()
    expect(body).not.toMatch(/const \[address, setAddress\] = useState/)
    expect(body).not.toMatch(/const \[network, setNetwork\] = useState/)
  })

  it('still keeps transient per-caller state local', () => {
    // Sharing everything would be the opposite mistake: one component's
    // connect error would surface in all five.
    expect(hookBody()).toMatch(/const \[error, setError\] = useState/)
    expect(hookBody()).toMatch(/const \[isConnecting, setIsConnecting\] = useState/)
  })

  it('reads the connection through the shared subscription', () => {
    expect(hookBody()).toMatch(/useSharedConnection\(\)/)
  })

  it('writes every connection change through the shared setters', () => {
    const body = hookBody()
    expect(body).toMatch(/setSharedAddress\(/)
    expect(body).toMatch(/setSharedNetwork\(/)
    // A stale local setter would compile only if someone reintroduced the
    // state, and would then silently desynchronise the callers again.
    expect(body).not.toMatch(/\bsetAddress\(/)
    expect(body).not.toMatch(/\bsetNetwork\(/)
  })

  it('clears the shared connection on disconnect', () => {
    // Disconnecting in the header used to leave the rest of the app believing
    // it was still connected.
    expect(hookBody()).toMatch(/setSharedAddress\(undefined\)/)
  })
})

describe('restoring a wallet does not require a backend session', () => {
  it('restores on the stored record alone', () => {
    // The gate used to be `!session.verified`, and `verified: false` is written
    // whenever backend sign-in throws — which it did for every connect before
    // SEP-53 verification was fixed. So no component ever restored, and the
    // wallet looked disconnected on every reload.
    expect(hookBody()).toMatch(/if \(session === undefined\) return/)
    expect(hookBody()).not.toMatch(/!session\.verified/)
  })

  it('still drops the record when the wallet reports another account', () => {
    // Relaxing the gate must not mean trusting a stale address: the wallet is
    // asked, and a mismatch clears the record.
    expect(hookBody()).toMatch(/current === session\.address/)
  })
})
