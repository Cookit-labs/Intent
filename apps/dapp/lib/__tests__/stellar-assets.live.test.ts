import { describe, expect, it } from 'vitest'

import { KNOWN_ASSETS, tradeableSymbols } from '../swap/asset-registry'

/**
 * Checks the asset registry against the network it describes.
 *
 * Every entry claims two things that can only be verified live: that the
 * issuer's home domain names a site, and that the site names the issuer back.
 * A registry entry is a claim about the world, and the world can change —
 * testnet resets quarterly, issuers move domains, and an asset that traded
 * last month may have no market today.
 *
 * The failure this prevents is specific. Testnet is heavily squatted:
 * anonymous accounts issue tokens called "BENJI" and "USDY" with no domain and
 * a single holder, and mainnet has issuers claiming `blackrock.com.se`. A
 * ticker is not an identity, and this file is where that stops being an
 * assertion in a comment.
 */

const live = process.env['SKIP_LIVE'] === '1' ? describe.skip : describe

const HORIZON = 'https://horizon-testnet.stellar.org'

async function account(
  id: string
): Promise<{ home_domain?: string; flags?: Record<string, boolean> }> {
  const res = await fetch(`${HORIZON}/accounts/${id}`)
  if (!res.ok) throw new Error(`Horizon ${res.status} for ${id}`)
  return (await res.json()) as { home_domain?: string; flags?: Record<string, boolean> }
}

/**
 * Whether a stellar.toml lists this exact code from this exact issuer.
 *
 * Splits on currency blocks and compares field by field. Both halves must
 * appear in the *same* block: a file listing the right code in one entry and
 * the right issuer in another is not evidence about either.
 */
function tomlListsCurrency(toml: string, code: string, issuer: string): boolean {
  const blocks = toml.split(/\[\[CURRENCIES\]\]/i).slice(1)
  return blocks.some((block) => {
    const codeMatch = block.match(/^\s*code\s*=\s*"([^"]+)"/m)
    const issuerMatch = block.match(/^\s*issuer\s*=\s*"([^"]+)"/m)
    return codeMatch?.[1] === code && issuerMatch?.[1] === issuer
  })
}

live('every issued asset is who it says it is', () => {
  const issued = Object.values(KNOWN_ASSETS).filter((a) => a.issuer !== undefined)

  it.each(issued.map((a) => [a.code, a] as const))(
    '%s: the issuer names the domain the registry expects',
    async (_code, asset) => {
      const acct = await account(asset.issuer as string)
      expect(acct.home_domain).toBe(asset.homeDomain)
    },
    20_000
  )

  const roundTrip = issued.filter((a) => a.trust === 'round-trip')

  it.each(roundTrip.map((a) => [a.code, a] as const))(
    '%s: that domain names the issuer back',
    async (code, asset) => {
      // The half that matters most, and the reason the registry records a
      // trust level rather than a boolean. A home_domain alone proves nothing:
      // anyone can point their account at a domain they do not own. Only
      // assets claiming `round-trip` are held to this.
      const res = await fetch(`https://${asset.homeDomain}/.well-known/stellar.toml`)
      expect(res.ok, `${asset.homeDomain} did not serve a stellar.toml`).toBe(true)

      const toml = await res.text()
      // Parsed per currency block rather than matched in a window: the two
      // domains format the file differently (`code = "X"` versus `code="X"`,
      // and the issuer above or below the code), and a regex that fits one
      // silently fails the other — reporting a squatted asset as verified, or
      // a genuine one as fake.
      expect(
        tomlListsCurrency(toml, code, asset.issuer as string),
        `${asset.homeDomain} does not list ${code} issued by ${asset.issuer}`
      ).toBe(true)
    },
    20_000
  )
})

live('an asset claiming only a domain is marked as such', () => {
  it('does not claim a round trip USDC cannot pass', async () => {
    // Circle publishes only its mainnet issuer at centre.io, so the canonical
    // testnet USDC issuer names a domain that does not name it back. Found by
    // this suite failing, which is the test earning its place: the registry
    // had claimed full verification.
    const usdc = KNOWN_ASSETS['USDC']
    expect(usdc?.trust).toBe('claimed-only')

    const res = await fetch(`https://${usdc?.homeDomain}/.well-known/stellar.toml`)
    const toml = await res.text()
    expect(
      tomlListsCurrency(toml, 'USDC', usdc?.issuer as string),
      'centre.io now lists the testnet issuer — upgrade USDC to round-trip'
    ).toBe(false)
  }, 20_000)
})

live('assets offered to agents can actually be bought', () => {
  it.each(tradeableSymbols().filter((s) => s !== 'XLM' && s !== 'USDC'))(
    '%s has a live route from XLM',
    async (code) => {
      // Issued is not tradeable. Etherfuse issues four bonds and only one has
      // a market here, so offering the rest to an agent would produce a
      // confident plan that fails at quote time for a reason the user cannot
      // act on.
      const asset = KNOWN_ASSETS[code]
      const params = new URLSearchParams({
        source_asset_type: 'native',
        source_amount: '100',
        destination_assets: `${code}:${asset?.issuer ?? ''}`,
      })
      const res = await fetch(`${HORIZON}/paths/strict-send?${params.toString()}`)
      const body = (await res.json()) as { _embedded?: { records?: unknown[] } }

      expect(
        (body._embedded?.records ?? []).length,
        `${code} is marked tradeable but nothing is quoting it`
      ).toBeGreaterThan(0)
    },
    20_000
  )

  it('does not offer assets with no market', () => {
    // The inverse, checked locally: USTRY and KTB are real, verified, and
    // unbuyable on testnet today.
    const offered = tradeableSymbols()
    expect(offered).not.toContain('USTRY')
    expect(offered).not.toContain('KTB')
  })
})

live('a squatted ticker cannot reach the app', () => {
  it('refuses an asset that is not in the registry', async () => {
    const { resolveAsset } = await import('../swap/assets')
    // These exist on testnet, issued by anonymous accounts with no domain.
    for (const code of ['BENJI', 'USDY', 'USDCoin']) {
      expect(resolveAsset(code), `${code} must not resolve`).toBeUndefined()
    }
  })
})
