import type { VenueCategory } from '@intent/types'
import { describe, expect, it } from 'vitest'

import { chainHelp } from '../chains/explain'
import { nearCapabilities } from '../chains/near/capabilities'
import { nearModule } from '../chains/near/module'
import { nearVenues } from '../chains/near/venues'
import { ChainActionRefused } from '../chains/types'
import { venues } from '../venues'

const CATEGORIES: readonly VenueCategory[] = [
  'swap',
  'aggregator',
  'orderbook',
  'lending',
  'rwa',
  'savings',
  'staking',
  'payments',
  'pool',
  'offramp',
  'perps',
  'names',
  'infrastructure',
]

describe('the NEAR venue list', () => {
  it('has every row of the report, with the fields filled in', () => {
    expect(nearVenues).toHaveLength(14)
    for (const venue of nearVenues) {
      expect(venue.family).toBe('near')
      expect(venue.chains).toEqual(['NEAR'])
      expect(CATEGORIES).toContain(venue.category)
      expect(venue.url).toMatch(/^https:\/\//)
      expect(venue.bestFor.length).toBeGreaterThan(10)
    }
  })

  it('has ids that are unique across the whole app', () => {
    const ids = venues.map((v) => v.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('claims execution exactly for the venues the module wires', () => {
    const claimed = nearVenues.filter((v) => v.integration === 'executes').map((v) => v.id)
    // A wallet transfer is not an app, so the Apps list has no entry for it.
    const wired = nearModule.venues.map((v) => v.id).filter((id) => id !== 'send')
    expect(claimed.sort()).toEqual(wired.sort())
    for (const venue of nearVenues) {
      if (venue.integration === 'executes') expect(venue.capability).toBeTruthy()
      else expect(venue.capability).toBeUndefined()
    }
  })

  it('keeps Rhea Lend and the Linq route listed, and says why on the first', () => {
    const lend = nearVenues.find((v) => v.id === 'rhea-lend')
    expect(lend?.integration).toBeUndefined()
    expect(lend?.bestFor).toMatch(/18\.4M/)
    expect(nearVenues.find((v) => v.id === 'near-linq-cashout')?.integration).toBeUndefined()
  })

  it('never implies a guaranteed return', () => {
    for (const venue of nearVenues) {
      expect(`${venue.bestFor} ${venue.capability ?? ''}`).not.toMatch(
        /guarantee|risk-free|safe yield/i
      )
    }
  })
})

describe('NEAR capabilities', () => {
  it('names one line per wired kind and venue, in words the venue picker understands', () => {
    for (const capability of nearCapabilities) {
      const wanted = capability.venue.toLowerCase()
      const venue = nearModule.venues.find(
        (v) =>
          v.kinds.includes(capability.kind) &&
          (v.id.toLowerCase() === wanted || v.name.toLowerCase().includes(wanted))
      )
      expect(venue, capability.venue).toBeDefined()
    }
    const kinds = new Set(nearModule.venues.flatMap((v) => [...v.kinds]))
    for (const kind of kinds) {
      expect(nearCapabilities.some((c) => c.kind === kind)).toBe(true)
    }
  })

  it('gives help text that can be copied', () => {
    const help = chainHelp('NEAR', nearCapabilities)
    expect(help).toContain('"swap 10 USDC to NEAR"')
    expect(help).toContain('"stake 1 NEAR with Meta Pool"')
    expect(help).toContain('"stake 1 NEAR with rNEAR"')
    expect(help).toContain('"supply 25 USDC on 1Click Earn"')
  })
})

describe('1Click Earn', () => {
  const ME = 'alice.near'
  const DEPOSIT = 'dc2c3034e3ebefa1af9a2c419f896d7b761a056244099eefcd09aeb7efc1b86d'
  const transfer = {
    type: 'FunctionCall' as const,
    params: {
      methodName: 'ft_transfer',
      args: { receiver_id: DEPOSIT, amount: '1000000' },
      gas: '30000000000000',
      deposit: '1',
    },
  }
  const earn = nearModule.venues.find((v) => v.id === '1click-earn')

  it('is the default for supply and does nothing else', () => {
    expect(nearModule.defaultVenue.supply).toBe('1click-earn')
    expect(earn?.kinds).toEqual(['supply'])
  })

  it('accepts a stablecoin deposit and refuses the wrap path a swap may use', () => {
    const usdc = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'
    const payload = (receiverId: string, actions: (typeof transfer)[]) => ({
      family: 'near' as const,
      transactions: [{ receiverId, actions }],
    })
    expect(() => earn?.assertSafe(payload(usdc, [transfer]), ME)).not.toThrow()
    expect(() => earn?.assertSafe(payload('usdt.tether-token.near', [transfer]), ME)).not.toThrow()
    expect(() => earn?.assertSafe(payload('evil.near', [transfer]), ME)).toThrow(ChainActionRefused)
    const wrap = {
      ...transfer,
      params: { ...transfer.params, methodName: 'near_deposit', args: {}, deposit: '1000000' },
    }
    expect(() =>
      earn?.assertSafe(payload('wrap.near', [wrap as typeof transfer, transfer]), ME)
    ).toThrow(ChainActionRefused)
  })

  it('refuses anything but a stablecoin, before asking for a quote', async () => {
    const supply = (tokenIn: string) => ({ kind: 'supply' as const, amount: '50', tokenIn })
    await expect(earn?.prepare(supply('NEAR'), ME)).rejects.toThrow(/takes USDC or USDT/)
    await expect(earn?.prepare(supply('DOGE'), ME)).rejects.toThrow(/takes USDC or USDT/)
    await expect(
      earn?.prepare({ kind: 'swap', amount: '50', tokenIn: 'USDC', tokenOut: 'NEAR' }, ME)
    ).rejects.toThrow(/takes USDC or USDT/)
  })
})
