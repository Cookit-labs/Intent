import { describe, expect, it } from 'vitest'

import { buildMarketContext } from '../agents/market-context'
import { HEADLINE_KINDS } from '../server/admin-metrics'
import { summariseFlow } from '../server/execution-flow'
import { isVenueOn, venues } from '../venues'

const byId = (id: string) => venues.find((v) => v.id === id)

describe('headline volume', () => {
  it('counts cash-outs, with swaps, plans, offers and sends', () => {
    expect([...HEADLINE_KINDS].sort()).toEqual(['offer', 'offramp', 'plan', 'send', 'swap'])
  })

  it('leaves lending out of it', () => {
    expect(HEADLINE_KINDS).not.toContain('lend')
  })
})

describe('what a payment of USDC is worth', () => {
  const usdc = { asset: 'USDC', amount: '3', verified: true }

  it('is its amount in dollars even when the price oracle gave nothing', () => {
    // A slow oracle used to leave a USDC payment with no value, so a cash-out
    // read as "no price" and added nothing to the volume.
    expect(summariseFlow([usdc], {})?.volumeUsd).toBe(3)
  })

  it('does not depend on the oracle having USDC in its table', () => {
    const xlmOnly = {
      XLM: { symbol: 'XLM', usd: 0.18, source: 'stellar-mainnet' as const, asOf: '' },
    }
    expect(summariseFlow([usdc], xlmOnly)?.volumeUsd).toBe(3)
  })

  it('still needs the oracle for XLM, and leaves it unvalued rather than guessing', () => {
    const xlm = { asset: 'XLM', amount: '10', verified: true }
    expect(summariseFlow([xlm], {})?.volumeUsd).toBeNull()
    expect(
      summariseFlow([xlm], {
        XLM: { symbol: 'XLM', usd: 0.2, source: 'stellar-mainnet' as const, asOf: '' },
      })?.volumeUsd
    ).toBe(2)
  })

  it('does not price a look-alike asset that is not the registry’s USDC', () => {
    const fake = { asset: 'USDC:GFAKEISSUER', amount: '1000', verified: false }
    expect(summariseFlow([fake], {})?.volumeUsd).toBeNull()
  })
})

describe('the apps page', () => {
  it('lists Linq as an executing off-ramp, on mainnet only', () => {
    const linq = byId('linq')
    expect(linq?.category).toBe('offramp')
    expect(linq?.integration).toBe('executes')
    expect(linq && isVenueOn(linq, 'mainnet')).toBe(true)
    expect(linq && isVenueOn(linq, 'testnet')).toBe(false)
  })

  it('lists Horizon as network infrastructure', () => {
    expect(byId('horizon')?.category).toBe('infrastructure')
    expect(byId('horizon')?.integration).toBe('executes')
  })

  it('never offers either to the agents as a place to trade', () => {
    for (const network of ['testnet', 'mainnet'] as const) {
      const offered = buildMarketContext('stellar', {}, network).venues.map((v) => v.id)
      expect(offered).not.toContain('linq')
      expect(offered).not.toContain('horizon')
      // The venues that really do fill are still there.
      expect(offered).toContain('soroswap')
    }
  })
})
