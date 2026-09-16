import { STELLAR_USDC } from '@intent/config'

import type { ClassicAsset } from './assets'

/**
 * Which assets this app will trade, and why each one is trusted.
 *
 * The old allowlist held XLM and USDC, and protected the app by accident:
 * with two entries there was nothing to impersonate. Real-world assets remove
 * that accident. Testnet is heavily squatted — anonymous accounts issue tokens
 * called "BENJI" and "USDY" with no home domain and a single holder — and
 * mainnet has issuers claiming domains like `blackrock.com.se`.
 *
 * So a ticker is not an identity here. The issuer is, and an issuer earns a
 * place only by a **round trip**: the account's `home_domain` names a site,
 * and that site's `stellar.toml` names the account back. One direction proves
 * nothing, because anyone can point a home_domain at a domain they do not own.
 *
 * Every entry below was verified that way against live testnet, by hand,
 * before being written down. The verification is recorded rather than implied
 * so a reader can check it rather than trust this comment.
 */

export type AssetKind = 'native' | 'stablecoin' | 'rwa'

export interface VerifiedAsset {
  /** 'XLM' for the native asset. */
  code: string
  /** Absent for native XLM; required for every issued asset. */
  issuer?: string
  /**
   * What sort of thing this is, distinct from how Stellar encodes it. Every
   * asset here is a classic asset; only some of them are sovereign debt.
   */
  category: AssetKind
  /** The domain whose stellar.toml names this issuer. Absent for native XLM. */
  homeDomain?: string
  /**
   * How strongly the issuer's identity is established.
   *
   * `round-trip` is the real thing: the issuer names a domain, and that
   * domain's stellar.toml names the issuer back. Nothing weaker proves
   * ownership, because anyone can point a home_domain at a site they do not
   * control.
   *
   * `claimed-only` means the issuer names a domain that does not list it. That
   * is not evidence of fraud — Circle publishes only its mainnet issuer at
   * centre.io, so canonical testnet USDC lands here — but it is materially
   * weaker, and recording it as equivalent would make the stronger check
   * meaningless.
   *
   * `network` is the native asset, which has no issuer to verify.
   */
  trust: 'round-trip' | 'claimed-only' | 'network'
  /** What the asset actually is, shown before a user commits to buying it. */
  description: string
  /** Decimal places the issuer uses. Stellar classic assets are always 7. */
  decimals: number
  /**
   * Whether anything is currently quoting this asset on testnet.
   *
   * Issued does not mean tradeable. Etherfuse issues four bonds and only CETES
   * has a market here, so an agent proposing a USTRY purchase would produce a
   * plan that cannot fill. Recorded rather than discovered by failing, and
   * checked against Horizon rather than assumed — see `verify-rwa-liquidity`
   * in the repo notes for how to re-check after a testnet reset.
   */
  tradeableOnTestnet: boolean
}

/**
 * Etherfuse issues every one of its bonds from a single account, verified at
 * `sand.etherfuse.com`. Repeated rather than shared so each entry can be
 * checked in isolation — a constant would hide a mismatch.
 */
const ETHERFUSE_ISSUER = 'GC3CW7EDYRTWQ635VDIGY6S4ZUF5L6TQ7AA4MWS7LEQDBLUSZXV7UPS4'
const ETHERFUSE_DOMAIN = 'sand.etherfuse.com'

export const KNOWN_ASSETS: Record<string, VerifiedAsset> = {
  XLM: {
    category: 'native',
    trust: 'network',
    code: 'XLM',
    tradeableOnTestnet: true,
    // No issuer and no domain: XLM is the network, not something issued on it.
    decimals: 7,
    description: 'Stellar Lumens, the network’s native asset',
  },

  USDC: {
    category: 'stablecoin',
    // centre.io lists Circle's *mainnet* issuer only. This testnet issuer
    // claims the domain and the domain does not name it back — verified by
    // fetching both. It is the canonical testnet USDC the whole ecosystem
    // uses, so it stays; the weaker evidence is recorded rather than hidden.
    trust: 'claimed-only',
    code: STELLAR_USDC.code,
    tradeableOnTestnet: true,
    issuer: STELLAR_USDC.issuer,
    decimals: STELLAR_USDC.decimals,
    homeDomain: 'centre.io',
    description: 'US dollar stablecoin issued by Circle',
  },

  // Etherfuse Stablebonds: tokenized sovereign debt, freely tradeable on
  // testnet. The issuer sets no auth flags, so holding one needs a trustline
  // and nothing else — no KYC, no whitelist, no approval server.
  CETES: {
    category: 'rwa',
    trust: 'round-trip',
    // Verified: 100 XLM buys ~2,299 CETES across two routes.
    code: 'CETES',
    tradeableOnTestnet: true,
    issuer: ETHERFUSE_ISSUER,
    decimals: 7,
    homeDomain: ETHERFUSE_DOMAIN,
    description: 'Mexican government treasury bills (Cetes), tokenized by Etherfuse',
  },

  USTRY: {
    category: 'rwa',
    trust: 'round-trip',
    // Issued and domain-verified, but nothing quotes it on testnet today.
    code: 'USTRY',
    tradeableOnTestnet: false,
    issuer: ETHERFUSE_ISSUER,
    decimals: 7,
    homeDomain: ETHERFUSE_DOMAIN,
    description: 'US Treasury bills, tokenized by Etherfuse',
  },

  KTB: {
    category: 'rwa',
    trust: 'round-trip',
    // Issued and domain-verified, but nothing quotes it on testnet today.
    code: 'KTB',
    tradeableOnTestnet: false,
    issuer: ETHERFUSE_ISSUER,
    decimals: 7,
    homeDomain: ETHERFUSE_DOMAIN,
    description: 'Korean treasury bonds, tokenized by Etherfuse',
  },
}

/** The Stellar-encoding view, for code that only cares how to send it. */
export function toClassicAsset(asset: VerifiedAsset): ClassicAsset {
  return asset.issuer === undefined
    ? { kind: 'classic', code: asset.code }
    : { kind: 'classic', code: asset.code, issuer: asset.issuer }
}

/**
 * Resolves a symbol a user or an agent named.
 *
 * Returns nothing for anything unknown, which is the entire point: an intent
 * is free text read by a language model, and "swap my ETH for SCAMCOIN" must
 * fail at this boundary rather than resolve to whichever issuer answers to the
 * name.
 */
export function resolveVerifiedAsset(symbol: string): VerifiedAsset | undefined {
  return KNOWN_ASSETS[symbol.trim().toUpperCase()]
}

export function isVerified(symbol: string): boolean {
  return resolveVerifiedAsset(symbol) !== undefined
}

export interface Verification {
  homeDomain?: string
  description: string
  category: AssetKind
}

/** Why an asset is trusted, for display next to it. */
export function verificationOf(symbol: string): Verification | undefined {
  const asset = resolveVerifiedAsset(symbol)
  if (asset === undefined) return undefined
  return {
    ...(asset.homeDomain !== undefined ? { homeDomain: asset.homeDomain } : {}),
    description: asset.description,
    category: asset.category,
  }
}

/** Symbols the app will trade, for prompts and pickers. */
export function verifiedSymbols(): string[] {
  return Object.keys(KNOWN_ASSETS)
}

/** Just the real-world assets, which need different explanation than a currency. */
export function realWorldAssets(): VerifiedAsset[] {
  return Object.values(KNOWN_ASSETS).filter((a) => a.category === 'rwa')
}

/**
 * Assets an agent may actually propose trading.
 *
 * Narrower than the allowlist on purpose. An asset with no market is safe to
 * hold and impossible to buy, and offering one to an agent invites a confident
 * plan that fails at quote time for reasons the user cannot act on.
 */
export function tradeableSymbols(): string[] {
  return Object.values(KNOWN_ASSETS)
    .filter((a) => a.tradeableOnTestnet)
    .map((a) => a.code)
}

/**
 * How strongly an asset's issuer is established, in words a user can act on.
 *
 * The trust level existed as a field nothing read, which made it a note rather
 * than a control. These three functions are what turn it into one: the agents
 * see it in their prompt, and the user sees it before committing.
 *
 * "Round trip" is jargon; the summaries deliberately avoid it. What matters to
 * someone about to spend money is whether the organisation named actually
 * confirms it issued the thing they are buying.
 */
export function trustSummary(symbol: string): string | undefined {
  const asset = resolveVerifiedAsset(symbol)
  if (asset === undefined) return undefined

  switch (asset.trust) {
    case 'network':
      return 'Native to Stellar — there is no issuer to verify.'
    case 'round-trip':
      return `${asset.homeDomain} confirms this issuer: the site publicly lists this exact issuing account.`
    case 'claimed-only':
      // Stated as the specific gap rather than a vague warning, because the
      // vague version reads as "possibly a scam" and this is not one.
      return `Issuer claims ${asset.homeDomain}, but that site does not list this account — the link is unconfirmed.`
  }
}

/** Higher is better verified. Explicit so ordering does not depend on declaration order. */
export function trustRank(symbol: string): number {
  const asset = resolveVerifiedAsset(symbol)
  if (asset === undefined) return -1
  switch (asset.trust) {
    case 'network':
      return 2
    case 'round-trip':
      return 2
    case 'claimed-only':
      return 1
  }
}

/**
 * Whether to show a caution before someone buys this.
 *
 * Only for assets whose issuer names a domain that has not confirmed it. The
 * native asset needs none — there is no issuer that could misrepresent it —
 * and a fully verified issuer needs none either.
 */
export function needsTrustCaution(symbol: string): boolean {
  return resolveVerifiedAsset(symbol)?.trust === 'claimed-only'
}
