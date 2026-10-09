import { homePath, homeSegment } from '@intent/config'
import { describe, expect, it } from 'vitest'

/**
 * Where the app opens: Stellar, and on mainnet whenever the deployment serves
 * it. A deployment that serves one network keeps its one `/stellar` address.
 */
describe('where the app opens', () => {
  it('opens on Stellar mainnet when both networks are served, in either order', () => {
    expect(homeSegment(['testnet', 'mainnet'])).toBe('stellar-mainnet')
    expect(homeSegment(['mainnet', 'testnet'])).toBe('stellar-mainnet')
  })

  it('keeps the single /stellar address when one network is served, whichever it is', () => {
    expect(homeSegment(['testnet'])).toBe('stellar')
    expect(homeSegment(['mainnet'])).toBe('stellar')
  })

  it('opens on the intents page of that segment', () => {
    expect(homePath(['testnet', 'mainnet'])).toBe('/stellar-mainnet/intents')
    expect(homePath(['testnet'])).toBe('/stellar/intents')
  })
})
