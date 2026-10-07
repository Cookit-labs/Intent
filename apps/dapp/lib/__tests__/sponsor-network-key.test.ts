import { Keypair } from '@stellar/stellar-sdk'
import { describe, expect, it } from 'vitest'

import { feePaidBy, sponsorAccount, sponsorConfigured, sponsorKey } from '../sponsor/sponsor'

/**
 * Which fee sponsor a network uses. A testnet key must never pay on mainnet,
 * and a key set without a network belongs to the deployment's default one.
 */

const TEST = Keypair.random()
const MAIN = Keypair.random()
const SHARED = Keypair.random()
const DB = 'postgresql://x@localhost/x'

describe('sponsorKey', () => {
  it('uses the key named for the network', () => {
    const env = {
      SPONSOR_SECRET_KEY_TESTNET: TEST.secret(),
      SPONSOR_SECRET_KEY_MAINNET: MAIN.secret(),
    }
    expect(sponsorKey(env, 'testnet')).toBe(TEST.secret())
    expect(sponsorKey(env, 'mainnet')).toBe(MAIN.secret())
  })

  it('lets the plain key serve the default network, and only that one', () => {
    const env = { SPONSOR_SECRET_KEY: SHARED.secret(), NEXT_PUBLIC_STELLAR_NETWORK: 'testnet' }
    expect(sponsorKey(env, 'testnet')).toBe(SHARED.secret())
    expect(sponsorKey(env, 'mainnet')).toBeUndefined()

    const onMain = { SPONSOR_SECRET_KEY: SHARED.secret(), NEXT_PUBLIC_STELLAR_NETWORK: 'mainnet' }
    expect(sponsorKey(onMain, 'mainnet')).toBe(SHARED.secret())
    expect(sponsorKey(onMain, 'testnet')).toBeUndefined()
  })

  it('prefers the named key over the plain one', () => {
    const env = {
      SPONSOR_SECRET_KEY: SHARED.secret(),
      SPONSOR_SECRET_KEY_TESTNET: TEST.secret(),
      NEXT_PUBLIC_STELLAR_NETWORK: 'testnet',
    }
    expect(sponsorKey(env, 'testnet')).toBe(TEST.secret())
  })

  it('treats a blank value as no key', () => {
    expect(sponsorKey({ SPONSOR_SECRET_KEY_MAINNET: '   ' }, 'mainnet')).toBeUndefined()
  })
})

describe('what a network can say about its sponsor', () => {
  const env = {
    SPONSOR_SECRET_KEY_TESTNET: TEST.secret(),
    DATABASE_URL: DB,
    NEXT_PUBLIC_STELLAR_NETWORK: 'testnet',
  }

  it('is configured only where that network has a key', () => {
    expect(sponsorConfigured(env, 'testnet')).toBe(true)
    expect(sponsorConfigured(env, 'mainnet')).toBe(false)
  })

  it('names the sponsor account of that network, never the other’s', () => {
    expect(sponsorAccount(env, 'testnet')).toBe(TEST.publicKey())
    expect(sponsorAccount(env, 'mainnet')).toBeUndefined()
  })

  it('has the sponsor pay the fee only where a key and a ledger exist', () => {
    expect(feePaidBy(env, 'testnet')).toBe('sponsor')
    expect(feePaidBy(env, 'mainnet')).toBe('account')
  })
})
