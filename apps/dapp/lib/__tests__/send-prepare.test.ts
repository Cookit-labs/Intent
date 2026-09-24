import { Keypair } from '@stellar/stellar-sdk'
import { describe, expect, it } from 'vitest'

import { NameLookupFailed, NameNotFound, UnsupportedRecipient } from '../names/errors'
import type { ResolvedRecipient } from '../names/resolve'
import {
  CannotReceive,
  assertCanReceive,
  expectationFor,
  resolutionFailure,
  unitsForUsd,
} from '../send/prepare'
import { USDC } from '../swap/assets'

/**
 * What sits between a resolved recipient and a payment: sizing a dollar
 * amount, turning the resolution into the expectation the builder checks
 * against, and saying which HTTP answer a failed resolution deserves.
 */

const G = Keypair.random().publicKey()

const ADDRESS: ResolvedRecipient = { input: G, kind: 'address', address: G }
const NAME: ResolvedRecipient = {
  input: 'deon.xlm',
  kind: 'soroban-domain',
  address: G,
  resolvedOn: 'stellar-mainnet',
}
const EXCHANGE: ResolvedRecipient = {
  input: 'alice*lobstr.co',
  kind: 'federation',
  address: G,
  memo: '4242',
  memoType: 'id',
  resolvedOn: 'federation',
}

describe('unitsForUsd', () => {
  it('divides by the price and keeps seven places', () => {
    expect(unitsForUsd('20', 0.16)).toBe('125.0000000')
    expect(unitsForUsd('50', 1)).toBe('50.0000000')
  })

  it('refuses without a usable price rather than guessing one', () => {
    expect(() => unitsForUsd('20', undefined)).toThrow(/price/)
    expect(() => unitsForUsd('20', 0)).toThrow(/price/)
    expect(() => unitsForUsd('20', Number.NaN)).toThrow(/price/)
  })

  it('refuses an amount that is not a positive number', () => {
    expect(() => unitsForUsd('abc', 1)).toThrow(/amount/)
    expect(() => unitsForUsd('0', 1)).toThrow(/amount/)
  })
})

describe('expectationFor', () => {
  it('names the destination the resolution gave and the asset the app trades', () => {
    expect(expectationFor(NAME, 'XLM', '5')).toEqual({
      recipientInput: 'deon.xlm',
      destination: G,
      amount: '5',
      asset: { code: 'XLM' },
    })
    expect(expectationFor(ADDRESS, 'USDC', '12.5').asset).toEqual({
      code: 'USDC',
      issuer: USDC.issuer,
    })
  })

  it('attaches the user’s memo as text', () => {
    expect(expectationFor(NAME, 'XLM', '5', 'rent')).toMatchObject({
      memo: 'rent',
      memoType: 'text',
    })
  })

  it('carries the recipient’s memo when the resolution named one', () => {
    expect(expectationFor(EXCHANGE, 'USDC', '5')).toMatchObject({ memo: '4242', memoType: 'id' })
  })

  it('refuses a user memo on top of the recipient’s own', () => {
    // One memo per transaction; the exchange's is the one that says whose
    // deposit this is, and silently dropping the user's would hide that.
    expect(() => expectationFor(EXCHANGE, 'USDC', '5', 'rent')).toThrow(/memo/)
  })

  it('accepts the user restating the recipient’s memo', () => {
    expect(expectationFor(EXCHANGE, 'USDC', '5', '4242')).toMatchObject({
      memo: '4242',
      memoType: 'id',
    })
  })

  it('ignores an empty memo', () => {
    expect(expectationFor(NAME, 'XLM', '5', '  ')).not.toHaveProperty('memo')
  })

  it('refuses a memo longer than the network allows', () => {
    expect(() => expectationFor(NAME, 'XLM', '5', 'x'.repeat(29))).toThrow(/28 bytes/)
  })

  it('refuses an asset the app does not trade', () => {
    expect(() => expectationFor(NAME, 'DOGE', '5')).toThrow(/DOGE/)
  })

  it('refuses a zero or malformed amount', () => {
    expect(() => expectationFor(NAME, 'XLM', '0')).toThrow(/amount/)
    expect(() => expectationFor(NAME, 'XLM', '-1')).toThrow(/amount/)
    expect(() => expectationFor(NAME, 'XLM', '1.00000001')).toThrow(/decimal/)
  })
})

describe('assertCanReceive', () => {
  // A `.xlm` name resolves on mainnet to an account that need not exist on
  // testnet, and a testnet account need not hold a USDC trustline. Either
  // way the network refuses after the signature, with a code that blames the
  // sender. Asked before, the answer names the recipient.
  const horizon = (body: unknown, status = 200) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
  const funded = { balances: [{ asset_type: 'native', balance: '10.0000000' }] }
  const withUsdc = {
    balances: [
      { asset_type: 'native', balance: '10.0000000' },
      {
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: USDC.issuer,
        balance: '1',
      },
    ],
  }

  it('accepts a funded account for XLM', async () => {
    await expect(
      assertCanReceive(NAME, { code: 'XLM' }, { fetchImpl: horizon(funded) })
    ).resolves.toBeUndefined()
  })

  it('refuses an account that does not exist on testnet, naming the recipient', async () => {
    const check = assertCanReceive(NAME, { code: 'XLM' }, { fetchImpl: horizon({}, 404) })
    await expect(check).rejects.toThrow(CannotReceive)
    await expect(
      assertCanReceive(NAME, { code: 'XLM' }, { fetchImpl: horizon({}, 404) })
    ).rejects.toThrow(/deon\.xlm.*does not exist on testnet/)
  })

  it('refuses an issued asset the account has no trustline for', async () => {
    await expect(
      assertCanReceive(
        NAME,
        { code: 'USDC', issuer: USDC.issuer as string },
        { fetchImpl: horizon(funded) }
      )
    ).rejects.toThrow(/trustline/)
  })

  it('accepts an issued asset the account holds a trustline for', async () => {
    await expect(
      assertCanReceive(
        NAME,
        { code: 'USDC', issuer: USDC.issuer as string },
        { fetchImpl: horizon(withUsdc) }
      )
    ).resolves.toBeUndefined()
  })

  it('does not mistake a same-code trustline from another issuer', async () => {
    const other = {
      balances: [
        { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: G, balance: '1' },
      ],
    }
    await expect(
      assertCanReceive(
        NAME,
        { code: 'USDC', issuer: USDC.issuer as string },
        { fetchImpl: horizon(other) }
      )
    ).rejects.toThrow(/trustline/)
  })

  it('reports a Horizon failure as an ordinary error, not a refusal', async () => {
    await expect(
      assertCanReceive(NAME, { code: 'XLM' }, { fetchImpl: horizon({}, 503) })
    ).rejects.not.toThrow(CannotReceive)
  })
})

describe('resolutionFailure', () => {
  it('maps each failure to its status and code', () => {
    expect(resolutionFailure(new NameNotFound('deon.xlm is not registered'))).toEqual({
      status: 404,
      code: 'not_found',
      error: 'deon.xlm is not registered',
    })
    expect(resolutionFailure(new NameLookupFailed('rpc down')).status).toBe(502)
    expect(resolutionFailure(new NameLookupFailed('rpc down')).code).toBe('lookup_failed')
    expect(resolutionFailure(new UnsupportedRecipient('no')).status).toBe(400)
    expect(resolutionFailure(new UnsupportedRecipient('no')).code).toBe('unsupported')
  })

  it('treats anything else as a lookup failure', () => {
    expect(resolutionFailure(new Error('boom'))).toEqual({
      status: 502,
      code: 'lookup_failed',
      error: 'boom',
    })
    expect(resolutionFailure('boom').status).toBe(502)
  })
})
