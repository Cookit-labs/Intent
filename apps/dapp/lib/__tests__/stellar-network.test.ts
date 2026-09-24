import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Which Stellar network the app is pointed at.
 *
 * One flag, read once at import: `NEXT_PUBLIC_STELLAR_NETWORK`. Testnet is
 * the default so that nothing about a checkout changes; mainnet is the one
 * other value; anything else is a misconfiguration and must fail at import
 * with a message naming the flag, rather than silently defaulting to a
 * network the operator did not choose.
 *
 * The module is re-imported per case because the choice is made at load
 * time — the same moment Next.js inlines the flag into the client bundle.
 */

const ENV = 'NEXT_PUBLIC_STELLAR_NETWORK'

async function loadConfig(network: string | undefined): Promise<typeof import('@intent/config')> {
  vi.resetModules()
  vi.stubEnv(ENV, network as string)
  return import('@intent/config')
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('choosing the network', () => {
  it('is testnet when the flag is unset', async () => {
    const config = await loadConfig(undefined)
    expect(config.activeNetwork()).toBe('testnet')
    expect(config.isMainnet()).toBe(false)
    expect(config.stellarNetwork).toBe(config.stellarTestnet)
    expect(config.stellarNetwork.networkPassphrase).toBe('Test SDF Network ; September 2015')
  })

  it('is testnet when the flag is blank, as an .env line left empty is', async () => {
    const config = await loadConfig('')
    expect(config.activeNetwork()).toBe('testnet')
    expect(config.stellarNetwork).toBe(config.stellarTestnet)
  })

  it('is mainnet when the flag says so', async () => {
    const config = await loadConfig('mainnet')
    expect(config.activeNetwork()).toBe('mainnet')
    expect(config.isMainnet()).toBe(true)
    expect(config.stellarNetwork).toBe(config.stellarMainnet)
  })

  it('refuses any other value at import, naming the flag', async () => {
    await expect(loadConfig('futurenet')).rejects.toThrow(/NEXT_PUBLIC_STELLAR_NETWORK/)
    await expect(loadConfig('futurenet')).rejects.toThrow(/testnet.*mainnet/)
  })
})

describe('the testnet object is unchanged', () => {
  it('keeps every value it had, including friendbot', async () => {
    const { stellarTestnet } = await loadConfig(undefined)
    expect(stellarTestnet).toMatchObject({
      network: 'stellar-testnet',
      name: 'Stellar Testnet',
      freighterNetwork: 'TESTNET',
      networkPassphrase: 'Test SDF Network ; September 2015',
      horizonUrl: 'https://horizon-testnet.stellar.org',
      sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
      friendbotUrl: 'https://friendbot.stellar.org',
      blockExplorerUrl: 'https://stellar.expert/explorer/testnet',
    })
  })
})

describe('the mainnet object', () => {
  it('names the public network with no friendbot', async () => {
    const { stellarMainnet } = await loadConfig('mainnet')
    expect(stellarMainnet).toMatchObject({
      network: 'stellar-mainnet',
      name: 'Stellar Mainnet',
      freighterNetwork: 'PUBLIC',
      networkPassphrase: 'Public Global Stellar Network ; September 2015',
      horizonUrl: 'https://horizon.stellar.org',
      sorobanRpcUrl: 'https://mainnet.sorobanrpc.com',
      blockExplorerUrl: 'https://stellar.expert/explorer/public',
    })
    expect(stellarMainnet.friendbotUrl).toBeUndefined()
    expect('friendbotUrl' in stellarMainnet).toBe(false)
  })

  it('takes the Horizon and RPC overrides for the active network only', async () => {
    vi.stubEnv('NEXT_PUBLIC_STELLAR_HORIZON_URL', 'https://horizon.example')
    vi.stubEnv('NEXT_PUBLIC_SOROBAN_RPC_URL', 'https://rpc.example')
    const onMainnet = await loadConfig('mainnet')
    expect(onMainnet.stellarNetwork.horizonUrl).toBe('https://horizon.example')
    expect(onMainnet.stellarNetwork.sorobanRpcUrl).toBe('https://rpc.example')
    expect(onMainnet.stellarTestnet.horizonUrl).toBe('https://horizon-testnet.stellar.org')

    const onTestnet = await loadConfig(undefined)
    expect(onTestnet.stellarNetwork.horizonUrl).toBe('https://horizon.example')
    expect(onTestnet.stellarMainnet.horizonUrl).toBe('https://horizon.stellar.org')
  })
})

describe('what follows the network', () => {
  it("is Circle's testnet USDC issuer on testnet", async () => {
    const { STELLAR_USDC, stellarNetwork } = await loadConfig(undefined)
    expect(STELLAR_USDC.issuer).toBe('GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5')
    expect(stellarNetwork.usdc).toEqual(STELLAR_USDC)
  })

  it("is Circle's mainnet USDC issuer on mainnet", async () => {
    const { STELLAR_USDC, stellarNetwork, stellarTestnet } = await loadConfig('mainnet')
    expect(STELLAR_USDC).toEqual({
      code: 'USDC',
      issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      decimals: 7,
    })
    expect(stellarNetwork.usdc).toEqual(STELLAR_USDC)
    expect(stellarTestnet.usdc.issuer).toBe(
      'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
    )
  })

  it('labels the descriptor by network', async () => {
    const testnet = await loadConfig(undefined)
    expect(testnet.stellarDescriptor.networkLabel).toBe('Stellar testnet')
    expect(testnet.stellarDescriptor.network).toBe('stellar-testnet')
    expect(testnet.stellarDescriptor.blockExplorerUrl).toBe(
      'https://stellar.expert/explorer/testnet'
    )

    const mainnet = await loadConfig('mainnet')
    expect(mainnet.stellarDescriptor.networkLabel).toBe('Stellar mainnet')
    expect(mainnet.stellarDescriptor.network).toBe('stellar-mainnet')
    expect(mainnet.stellarDescriptor.blockExplorerUrl).toBe(
      'https://stellar.expert/explorer/public'
    )
    expect(mainnet.CHAIN_DESCRIPTORS.stellar.networkLabel).toBe('Stellar mainnet')
  })
})
