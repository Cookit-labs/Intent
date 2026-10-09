import { afterEach, describe, expect, it, vi } from 'vitest'

const headerStore = vi.hoisted(() => ({ current: undefined as Headers | undefined }))

vi.mock('next/headers', () => ({
  headers: () => {
    if (headerStore.current === undefined) throw new Error('outside a request scope')
    return headerStore.current
  },
}))

type Context = typeof import('../server/network-context')
type Config = typeof import('@intent/config')

async function setup(env: Record<string, string> = {}): Promise<{ ctx: Context; config: Config }> {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORK', '')
  vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORKS', '')
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  const config = await import('@intent/config')
  const ctx = await import('../server/network-context')
  ctx.installNetworkResolver()
  return { ctx, config }
}

afterEach(async () => {
  const config = await import('@intent/config')
  config.setNetworkResolver(undefined)
  headerStore.current = undefined
  vi.unstubAllEnvs()
  vi.resetModules()
})

const BOTH = { NEXT_PUBLIC_STELLAR_NETWORKS: 'testnet,mainnet' }

describe('the network of a request', () => {
  it('is read from the header middleware set', async () => {
    const { config } = await setup(BOTH)
    headerStore.current = new Headers({ 'x-intent-network': 'mainnet' })
    expect(config.activeNetwork()).toBe('mainnet')
    headerStore.current = new Headers({ 'x-intent-network': 'testnet' })
    expect(config.activeNetwork()).toBe('testnet')
  })

  it('is the default when the header names a network the deployment does not serve', async () => {
    const { config } = await setup({ NEXT_PUBLIC_STELLAR_NETWORKS: 'testnet' })
    headerStore.current = new Headers({ 'x-intent-network': 'mainnet' })
    expect(config.activeNetwork()).toBe('testnet')
  })

  it('cannot be found without a header, or outside a request, and says so', async () => {
    const { config } = await setup(BOTH)
    headerStore.current = new Headers()
    expect(() => config.activeNetwork()).toThrow(/No Stellar network is selected/)
    headerStore.current = undefined
    expect(() => config.activeNetwork()).toThrow(/No Stellar network is selected/)
  })
})

describe('runWithNetwork', () => {
  it('names the network for work that has no request, and wins over a header', async () => {
    const { ctx, config } = await setup(BOTH)
    headerStore.current = new Headers({ 'x-intent-network': 'testnet' })
    expect(ctx.runWithNetwork('mainnet', () => config.activeNetwork())).toBe('mainnet')
    headerStore.current = undefined
    expect(ctx.runWithNetwork('testnet', () => config.activeNetwork())).toBe('testnet')
  })

  it('keeps two overlapping runs apart', async () => {
    const { ctx, config } = await setup(BOTH)
    const seen: string[] = []
    const run = (network: 'testnet' | 'mainnet', delay: number) =>
      ctx.runWithNetwork(network, async () => {
        await new Promise((r) => setTimeout(r, delay))
        seen.push(`${network}:${config.activeNetwork()}`)
      })
    await Promise.all([run('mainnet', 20), run('testnet', 5), run('mainnet', 1)])
    expect(seen.sort()).toEqual(['mainnet:mainnet', 'mainnet:mainnet', 'testnet:testnet'])
  })
})

describe('with one network served', () => {
  it('never reads the request', async () => {
    const { config } = await setup({ NEXT_PUBLIC_STELLAR_NETWORK: 'mainnet' })
    headerStore.current = undefined
    expect(config.activeNetwork()).toBe('mainnet')
  })
})
