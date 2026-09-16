import { describe, expect, it } from 'vitest'

import {
  KNOWN_ASSETS,
  isVerified,
  resolveVerifiedAsset,
  needsTrustCaution,
  tradeableSymbols,
  trustRank,
  trustSummary,
  verificationOf,
} from '../swap/asset-registry'

/**
 * Which assets this app will trade, and why each one is trusted.
 *
 * The allowlist was XLM and USDC, which protected the app by accident: there
 * was nothing to impersonate. Adding real-world assets removes that accident,
 * and testnet is heavily squatted — anonymous accounts issue tokens called
 * "BENJI" and "USDY" with no domain and one holder, and mainnet has issuers
 * claiming `blackrock.com.se`.
 *
 * A ticker is not an identity. The issuer is, and an issuer is only trusted
 * when its home domain names it back.
 */

describe('the allowlist is an allowlist', () => {
  it('resolves an asset it knows', () => {
    expect(resolveVerifiedAsset('USDC')?.code).toBe('USDC')
    expect(resolveVerifiedAsset('CETES')?.code).toBe('CETES')
  })

  it('is case and whitespace insensitive', () => {
    expect(resolveVerifiedAsset('  cetes ')?.code).toBe('CETES')
  })

  it('refuses a symbol it does not know', () => {
    // The exact failure this exists to prevent: an agent reading free text and
    // resolving "SCAMCOIN" to whichever issuer answers to the name.
    expect(resolveVerifiedAsset('SCAMCOIN')).toBeUndefined()
    expect(resolveVerifiedAsset('BENJI')).toBeUndefined()
    expect(resolveVerifiedAsset('USDY')).toBeUndefined()
  })

  it('pins every issued asset to one specific issuer', () => {
    // Sharing a ticker is not sharing an identity. Without the issuer, "USDC"
    // means whichever account got there first.
    for (const asset of Object.values(KNOWN_ASSETS)) {
      if (asset.code === 'XLM') continue
      expect(asset.issuer, `${asset.code} must name an issuer`).toMatch(/^G[A-Z2-7]{55}$/)
    }
  })
})

describe('every asset says why it is trusted', () => {
  it('records the domain that vouches for an issued asset', () => {
    // Verified by round trip: the issuer's home_domain is this, and that
    // domain's stellar.toml names this issuer back. One direction alone proves
    // nothing — anyone can point a home_domain at a site they do not own.
    expect(verificationOf('CETES')?.homeDomain).toBe('sand.etherfuse.com')
    expect(verificationOf('USDC')?.homeDomain).toBe('centre.io')
  })

  it('treats the native asset as trusted without a domain', () => {
    // XLM has no issuer to verify. It is the network.
    expect(isVerified('XLM')).toBe(true)
    expect(verificationOf('XLM')?.homeDomain).toBeUndefined()
  })

  it('marks an asset unverified when nothing vouches for it', () => {
    expect(isVerified('SCAMCOIN')).toBe(false)
  })

  it('says what each real-world asset actually is', () => {
    // Shown to the user before they buy. "CETES" alone is not informative.
    expect(verificationOf('CETES')?.description).toMatch(/Mexican/i)
    expect(verificationOf('USTRY')?.description).toMatch(/Treasur/i)
  })
})

describe('real-world assets are distinguishable from currencies', () => {
  it('flags which assets are real-world debt', () => {
    // `category` is what the asset *is*; how Stellar encodes it is a separate
    // question and the answer is always "classic" here. Overloading one field
    // for both made a treasury bill and a payment format the same kind of
    // thing.
    expect(KNOWN_ASSETS['CETES']?.category).toBe('rwa')
    expect(KNOWN_ASSETS['USDC']?.category).toBe('stablecoin')
    expect(KNOWN_ASSETS['XLM']?.category).toBe('native')
  })

  it('carries every Etherfuse bond that the toml lists', () => {
    for (const code of ['CETES', 'USTRY', 'KTB']) {
      expect(KNOWN_ASSETS[code], `${code} missing`).toBeDefined()
    }
  })
})

/**
 * Issued is not the same as tradeable.
 *
 * Etherfuse issues four bonds on testnet and only CETES has a market. An agent
 * offered the full list would confidently propose buying US treasuries, and
 * the plan would fail at quote time for a reason the user cannot act on.
 */
describe('agents are only offered assets with a market', () => {
  it('includes an asset that is actually quoted', () => {
    // Verified live: 100 XLM buys ~2,299 CETES across two routes.
    expect(tradeableSymbols()).toContain('CETES')
  })

  it('excludes issued assets nothing is quoting', () => {
    const tradeable = tradeableSymbols()
    expect(tradeable).not.toContain('USTRY')
    expect(tradeable).not.toContain('KTB')
  })

  it('still lists them as known, so holding one is understood', () => {
    // The distinction matters: an account may already hold USTRY, and the app
    // should name it correctly even though it cannot be bought here.
    expect(isVerified('USTRY')).toBe(true)
    expect(verificationOf('USTRY')?.description).toMatch(/Treasur/i)
  })
})

/**
 * How well an issuer is verified must reach the people relying on it.
 *
 * Recording a trust level and then never reading it is documentation, not a
 * control. The distinction only becomes real when an agent reasoning about an
 * asset, and a user about to buy one, can both see it.
 *
 * The case that forced this: `centre.io` publishes only Circle's *mainnet*
 * issuer, so the canonical testnet USDC names a domain that does not name it
 * back. Not fraud — but weaker evidence than Etherfuse has, and treating the
 * two as equivalent makes the stronger check worthless.
 */
describe('trust level is legible, not just recorded', () => {
  it('states the strongest evidence for a round-trip asset', () => {
    expect(trustSummary('CETES')).toMatch(/sand\.etherfuse\.com/)
    expect(trustSummary('CETES')).toMatch(/confirms/i)
  })

  it('says plainly when a domain has not confirmed the issuer', () => {
    const summary = trustSummary('USDC')
    expect(summary).toMatch(/centre\.io/)
    // The user should be able to tell this apart from a full verification at a
    // glance, without knowing what "round trip" means.
    expect(summary).toMatch(/not confirmed|unconfirmed|does not list/i)
  })

  it('does not imply an issuer for the native asset', () => {
    expect(trustSummary('XLM')).toMatch(/native/i)
  })

  it('returns nothing for an asset it does not know', () => {
    expect(trustSummary('SCAMCOIN')).toBeUndefined()
  })

  it('ranks round-trip above claimed-only', () => {
    // Used to order and to warn, so the ordering has to be explicit rather
    // than implied by declaration order in the registry.
    expect(trustRank('CETES')).toBeGreaterThan(trustRank('USDC'))
    expect(trustRank('XLM')).toBeGreaterThan(trustRank('USDC'))
  })

  it('flags which assets warrant a caution before buying', () => {
    // XLM needs no caution: there is no issuer to misrepresent it.
    expect(needsTrustCaution('CETES')).toBe(false)
    expect(needsTrustCaution('XLM')).toBe(false)
    expect(needsTrustCaution('USDC')).toBe(true)
  })
})
