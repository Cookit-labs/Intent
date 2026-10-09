import { afterEach, describe, expect, it, vi } from 'vitest'

type Config = typeof import('@intent/config')

async function load(env: Record<string, string> = {}): Promise<Config> {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORK', '')
  vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORKS', '')
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  return import('@intent/config')
}

afterEach(async () => {
  const config = await import('@intent/config')
  config.setNetworkResolver(undefined)
  config.setClientNetwork(undefined)
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('parseEnabledNetworks', () => {
  it('defaults to the one network of the deployment', async () => {
    const { parseEnabledNetworks } = await load()
    expect(parseEnabledNetworks(undefined, 'testnet')).toEqual(['testnet'])
    expect(parseEnabledNetworks('', 'mainnet')).toEqual(['mainnet'])
  })

  it('reads a comma list, drops duplicates and spaces', async () => {
    const { parseEnabledNetworks } = await load()
    expect(parseEnabledNetworks(' testnet , mainnet,testnet', 'testnet')).toEqual([
      'testnet',
      'mainnet',
    ])
  })

  it('refuses a name that is not a network', async () => {
    const { parseEnabledNetworks } = await load()
    expect(() => parseEnabledNetworks('testnet,pubnet', 'testnet')).toThrow(/pubnet/)
  })

  it('refuses a list that leaves out the default network', async () => {
    const { parseEnabledNetworks } = await load()
    expect(() => parseEnabledNetworks('mainnet', 'testnet')).toThrow(/default network "testnet"/)
  })
})

describe('resolveRequestedNetwork', () => {
  it('takes an enabled network and falls back for anything else', async () => {
    const { resolveRequestedNetwork } = await load()
    const enabled = ['testnet', 'mainnet'] as const
    expect(resolveRequestedNetwork('mainnet', enabled, 'testnet')).toBe('mainnet')
    expect(resolveRequestedNetwork('pubnet', enabled, 'testnet')).toBe('testnet')
    expect(resolveRequestedNetwork(null, enabled, 'testnet')).toBe('testnet')
    expect(resolveRequestedNetwork('mainnet', ['testnet'], 'testnet')).toBe('testnet')
  })
})

describe('activeNetwork', () => {
  it('is the deployment network when only one is served, and never asks a resolver', async () => {
    const config = await load({ NEXT_PUBLIC_STELLAR_NETWORK: 'mainnet' })
    config.setNetworkResolver(() => {
      throw new Error('resolver must not be consulted')
    })
    expect(config.activeNetwork()).toBe('mainnet')
    expect(config.isMultiNetwork()).toBe(false)
  })

  it('asks the resolver when several networks are served', async () => {
    const config = await load({ NEXT_PUBLIC_STELLAR_NETWORKS: 'testnet,mainnet' })
    config.setNetworkResolver(() => 'mainnet')
    expect(config.activeNetwork()).toBe('mainnet')
    expect(config.isMainnet()).toBe(true)
  })

  it('refuses to guess when several networks are served and nothing says which', async () => {
    const config = await load({ NEXT_PUBLIC_STELLAR_NETWORKS: 'testnet,mainnet' })
    expect(() => config.activeNetwork()).toThrow(/No Stellar network is selected/)
    config.setNetworkResolver(() => undefined)
    expect(() => config.activeNetwork()).toThrow(/No Stellar network is selected/)
  })

  it('in the browser, uses the network the page set, or the default before that', async () => {
    const config = await load({ NEXT_PUBLIC_STELLAR_NETWORKS: 'testnet,mainnet' })
    vi.stubGlobal('window', {})
    expect(config.activeNetwork()).toBe('testnet')
    config.setClientNetwork('mainnet')
    expect(config.activeNetwork()).toBe('mainnet')
  })
})

describe('chain segments', () => {
  it('reads arc, stellar and the two network segments', async () => {
    const { parseChainSegment } = await load()
    const both = ['testnet', 'mainnet'] as const
    expect(parseChainSegment('arc', both)).toEqual({ slug: 'arc' })
    expect(parseChainSegment('stellar', both)).toEqual({ slug: 'stellar', legacy: true })
    expect(parseChainSegment('stellar-mainnet', both)).toEqual({
      slug: 'stellar',
      network: 'mainnet',
    })
    expect(parseChainSegment('stellar-testnet', both)).toEqual({
      slug: 'stellar',
      network: 'testnet',
    })
  })

  it('rejects a network the deployment does not serve, and anything unknown', async () => {
    const { parseChainSegment } = await load()
    expect(parseChainSegment('stellar-mainnet', ['testnet'])).toBeUndefined()
    expect(parseChainSegment('solana', ['testnet', 'mainnet'])).toBeUndefined()
    expect(parseChainSegment('stellar-pubnet', ['testnet', 'mainnet'])).toBeUndefined()
  })

  it('keeps /stellar as the address when one network is served, and names the network when several are', async () => {
    const single = await load()
    expect(single.chainSegment('stellar', 'testnet')).toBe('stellar')
    expect(single.chainSegments()).toEqual(['arc', 'stellar'])

    const multi = await load({ NEXT_PUBLIC_STELLAR_NETWORKS: 'testnet,mainnet' })
    expect(multi.chainSegment('stellar', 'mainnet')).toBe('stellar-mainnet')
    expect(multi.chainSegment('stellar')).toBe('stellar-testnet')
    expect(multi.chainSegment('arc')).toBe('arc')
    expect(multi.chainSegments()).toEqual(['arc', 'stellar-testnet', 'stellar-mainnet'])
  })
})

describe('the live Stellar objects', () => {
  it('follow the network of the call in progress', async () => {
    const config = await load({ NEXT_PUBLIC_STELLAR_NETWORKS: 'testnet,mainnet' })
    let current: 'testnet' | 'mainnet' = 'mainnet'
    config.setNetworkResolver(() => current)

    expect(config.stellarNetwork.networkPassphrase).toBe(
      'Public Global Stellar Network ; September 2015'
    )
    expect(config.STELLAR_USDC.issuer).toBe(config.stellarMainnet.usdc.issuer)
    expect(config.stellarDescriptor.networkLabel).toBe('Stellar mainnet')

    current = 'testnet'
    expect(config.stellarNetwork.networkPassphrase).toBe('Test SDF Network ; September 2015')
    expect(config.STELLAR_USDC.issuer).toBe(config.stellarTestnet.usdc.issuer)
    expect(config.stellarDescriptor.networkLabel).toBe('Stellar testnet')
  })

  it('spread and enumerate like the plain object they replaced', async () => {
    const config = await load({ NEXT_PUBLIC_STELLAR_NETWORK: 'mainnet' })
    expect({ ...config.stellarNetwork }).toEqual(config.stellarMainnet)
    expect(Object.keys(config.stellarNetwork)).toEqual(Object.keys(config.stellarMainnet))
  })

  it('apply a private RPC to the default network only', async () => {
    const config = await load({
      NEXT_PUBLIC_STELLAR_NETWORK: 'mainnet',
      NEXT_PUBLIC_SOROBAN_RPC_URL: 'https://rpc.example.test',
    })
    expect(config.stellarMainnet.sorobanRpcUrl).toBe('https://rpc.example.test')
    expect(config.stellarTestnet.sorobanRpcUrl).toBe('https://soroban-testnet.stellar.org')
  })
})
