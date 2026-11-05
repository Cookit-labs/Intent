import { describe, expect, it } from 'vitest'

import { gateEnabled } from '../server/access-gate'
import {
  bareRedirect,
  homeFor,
  rememberedChain,
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
  it('sends the old unprefixed screens to the same screen on the home chain', () => {
    expect(bareRedirect('/apps', '?x=1', 'stellar-mainnet', undefined)).toBe(
      '/stellar-mainnet/apps?x=1'
    )
    expect(bareRedirect('/history', '', 'stellar', undefined)).toBe('/stellar/history')
    expect(bareRedirect('/competitions/abc', '', 'stellar-mainnet', undefined)).toBe(
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
      expect(bareRedirect(path, '', 'stellar-mainnet', undefined)).toBeUndefined()
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
  it('is paused: open on every network unless the flag is on', () => {
    expect(gateEnabled({}, 'mainnet')).toBe(false)
    expect(gateEnabled({}, 'testnet')).toBe(false)
  })

  it('turns on only when ACCESS_GATE is on, for any network', () => {
    expect(gateEnabled({ ACCESS_GATE: 'on' }, 'testnet')).toBe(true)
    expect(gateEnabled({ ACCESS_GATE: 'on' }, 'mainnet')).toBe(true)
    expect(gateEnabled({ ACCESS_GATE: 'off' }, 'mainnet')).toBe(false)
  })

  it('does not follow the deployment network while paused', () => {
    expect(gateEnabled({ NEXT_PUBLIC_STELLAR_NETWORK: 'mainnet' })).toBe(false)
    expect(gateEnabled({ NEXT_PUBLIC_STELLAR_NETWORK: 'testnet' })).toBe(false)
  })

  it('treats a typo in the flag like unset: off', () => {
    expect(gateEnabled({ ACCESS_GATE: 'maybe' }, 'mainnet')).toBe(false)
  })
})

describe('homeFor', () => {
  it('opens on the chain last connected to', () => {
    expect(homeFor('near', ['mainnet'])).toBe('near')
  })

  it('falls back to the home chain with no cookie, or one naming no chain', () => {
    expect(homeFor(undefined, ['mainnet'])).toBe('stellar')
    expect(homeFor('../evil', ['mainnet'])).toBe('stellar')
    expect(homeFor('stellar-testnet', ['mainnet'])).toBe('stellar')
  })
})

describe('the bare root', () => {
  it('is the connect page, with no chain in the address', () => {
    expect(bareRedirect('/', '', 'stellar', undefined)).toBeUndefined()
  })

  it('opens on the chain remembered from an earlier visit', () => {
    expect(bareRedirect('/', '?a=1', 'stellar', 'near')).toBe('/near/intents?a=1')
  })

  it('ignores a remembered value that names no chain', () => {
    expect(rememberedChain('../evil', ['mainnet'])).toBeUndefined()
    expect(rememberedChain('near', ['mainnet'])).toBe('near')
    expect(rememberedChain(undefined, ['mainnet'])).toBeUndefined()
  })
})
