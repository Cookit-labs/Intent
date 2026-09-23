import { describe, expect, it } from 'vitest'

import { isDefindexConfigured } from '../lend/defindex/config'
import {
  DEFAULT_LENDING_VENUE,
  configuredLendingVenues,
  isLendingVenueId,
  lendingVenueName,
} from '../lend/venues'

/**
 * Which lending venues a deployment can actually reach.
 *
 * Blend needs no configuration: its pool is a public contract read over
 * public RPC. DeFindex builds its deposit through a keyed API, so without
 * `DEFINDEX_API_KEY` there is nothing this app can do there — and a venue
 * that cannot be reached must be absent from what the agents are offered,
 * not present and failing at signing time. The same gate the model providers
 * use: `isConfigured` decides who is in the line-up.
 */

describe('which lending venues a deployment offers', () => {
  it('offers Blend with no configuration at all', () => {
    expect(configuredLendingVenues({})).toEqual(['blend'])
  })

  it('adds DeFindex only when its API key is set', () => {
    expect(configuredLendingVenues({ DEFINDEX_API_KEY: 'sk_test' })).toEqual(['blend', 'defindex'])
  })

  it('treats an empty or blank key as unset', () => {
    // An `.env` line left as `DEFINDEX_API_KEY=` is the common state, and it
    // must read as "not configured" rather than as a key that is empty.
    expect(configuredLendingVenues({ DEFINDEX_API_KEY: '' })).toEqual(['blend'])
    expect(isDefindexConfigured({ DEFINDEX_API_KEY: '   ' })).toBe(false)
    expect(isDefindexConfigured({ DEFINDEX_API_KEY: 'sk_test' })).toBe(true)
  })

  it('keeps Blend first, so it stays the default when no venue is named', () => {
    expect(configuredLendingVenues({ DEFINDEX_API_KEY: 'sk' })[0]).toBe(DEFAULT_LENDING_VENUE)
  })
})

describe('naming a lending venue', () => {
  it('names both integrated venues', () => {
    expect(lendingVenueName('blend')).toBe('Blend')
    expect(lendingVenueName('defindex')).toBe('DeFindex')
  })

  it('falls back to the id for anything else', () => {
    expect(lendingVenueName('aave')).toBe('aave')
  })

  it('recognises only integrated ids', () => {
    expect(isLendingVenueId('blend')).toBe(true)
    expect(isLendingVenueId('defindex')).toBe(true)
    expect(isLendingVenueId('aave')).toBe(false)
  })
})
