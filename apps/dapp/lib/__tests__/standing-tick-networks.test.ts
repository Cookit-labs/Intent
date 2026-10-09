import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The scheduled check with several networks served. It has no request, so it
 * names each network itself, runs them one at a time, and keeps one network's
 * failure from skipping the other's rules.
 */

async function setup(): Promise<{
  all: typeof import('../server/standing-tick-all')
  tick: typeof import('../server/standing-tick')
  ctx: typeof import('../server/network-context')
  config: typeof import('@intent/config')
}> {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORK', 'testnet')
  vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORKS', 'testnet,mainnet')
  const config = await import('@intent/config')
  const ctx = await import('../server/network-context')
  ctx.installNetworkResolver()
  const all = await import('../server/standing-tick-all')
  const tick = await import('../server/standing-tick')
  return { all, tick, ctx, config }
}

afterEach(async () => {
  const config = await import('@intent/config')
  config.setNetworkResolver(undefined)
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('tickAllNetworks', () => {
  it('runs each served network with that network selected, and adds the results up', async () => {
    const { all, config } = await setup()
    const seen: string[] = []
    const out = await all.tickAllNetworks(['testnet', 'mainnet'], async () => {
      seen.push(config.activeNetwork())
      return { evaluated: 2, fired: 1, notified: 1 }
    })
    expect(seen).toEqual(['testnet', 'mainnet'])
    expect(out.result).toEqual({ evaluated: 4, fired: 2, notified: 2 })
    expect(out.failed).toEqual([])
  })

  it('keeps going when one network fails, and says which', async () => {
    const { all, config } = await setup()
    const out = await all.tickAllNetworks(['testnet', 'mainnet'], async () => {
      if (config.activeNetwork() === 'testnet') throw new Error('prices unreachable')
      return { evaluated: 3, fired: 0, notified: 0 }
    })
    expect(out.failed).toEqual(['testnet'])
    expect(out.result).toEqual({ evaluated: 3, fired: 0, notified: 0 })
  })
})

describe('the link in a fired-rule email', () => {
  it('names the network of the rule, so it opens where the rule lives', async () => {
    const { tick } = await setup()
    expect(
      tick.ruleLinkFor('https://app.test', { chain: 'stellar', network: 'mainnet', id: 'r1' })
    ).toBe('https://app.test/stellar-mainnet/intents?rule=r1')
    expect(
      tick.ruleLinkFor('https://app.test/', { chain: 'stellar', network: 'testnet', id: 'r 2' })
    ).toBe('https://app.test/stellar-testnet/intents?rule=r%202')
    expect(
      tick.ruleLinkFor('https://app.test', { chain: 'arc', network: 'testnet', id: 'r3' })
    ).toBe('https://app.test/arc/intents?rule=r3')
  })
})
