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

describe('naming the network a wallet is on', () => {
  it('recognises both Stellar networks from the passphrase', async () => {
    const { stellarNetworkOf } = await on('testnet')
    expect(stellarNetworkOf(PUBLIC)).toBe('mainnet')
    expect(stellarNetworkOf(TESTNET)).toBe('testnet')
  })

  it('says nothing for a passphrase it does not know, or none', async () => {
    const { stellarNetworkOf } = await on('testnet')
    expect(stellarNetworkOf('Standalone Network ; February 2017')).toBeUndefined()
    expect(stellarNetworkOf(undefined)).toBeUndefined()
  })
})

describe('the mismatch label', () => {
  it('names the network the wallet is on instead of calling it wrong', async () => {
    const { mismatchLabel } = await on('testnet')
    expect(mismatchLabel('mainnet')).toBe('Wallet is on Stellar mainnet')
    expect(mismatchLabel('testnet')).toBe('Wallet is on Stellar testnet')
  })

  it('falls back to the plain label when the network is not known', async () => {
    const { mismatchLabel } = await on('testnet')
    expect(mismatchLabel(undefined)).toBe('Wrong network')
  })
})
