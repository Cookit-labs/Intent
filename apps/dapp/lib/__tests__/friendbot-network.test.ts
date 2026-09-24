import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Friendbot is a testnet thing. On mainnet an account is funded by whoever
 * pays its reserve, and the app must say so rather than GET
 * `undefined/?addr=…` and report whatever that returns.
 */

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('fundWithFriendbot by network', () => {
  it('calls friendbot on testnet', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', (url: string) => {
      calls.push(url)
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    const { fundWithFriendbot } = await import('../stellar-account')
    await fundWithFriendbot('GABC')
    expect(calls).toEqual(['https://friendbot.stellar.org/?addr=GABC'])
  })

  it('refuses on mainnet without touching the network', async () => {
    vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORK', 'mainnet')
    vi.resetModules()
    const calls: string[] = []
    vi.stubGlobal('fetch', (url: string) => {
      calls.push(url)
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    const { fundWithFriendbot } = await import('../stellar-account')
    await expect(fundWithFriendbot('GABC')).rejects.toThrow(/no friendbot on Stellar Mainnet/)
    expect(calls).toEqual([])
  })
})
