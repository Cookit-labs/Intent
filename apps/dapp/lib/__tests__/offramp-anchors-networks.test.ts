import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  NO_MAINNET_OFFRAMP,
  anchorOn,
  anchorUnavailableReason,
  anchorsOn,
} from '../offramp/anchors'
import { readExpectation } from '../offramp/read-expectation'

/**
 * Which anchors exist on which network.
 *
 * The SDF test anchor is testnet by definition. MoneyGram's testnet
 * deployment is too; its production deployment exists only once an operator
 * names it — a commercial agreement stands between this app and that domain,
 * and the app must not pretend otherwise. With nothing configured, mainnet
 * has no off-ramp at all, and an offramp intent is refused in those words
 * rather than sent to a test anchor on the wrong network.
 */

const PROD = { MONEYGRAM_PRODUCTION_HOME_DOMAIN: 'stellar.moneygram.com' }

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('which anchors are on which network', () => {
  it('has both on testnet and none on mainnet by default', () => {
    expect(anchorsOn('testnet', {})).toEqual(['testanchor', 'moneygram'])
    expect(anchorsOn('mainnet', {})).toEqual([])
  })

  it('treats a blank production domain as unset', () => {
    expect(anchorsOn('mainnet', { MONEYGRAM_PRODUCTION_HOME_DOMAIN: '  ' })).toEqual([])
  })

  it('adds MoneyGram on mainnet when its production domain is set', () => {
    expect(anchorsOn('mainnet', PROD)).toEqual(['moneygram'])
    const entry = anchorOn('moneygram', 'mainnet', PROD)
    expect(entry).toMatchObject({
      id: 'moneygram',
      homeDomain: 'stellar.moneygram.com',
      // Pinned from https://stellar.moneygram.com/.well-known/stellar.toml,
      // read 2026-09-24, exactly as the testnet keys were pinned.
      signingKey: 'GD5NUMEX7LYHXGXCAD4PGW7JDMOUY2DKRGY5XZHJS5IONVHDKCJYGVCL',
      assets: ['USDC'],
      requiresClientDomain: true,
      networks: ['mainnet'],
    })
    expect(entry?.name).not.toMatch(/testnet/i)
    expect(entry?.what).not.toMatch(/test deployment/i)
  })

  it('keeps the testnet MoneyGram entry on testnet whatever the env says', () => {
    expect(anchorOn('moneygram', 'testnet', PROD)?.homeDomain).toBe('extstellar.moneygram.com')
    expect(anchorOn('testanchor', 'mainnet', PROD)).toBeUndefined()
  })
})

describe('why an anchor cannot be used here', () => {
  it('says nothing on testnet', () => {
    expect(anchorUnavailableReason('testanchor', 'testnet', {})).toBeUndefined()
    expect(anchorUnavailableReason('moneygram', 'testnet', {})).toBeUndefined()
  })

  it('says no off-ramp is configured on mainnet when none is', () => {
    expect(NO_MAINNET_OFFRAMP).toBe('no fiat off-ramp is configured on mainnet yet')
    expect(anchorUnavailableReason('testanchor', 'mainnet', {})).toBe(NO_MAINNET_OFFRAMP)
    expect(anchorUnavailableReason('moneygram', 'mainnet', {})).toBe(NO_MAINNET_OFFRAMP)
  })

  it('names the anchor when another one is configured', () => {
    expect(anchorUnavailableReason('testanchor', 'mainnet', PROD)).toBe(
      'SDF test anchor is not on mainnet'
    )
    expect(anchorUnavailableReason('moneygram', 'mainnet', PROD)).toBeUndefined()
  })

  it('still refuses an id that is not an anchor', () => {
    expect(anchorUnavailableReason('binance', 'testnet', {})).toBe(
      'binance is not an anchor this app uses'
    )
  })
})

describe('reading a withdrawal on mainnet', () => {
  it('refuses before touching the anchor when no off-ramp is configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORK', 'mainnet')
    vi.stubEnv('MONEYGRAM_PRODUCTION_HOME_DOMAIN', '')
    const r = await readExpectation({
      anchorId: 'testanchor',
      transactionId: 'tx-1',
      authToken: 'jwt',
      fetchImpl: () => Promise.reject(new Error('must not be called')),
    })
    expect(r).toEqual({ ok: false, code: 'unknown_anchor', message: NO_MAINNET_OFFRAMP })
  })
})
