import { isMainnet } from '@intent/config'

import { resolveVerifiedAsset, type VerifiedAsset } from './asset-registry'

/**
 * Assets that exist only on testnet, and must never reach mainnet.
 *
 * Every funded liquidity pool on Stellar testnet trades assets that cannot be
 * verified. Of 142 distinct issuers in funded pools, 139 publish no home
 * domain at all; the single domain that responds lists different assets than
 * the ones claiming it. Six separate pools call their token "USDC", each from
 * a different issuer, none of them Circle.
 *
 * That leaves pool features with a choice: work against unverifiable assets,
 * or show an empty list forever because no verified asset has a pool. This is
 * the third answer — a tier that says plainly what these assets are, is
 * confined to testnet by construction rather than by convention, and leaves
 * the verification rule intact for everything else.
 *
 * The property that matters: an unverified asset is *impossible* to trade on
 * mainnet, not merely discouraged. Registration throws there.
 */

export interface TestnetAsset {
  code: string
  issuer: string
  trust: 'unverified'
  /** Where it was found, so a user can see why the app knows about it at all. */
  discoveredIn?: string
}

/** Anything the app can trade, from either tier. */
export interface TradableAsset {
  code: string
  issuer?: string
  trust: VerifiedAsset['trust'] | 'unverified'
}

/**
 * Registered at runtime rather than hardcoded.
 *
 * Testnet resets quarterly and takes every pool with it, so a baked-in list
 * would be stale within months and wrong in a way nothing would notice. These
 * are discovered from Horizon and registered by the caller.
 */
const registered = new Map<string, TestnetAsset>()

const ACCOUNT_ID = /^G[A-Z2-7]{55}$/

/**
 * Admits an unverifiable asset, for testnet only.
 *
 * Throws on mainnet. That is the whole guarantee: the tier cannot be widened
 * by configuration or by a caller forgetting to check, because the failure is
 * at the point of registration rather than at the point of use.
 */
export function registerTestnetAsset(asset: {
  code: string
  issuer: string
  discoveredIn?: string
}): void {
  if (isMainnet()) {
    throw new Error(
      `refusing to register unverified asset ${asset.code}: this tier is testnet-only, ` +
        'and an unverified issuer must never be tradeable on mainnet'
    )
  }

  if (!ACCOUNT_ID.test(asset.issuer)) {
    throw new Error(`issuer ${asset.issuer} is not a valid Stellar account id`)
  }

  registered.set(asset.code.trim().toUpperCase(), {
    code: asset.code.trim().toUpperCase(),
    issuer: asset.issuer,
    trust: 'unverified',
    ...(asset.discoveredIn !== undefined ? { discoveredIn: asset.discoveredIn } : {}),
  })
}

/**
 * Resolves a symbol across both tiers, verified first.
 *
 * The ordering is the security property, not a preference. Six testnet pools
 * issue a token called "USDC" from six different anonymous accounts, and any
 * one of them registered under that code must not displace Circle's. A caller
 * asking for USDC gets the verified one or nothing.
 */
export function resolveTradableAsset(symbol: string): TradableAsset | undefined {
  const verified = resolveVerifiedAsset(symbol)
  if (verified !== undefined) {
    return {
      code: verified.code,
      ...(verified.issuer !== undefined ? { issuer: verified.issuer } : {}),
      trust: verified.trust,
    }
  }

  const testnet = registered.get(symbol.trim().toUpperCase())
  if (testnet === undefined) return undefined
  return { code: testnet.code, issuer: testnet.issuer, trust: 'unverified' }
}

/**
 * Whether an asset could be traded on mainnet.
 *
 * Read by anything that must not act on a testnet-only asset. False for
 * unverified assets and for symbols the app does not know at all — the safe
 * answer for an unknown is the same as for an untrusted one.
 */
export function isMainnetSafe(symbol: string): boolean {
  return resolveVerifiedAsset(symbol) !== undefined
}

/** Everything registered, for display and for tests. */
export function testnetAssets(): TestnetAsset[] {
  return [...registered.values()]
}

/** Drops every registration. Used between tests and on a network switch. */
export function clearTestnetAssets(): void {
  registered.clear()
}
