import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * The asset allowlist follows the network.
 *
 * Etherfuse has two issuers: `sand.etherfuse.com` is its sandbox and
 * `etherfuse.com` is mainnet, and each exists on its own network only. A
 * sandbox T-bill must never resolve on mainnet, or the other way round. USDC
 * follows Circle's issuer for the network, and on mainnet that issuer is the
 * one centre.io lists, so it earns the full round trip rather than the
 * testnet caveat.
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

const SANDBOX_ISSUER = 'GC3CW7EDYRTWQ635VDIGY6S4ZUF5L6TQ7AA4MWS7LEQDBLUSZXV7UPS4'
const MAINNET_ISSUER = 'GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC'

describe('on mainnet', () => {
  it('knows the Etherfuse bonds under the mainnet issuer, never the sandbox one', () => {
    expect(mainnet.verifiedSymbols()).toEqual(['XLM', 'USDC', 'CETES', 'USTRY', 'KTB'])
    expect(mainnet.realWorldAssets().map((a) => a.code)).toEqual(['CETES', 'USTRY', 'KTB'])
    for (const bond of ['CETES', 'USTRY', 'KTB']) {
      expect(mainnet.resolveVerifiedAsset(bond), bond).toMatchObject({
        issuer: MAINNET_ISSUER,
        homeDomain: 'etherfuse.com',
        trust: 'round-trip',
      })
      expect(mainnet.resolveVerifiedAsset(bond)?.issuer).not.toBe(SANDBOX_ISSUER)
      expect(mainnet.trustSummary(bond)).toMatch(/etherfuse\.com confirms this issuer/)
    }
  })

  it('offers only the bonds with a market, which is not KTB', () => {
    // Measured on Horizon 2026-10-01: CETES and USTRY have deep USDC books,
    // KTB has 102 units outstanding and no asks.
    expect(mainnet.tradeableSymbols()).toEqual(['XLM', 'USDC', 'CETES', 'USTRY'])
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
