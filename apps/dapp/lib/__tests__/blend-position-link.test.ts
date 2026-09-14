import { describe, expect, it } from 'vitest'

import { BLEND_POOL, blendPositionUrl } from '../swap/contract-registry'

/**
 * Linking to the position rather than to the receipt.
 *
 * A supply's explorer link proves the transaction reached a ledger. It says
 * nothing about the position that transaction created — the balance, the rate
 * it earns, whether it can be withdrawn. Someone who has just lent wants the
 * second thing, and the first is what every other step in the app offers.
 */

describe('the Blend position link', () => {
  it('points at the pool that was actually supplied', () => {
    // Parameterised rather than fixed, so a second pool cannot silently link
    // to the first one's dashboard.
    const url = blendPositionUrl(BLEND_POOL)
    expect(url).toContain(BLEND_POOL)
  })

  it('reaches Blend rather than a block explorer', () => {
    const url = blendPositionUrl()
    expect(url).toMatch(/^https:\/\/testnet\.blend\.capital\//)
    expect(url).not.toContain('stellar.expert')
  })

  it('names the testnet deployment', () => {
    // Linking a testnet position to the mainnet dashboard would show an empty
    // account and read as a failed supply.
    expect(blendPositionUrl()).toContain('testnet.')
  })

  it('carries a different pool when given one', () => {
    const other = 'CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD'
    expect(blendPositionUrl(other)).toContain(other)
    expect(blendPositionUrl(other)).not.toContain(BLEND_POOL)
  })
})
