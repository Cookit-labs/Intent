import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  isMainnetSafe,
  registerTestnetAsset,
  resolveTradableAsset,
  testnetAssets,
} from '../swap/testnet-assets'

/**
 * Assets that exist only on testnet, and could never be allowed on mainnet.
 *
 * Every funded liquidity pool on Stellar testnet uses assets that cannot be
 * verified: 139 of 142 issuers publish no home domain at all, and the one
 * domain that responds lists different assets than the ones claiming it. Six
 * separate pools call their token "USDC", each from a different issuer.
 *
 * So pool features have a choice: work against unverifiable assets, or display
 * an empty list forever. This is the third option — a tier that admits exactly
 * what these assets are, is confined to testnet by construction, and keeps the
 * verification rule intact for everything else rather than quietly widening
 * it.
 *
 * The bar this must clear: an unverified asset must be *impossible* to trade
 * on mainnet, not merely discouraged.
 */

const ANON_ISSUER = 'GDEYPJPWQKHVGHFXTQPTQ5DJLKKPSZSSGKZM2LIRXGJTWWQ2RCVJ4TCT'

beforeEach(() => {
  vi.unstubAllEnvs()
})

describe('the tier is confined to testnet', () => {
  it('refuses to register an unverified asset on mainnet', () => {
    vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORK', 'mainnet')
    expect(() => registerTestnetAsset({ code: 'RHINO', issuer: ANON_ISSUER })).toThrow(/mainnet/i)
  })

  it('never reports an unverified asset as mainnet-safe', () => {
    registerTestnetAsset({ code: 'RHINO', issuer: ANON_ISSUER })
    expect(isMainnetSafe('RHINO')).toBe(false)
  })

  it('still reports a verified asset as mainnet-safe', () => {
    // The distinction has to survive: adding a permissive tier must not make
    // the strict one meaningless.
    expect(isMainnetSafe('CETES')).toBe(true)
    expect(isMainnetSafe('XLM')).toBe(true)
  })
})

describe('registered testnet assets are usable but marked', () => {
  it('resolves an asset once registered', () => {
    registerTestnetAsset({ code: 'RHINO', issuer: ANON_ISSUER })
    const found = resolveTradableAsset('RHINO')
    expect(found?.issuer).toBe(ANON_ISSUER)
  })

  it('marks it unverified rather than pretending otherwise', () => {
    registerTestnetAsset({ code: 'RHINO', issuer: ANON_ISSUER })
    expect(resolveTradableAsset('RHINO')?.trust).toBe('unverified')
  })

  it('keeps verified assets resolving through the same call', () => {
    // One lookup for both tiers, so a caller cannot accidentally consult only
    // the permissive one.
    expect(resolveTradableAsset('CETES')?.trust).toBe('round-trip')
    expect(resolveTradableAsset('USDC')?.trust).toBe('claimed-only')
  })

  it('does not let a testnet asset shadow a verified one', () => {
    // The attack this tier could otherwise enable: registering "USDC" from an
    // anonymous issuer and having it win the lookup. Six such pools exist.
    registerTestnetAsset({ code: 'USDC', issuer: ANON_ISSUER })
    const resolved = resolveTradableAsset('USDC')
    expect(resolved?.issuer).not.toBe(ANON_ISSUER)
    expect(resolved?.trust).toBe('claimed-only')
  })

  it('refuses an issuer that is not a valid account id', () => {
    expect(() => registerTestnetAsset({ code: 'JUNK', issuer: 'not-an-address' })).toThrow(
      /issuer/i
    )
  })

  it('lists what has been registered, for display', () => {
    registerTestnetAsset({ code: 'RHINO', issuer: ANON_ISSUER })
    expect(testnetAssets().map((a) => a.code)).toContain('RHINO')
  })
})
