import { describe, expect, it } from 'vitest'

import { ALL_ANCHORS, ANCHORS, DEFAULT_ANCHOR, isAnchorId, lookupAnchor } from '../offramp/anchors'

/**
 * The anchor allowlist. Mirrors contract-registry: an id not on this list is
 * refused, and every entry pins the signing key the network response must
 * match. Key rotation is a code change here, never a runtime discovery.
 */
describe('anchor registry', () => {
  it('lists both testnet anchors with pinned signing keys', () => {
    expect(ALL_ANCHORS).toEqual(['testanchor', 'moneygram'])
    expect(ANCHORS.testanchor.signingKey).toBe(
      'GCHLHDBOKG2JWMJQBTLSL5XG6NO7ESXI2TAQKZXCXWXB5WI2X6W233PR'
    )
    expect(ANCHORS.moneygram.signingKey).toBe(
      'GCSESAP5ILVM6CWIEGK2SDOCQU7PHVFYYT7JNKRDAQNVQWKD5YEE5ZJ4'
    )
  })

  it('names the home domain the TOML is fetched from', () => {
    expect(ANCHORS.testanchor.homeDomain).toBe('testanchor.stellar.org')
    expect(ANCHORS.moneygram.homeDomain).toBe('extstellar.moneygram.com')
  })

  it('withdraws USDC only', () => {
    for (const id of ALL_ANCHORS) expect(ANCHORS[id].assets).toEqual(['USDC'])
  })

  it('refuses an id that is not an anchor', () => {
    expect(lookupAnchor('binance')).toBeUndefined()
    expect(isAnchorId('binance')).toBe(false)
    expect(isAnchorId('testanchor')).toBe(true)
  })

  it('defaults to the SDF test anchor', () => {
    expect(DEFAULT_ANCHOR).toBe('testanchor')
  })

  it('knows which anchor needs a client domain this deployment lacks', () => {
    expect(ANCHORS.testanchor.requiresClientDomain).toBe(false)
    expect(ANCHORS.moneygram.requiresClientDomain).toBe(true)
  })
})
