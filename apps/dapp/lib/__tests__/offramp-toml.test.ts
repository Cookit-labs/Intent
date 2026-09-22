import { describe, expect, it } from 'vitest'

import { ANCHORS } from '../offramp/anchors'
import { parseStellarToml, readAnchorToml } from '../offramp/toml'

/**
 * The TOML is the anchor's self-description, fetched over the network. The
 * one field that matters for safety is the signing key: it is compared to the
 * pin, and the network never gets to override the pin.
 */

const GOOD = `
NETWORK_PASSPHRASE = "Test SDF Network ; September 2015"
TRANSFER_SERVER_SEP0024 = "https://testanchor.stellar.org/sep24"
WEB_AUTH_ENDPOINT = "https://testanchor.stellar.org/auth"
SIGNING_KEY = "GCHLHDBOKG2JWMJQBTLSL5XG6NO7ESXI2TAQKZXCXWXB5WI2X6W233PR"
`

const MONEYGRAM_TOML = `
NETWORK_PASSPHRASE = "Test SDF Network ; September 2015"
TRANSFER_SERVER_SEP0024 = "https://moneygram.stellar.org/sep24"
WEB_AUTH_ENDPOINT = "https://moneygram.stellar.org/auth"
SIGNING_KEY = "GCSESAP5ILVM6CWIEGK2SDOCQU7PHVFYYT7JNKRDAQNVQWKD5YEE5ZJ4"
`

function serving(text: string, status = 200): typeof fetch {
  return (() => Promise.resolve(new Response(text, { status }))) as unknown as typeof fetch
}

describe('parseStellarToml', () => {
  it('reads the four fields the offramp needs', () => {
    const t = parseStellarToml(GOOD)
    expect(t.transferServerSep24).toBe('https://testanchor.stellar.org/sep24')
    expect(t.webAuthEndpoint).toBe('https://testanchor.stellar.org/auth')
    expect(t.signingKey).toBe('GCHLHDBOKG2JWMJQBTLSL5XG6NO7ESXI2TAQKZXCXWXB5WI2X6W233PR')
    expect(t.networkPassphrase).toBe('Test SDF Network ; September 2015')
  })

  it('ignores sections and comments', () => {
    const t = parseStellarToml(`# comment\n[DOCUMENTATION]\nORG_NAME="x"\n${GOOD}`)
    expect(t.signingKey).toBeDefined()
  })
})

describe('readAnchorToml', () => {
  it('accepts a TOML whose key matches the pin', async () => {
    const t = await readAnchorToml(ANCHORS.testanchor, serving(GOOD))
    expect(t.webAuthEndpoint).toBe('https://testanchor.stellar.org/auth')
  })

  it('refuses a TOML whose signing key differs from the pin', async () => {
    const swapped = GOOD.replace(
      'GCHLHDBOKG2JWMJQBTLSL5XG6NO7ESXI2TAQKZXCXWXB5WI2X6W233PR',
      'GCSESAP5ILVM6CWIEGK2SDOCQU7PHVFYYT7JNKRDAQNVQWKD5YEE5ZJ4'
    )
    await expect(readAnchorToml(ANCHORS.testanchor, serving(swapped))).rejects.toThrow(
      /refusing anchor.*signing key/
    )
  })

  it('refuses a TOML for another network', async () => {
    const mainnet = GOOD.replace(
      'Test SDF Network ; September 2015',
      'Public Global Stellar Network ; September 2015'
    )
    await expect(readAnchorToml(ANCHORS.testanchor, serving(mainnet))).rejects.toThrow(
      /refusing anchor.*network/
    )
  })

  it('refuses a TOML with no SEP-24 endpoint', async () => {
    const noSep24 = GOOD.replace(/TRANSFER_SERVER_SEP0024.*\n/, '')
    await expect(readAnchorToml(ANCHORS.testanchor, serving(noSep24))).rejects.toThrow(
      /refusing anchor.*SEP-24/
    )
  })

  it('refuses an unreachable TOML', async () => {
    await expect(readAnchorToml(ANCHORS.testanchor, serving('', 503))).rejects.toThrow(/503/)
  })

  it('fetches from the pinned home domain over https', async () => {
    let url = ''
    const spy = ((u: string) => {
      url = u
      return Promise.resolve(new Response(MONEYGRAM_TOML))
    }) as unknown as typeof fetch
    await readAnchorToml(ANCHORS.moneygram, spy)
    expect(url).toBe('https://extstellar.moneygram.com/.well-known/stellar.toml')
  })
})
