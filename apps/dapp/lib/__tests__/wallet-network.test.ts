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

describe('the prompt when the wallet is on the other network', () => {
  it('names both networks and offers the one the wallet is already on', async () => {
    const { mismatchPrompt } = await on('mainnet')
    expect(mismatchPrompt('mainnet', 'testnet')).toEqual({
      title: 'Your wallet is on Stellar testnet',
      body: 'Switch it to Stellar mainnet to continue, or use Stellar testnet here instead.',
      useWalletNetworkLabel: 'Use Stellar testnet instead',
    })
    expect(mismatchPrompt('testnet', 'mainnet').title).toBe('Your wallet is on Stellar mainnet')
  })

  it('gives Freighter its own steps and every other wallet a plain instruction', async () => {
    const { switchSteps } = await on('mainnet')
    expect(switchSteps('Freighter', 'mainnet')).toMatch(/Freighter.*Network.*Mainnet/i)
    expect(switchSteps('Freighter', 'testnet')).toMatch(/Testnet/)
    expect(switchSteps('xBull', 'mainnet')).toMatch(/xBull/)
    expect(switchSteps(undefined, 'testnet')).toMatch(/wallet.*Stellar testnet/i)
  })
})

describe('refusing to sign on the wrong network', () => {
  it('refuses only when the wallet says it is on a different network', async () => {
    const { refusesToSign } = await on('mainnet')
    expect(refusesToSign(TESTNET, PUBLIC)).toBe(true)
    expect(refusesToSign(PUBLIC, PUBLIC)).toBe(false)
  })

  it('lets a wallet that does not say which network it is on go on, since the passphrase is sent with the request', async () => {
    const { refusesToSign } = await on('mainnet')
    expect(refusesToSign(undefined, PUBLIC)).toBe(false)
  })
})
