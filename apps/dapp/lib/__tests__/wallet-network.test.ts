import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * "Wrong network" for a Stellar wallet.
 *
 * Stellar has no chain id; a wallet reports the passphrase of the network
 * it is on, and the app compares that with the network it is pointed at.
 * The message that follows names the network to switch to, so a user on
 * mainnet is not told to go to testnet.
 */

const PUBLIC = 'Public Global Stellar Network ; September 2015'
const TESTNET = 'Test SDF Network ; September 2015'

async function on(network: 'testnet' | 'mainnet'): Promise<typeof import('../wallet-network')> {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORK', network)
  return import('../wallet-network')
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('on testnet', () => {
  it('flags a wallet on the public network and asks for Stellar Testnet', async () => {
    const { isWrongStellarNetwork, switchNetworkMessage } = await on('testnet')
    expect(isWrongStellarNetwork(PUBLIC)).toBe(true)
    expect(isWrongStellarNetwork(TESTNET)).toBe(false)
    expect(switchNetworkMessage()).toBe('Switch your wallet to Stellar Testnet, then reconnect.')
  })
})

describe('on mainnet', () => {
  it('flags a wallet on testnet and asks for Stellar Mainnet', async () => {
    const { isWrongStellarNetwork, switchNetworkMessage } = await on('mainnet')
    expect(isWrongStellarNetwork(TESTNET)).toBe(true)
    expect(isWrongStellarNetwork(PUBLIC)).toBe(false)
    expect(switchNetworkMessage()).toBe('Switch your wallet to Stellar Mainnet, then reconnect.')
  })
})

describe('before the wallet has said', () => {
  it('is not wrong: nothing has been compared yet', async () => {
    const { isWrongStellarNetwork } = await on('mainnet')
    expect(isWrongStellarNetwork(undefined)).toBe(false)
  })
})
