import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Signing is refused when the wallet reports a network other than the page's,
 * and never reaches the wallet. A wallet that cannot say which network it is
 * on is still sent the page's passphrase.
 */

const PUBLIC = 'Public Global Stellar Network ; September 2015'
const TESTNET = 'Test SDF Network ; September 2015'

const kit = vi.hoisted(() => ({
  walletNetwork: undefined as string | undefined | 'throws',
  signed: [] as { xdr: string; passphrase: string | undefined }[],
}))

vi.mock('../stellar-kit', () => ({
  ensureKit: () => undefined,
  StellarWalletsKit: {
    getNetwork: async () => {
      if (kit.walletNetwork === 'throws') throw new Error('wallet cannot say')
      return { network: 'x', networkPassphrase: kit.walletNetwork }
    },
    signTransaction: async (xdr: string, opts?: { networkPassphrase?: string }) => {
      kit.signed.push({ xdr, passphrase: opts?.networkPassphrase })
      return { signedTxXdr: `signed:${xdr}` }
    },
    setNetwork: () => undefined,
    selectedModule: { productIcon: '', productName: 'Test' },
  },
}))
vi.mock('../api/auth', () => ({
  clearSession: () => undefined,
  ensureSession: async () => undefined,
}))
vi.mock('@creit.tech/stellar-wallets-kit/types', () => ({
  Networks: { PUBLIC: 'PUBLIC', TESTNET: 'TESTNET' },
}))

async function adapter(network: 'testnet' | 'mainnet') {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORK', network)
  vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORKS', '')
  const mod = await import('../adapters/stellar-adapter')
  return mod.stellarAdapterFor(network)
}

afterEach(() => {
  kit.walletNetwork = undefined
  kit.signed = []
  vi.unstubAllEnvs()
  vi.resetModules()
})

const REQUEST = { xdr: 'AAAA', address: 'G'.padEnd(56, 'A') }

describe('signStellarTransaction', () => {
  it('refuses, without calling the wallet, when the wallet is on the other network', async () => {
    const a = await adapter('mainnet')
    kit.walletNetwork = TESTNET
    const out = await a.signTransaction?.(REQUEST)
    expect(out).toMatchObject({ ok: false, reason: 'wrong_network' })
    expect(kit.signed).toEqual([])
  })

  it('signs, for the page’s network, when the wallet is on it', async () => {
    const a = await adapter('mainnet')
    kit.walletNetwork = PUBLIC
    const out = await a.signTransaction?.(REQUEST)
    expect(out).toEqual({ ok: true, signedXdr: 'signed:AAAA' })
    expect(kit.signed).toEqual([{ xdr: 'AAAA', passphrase: PUBLIC }])
  })

  it('still signs, with the passphrase attached, when the wallet cannot report its network', async () => {
    const a = await adapter('testnet')
    kit.walletNetwork = 'throws'
    const out = await a.signTransaction?.(REQUEST)
    expect(out).toMatchObject({ ok: true })
    expect(kit.signed[0]?.passphrase).toBe(TESTNET)
  })
})
