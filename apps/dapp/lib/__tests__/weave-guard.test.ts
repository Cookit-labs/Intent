import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ mainnet: true, configured: true }))

vi.mock('@intent/config', async (original) => ({
  ...(await original<typeof import('@intent/config')>()),
  isMainnet: () => state.mainnet,
}))
vi.mock('../weave/client', () => ({
  createWeaveClient: () => ({ configured: state.configured }),
}))

import { WALLET_HEADER } from '../wallet-header'
import { guardCashout } from '../weave/guard'

const signedIn = (): Request =>
  new Request('http://localhost/api/cashout/orders', {
    headers: { [WALLET_HEADER]: 'alice.near' },
  })

beforeEach(() => {
  state.mainnet = true
  state.configured = true
})

describe('guardCashout', () => {
  it('passes a known requester on a configured deployment', () => {
    expect(guardCashout(signedIn())).toEqual({ ok: true, email: 'wallet:alice.near' })
  })

  it('needs a requester', async () => {
    const result = guardCashout(new Request('http://localhost/api/cashout/orders'))
    if (result.ok) throw new Error('expected a refusal')
    expect(result.response.status).toBe(401)
    expect((await result.response.json()).message).toMatch(/connect/i)
  })

  it('needs a configured client', async () => {
    state.configured = false
    const result = guardCashout(signedIn())
    if (result.ok) throw new Error('expected a refusal')
    expect(result.response.status).toBe(503)
    expect((await result.response.json()).message).toMatch(/not available/i)
  })

  it('refuses a Stellar cash-out off mainnet', () => {
    state.mainnet = false
    const result = guardCashout(signedIn(), 'stellar')
    if (result.ok) throw new Error('expected a refusal')
    expect(result.response.status).toBe(403)
  })

  it.each(['solana', 'avalanche', 'sui', 'near'] as const)(
    'lets %s through whatever Stellar network the page is on',
    (chain) => {
      state.mainnet = false
      expect(guardCashout(signedIn(), chain).ok).toBe(true)
    }
  )
})
