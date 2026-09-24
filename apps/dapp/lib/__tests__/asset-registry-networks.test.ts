import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * The asset allowlist follows the network.
 *
 * Every Etherfuse entry was verified against `sand.etherfuse.com` — its
 * sandbox — so those issuers exist on testnet and nowhere else. On mainnet
 * they are simply unknown: an agent is not offered a sandbox T-bill, and a
 * builder cannot open a trustline to it. USDC follows Circle's issuer for
 * the network, and on mainnet that issuer is the one centre.io lists, so it
 * earns the full round trip rather than the testnet caveat.
 */

type Registry = typeof import('../swap/asset-registry')

async function load(network: 'testnet' | 'mainnet'): Promise<Registry> {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORK', network)
  return import('../swap/asset-registry')
}

let testnet: Registry
let mainnet: Registry

beforeAll(async () => {
  testnet = await load('testnet')
  mainnet = await load('mainnet')
  vi.unstubAllEnvs()
}, 60_000)

afterAll(() => {
  vi.resetModules()
})

describe('on testnet, nothing moved', () => {
  it('still knows the Etherfuse bonds and the testnet USDC', () => {
    expect(testnet.verifiedSymbols()).toEqual(['XLM', 'USDC', 'CETES', 'USTRY', 'KTB'])
    expect(testnet.tradeableSymbols()).toEqual(['XLM', 'USDC', 'CETES'])
    expect(testnet.realWorldAssets().map((a) => a.code)).toEqual(['CETES', 'USTRY', 'KTB'])
    expect(testnet.resolveVerifiedAsset('USDC')).toMatchObject({
      issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      trust: 'claimed-only',
    })
    expect(testnet.needsTrustCaution('USDC')).toBe(true)
  })
})

describe('on mainnet', () => {
  it('knows only XLM and USDC', () => {
    expect(mainnet.verifiedSymbols()).toEqual(['XLM', 'USDC'])
    expect(mainnet.tradeableSymbols()).toEqual(['XLM', 'USDC'])
    expect(mainnet.realWorldAssets()).toEqual([])
    for (const bond of ['CETES', 'USTRY', 'KTB']) {
      expect(
        mainnet.resolveVerifiedAsset(bond),
        `${bond} must be unknown on mainnet`
      ).toBeUndefined()
      expect(mainnet.isVerified(bond)).toBe(false)
      expect(mainnet.trustSummary(bond)).toBeUndefined()
    }
  })

  it("trusts Circle's mainnet USDC fully, with no caution", () => {
    expect(mainnet.resolveVerifiedAsset('USDC')).toMatchObject({
      issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      homeDomain: 'centre.io',
      trust: 'round-trip',
    })
    expect(mainnet.needsTrustCaution('USDC')).toBe(false)
    expect(mainnet.trustSummary('USDC')).toMatch(/centre\.io confirms this issuer/)
  })
})
