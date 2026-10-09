import { describe, expect, it } from 'vitest'

import { gateEnabled } from '../server/access-gate'
import {
  bareRedirect,
  isGateFree,
  legacyStellarRedirect,
  segmentNetwork,
} from '../server/network-route'

describe('segmentNetwork', () => {
  it('names a network only for the two network segments', () => {
    expect(segmentNetwork('stellar-mainnet')).toBe('mainnet')
    expect(segmentNetwork('stellar-testnet')).toBe('testnet')
    expect(segmentNetwork('stellar')).toBeUndefined()
    expect(segmentNetwork('arc')).toBeUndefined()
    expect(segmentNetwork('')).toBeUndefined()
  })
})

describe('legacyStellarRedirect', () => {
  it('sends /stellar to the default network, keeping the path and the query', () => {
    expect(legacyStellarRedirect('/stellar/apps', '?x=1', true, 'testnet')).toBe(
      '/stellar-testnet/apps?x=1'
    )
    expect(legacyStellarRedirect('/stellar', '', true, 'mainnet')).toBe('/stellar-mainnet')
  })

  it('leaves everything else alone, and everything alone when one network is served', () => {
    expect(legacyStellarRedirect('/stellar/apps', '', false, 'testnet')).toBeUndefined()
    expect(legacyStellarRedirect('/stellar-mainnet/apps', '', true, 'testnet')).toBeUndefined()
    expect(legacyStellarRedirect('/stellarx', '', true, 'testnet')).toBeUndefined()
    expect(legacyStellarRedirect('/arc/intents', '', true, 'testnet')).toBeUndefined()
  })
})

describe('bareRedirect', () => {
  it('sends the bare root to the home chain, keeping the query', () => {
    expect(bareRedirect('/', '', 'stellar-mainnet')).toBe('/stellar-mainnet/intents')
    expect(bareRedirect('/', '?rule=r3', 'stellar')).toBe('/stellar/intents?rule=r3')
  })

  it('sends the old unprefixed screens to the same screen on the home chain', () => {
    expect(bareRedirect('/apps', '?x=1', 'stellar-mainnet')).toBe('/stellar-mainnet/apps?x=1')
    expect(bareRedirect('/history', '', 'stellar')).toBe('/stellar/history')
    expect(bareRedirect('/competitions/abc', '', 'stellar-mainnet')).toBe(
      '/stellar-mainnet/competitions/abc'
    )
  })

  it('leaves chain addresses, other pages and look-alikes alone', () => {
    for (const path of [
      '/arc/intents',
      '/stellar/intents',
      '/stellar-mainnet/apps',
      '/verify',
      '/admin/waitlist',
      '/appsx',
      '/intentsx/1',
      '/api/health',
    ]) {
      expect(bareRedirect(path, '', 'stellar-mainnet')).toBeUndefined()
    }
  })
})

describe('isGateFree', () => {
  it('covers the verification, waitlist and admin pages and what is under them', () => {
    expect(isGateFree('/verify')).toBe(true)
    expect(isGateFree('/admin/waitlist')).toBe(true)
    expect(isGateFree('/waitlist')).toBe(true)
    expect(isGateFree('/stellar-mainnet/apps')).toBe(false)
    expect(isGateFree('/adminx')).toBe(false)
  })
})

describe('gateEnabled for a network', () => {
  it('follows the network when the flag is unset: mainnet shut, testnet open', () => {
    expect(gateEnabled({}, 'mainnet')).toBe(true)
    expect(gateEnabled({}, 'testnet')).toBe(false)
  })

  it('lets ACCESS_GATE decide outright, for any network', () => {
    expect(gateEnabled({ ACCESS_GATE: 'on' }, 'testnet')).toBe(true)
    expect(gateEnabled({ ACCESS_GATE: 'off' }, 'mainnet')).toBe(false)
  })

  it('without a network, still follows the deployment network as before', () => {
    expect(gateEnabled({ NEXT_PUBLIC_STELLAR_NETWORK: 'mainnet' })).toBe(true)
    expect(gateEnabled({ NEXT_PUBLIC_STELLAR_NETWORK: 'testnet' })).toBe(false)
  })

  it('treats a typo in the flag like unset, so a mistake on mainnet leaves the door shut', () => {
    expect(gateEnabled({ ACCESS_GATE: 'maybe' }, 'mainnet')).toBe(true)
  })
})
