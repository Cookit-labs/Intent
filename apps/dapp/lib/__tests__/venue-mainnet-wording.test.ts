import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { isListedOn, notOnNetworkLabel, venueDetail, venues } from '../venues'

const TESTNET = /test\s?net|test anchor/i

describe('the Apps page on mainnet', () => {
  beforeEach(() => vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORK', 'mainnet'))
  afterEach(() => vi.unstubAllEnvs())

  it('does not list the test anchor', () => {
    const anchor = venues.find((v) => v.id === 'testanchor')
    expect(anchor).toBeDefined()
    expect(isListedOn(anchor!, 'mainnet')).toBe(false)
    expect(isListedOn(anchor!, 'testnet')).toBe(true)
  })

  it('never mentions testnet in what any listed venue shows', () => {
    const mentions = venues
      .filter((v) => isListedOn(v, 'mainnet'))
      .filter((v) => {
        const detail = venueDetail(v, notOnNetworkLabel(v, 'mainnet'))
        return [v.name, v.bestFor, detail].some((text) => TESTNET.test(text))
      })
      .map((v) => v.id)
    expect(mentions).toEqual([])
  })
})

describe('venueDetail', () => {
  const venue = { bestFor: 'Short', capability: 'What it does here' }

  it('gives the capability where the venue works', () => {
    expect(venueDetail(venue, undefined)).toBe('What it does here')
    expect(venueDetail({ bestFor: 'Short' }, undefined)).toBe('Short')
  })

  it('falls back to the summary where it does not', () => {
    expect(venueDetail(venue, 'Not on mainnet yet')).toBe('Short')
  })
})
