import { afterEach, describe, expect, it, vi } from 'vitest'

import { createRateLimiter } from '../server/rate-limit'
import { fakeRateLimitDb } from './fakes/rate-limit-db'

/**
 * Rate-limit buckets per network. One address using testnet must not use up
 * its allowance on mainnet, and the other way round.
 */

async function setup(multi: boolean) {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORK', 'testnet')
  vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORKS', multi ? 'testnet,mainnet' : '')
  const config = await import('@intent/config')
  const limits = await import('../server/rate-limit')
  const db = fakeRateLimitDb()
  const limiter = limits.createRateLimiter(db.query)
  return { config, limits, db, deps: { limiter: async () => limiter, env: {} } }
}

afterEach(async () => {
  const config = await import('@intent/config')
  config.setNetworkResolver(undefined)
  vi.unstubAllEnvs()
  vi.resetModules()
})

const post = () =>
  new Request('http://localhost/api/swap/build', {
    method: 'POST',
    headers: { 'x-forwarded-for': '203.0.113.5' },
    body: '{}',
  })

void createRateLimiter

describe('buckets when several networks are served', () => {
  it('counts each network separately for the same address', async () => {
    const { config, limits, db, deps } = await setup(true)
    let current: 'testnet' | 'mainnet' = 'testnet'
    config.setNetworkResolver(() => current)

    await limits.enforceRateLimit(post(), 'build', undefined, deps)
    current = 'mainnet'
    await limits.enforceRateLimit(post(), 'build', undefined, deps)

    const keys = [...db.counts.keys()].map((k) => k.split('|')[0]).sort()
    expect(keys).toEqual(['ip:203.0.113.5:build:mainnet', 'ip:203.0.113.5:build:testnet'])
  })

  it('does not let a flood on one network refuse the other', async () => {
    const { config, limits, deps } = await setup(true)
    let current: 'testnet' | 'mainnet' = 'testnet'
    config.setNetworkResolver(() => current)
    const env = { RATE_LIMIT_BUILD: '2/60' }

    await limits.enforceRateLimit(post(), 'build', undefined, { ...deps, env })
    await limits.enforceRateLimit(post(), 'build', undefined, { ...deps, env })
    const refused = await limits.enforceRateLimit(post(), 'build', undefined, { ...deps, env })
    expect(refused?.status).toBe(429)

    current = 'mainnet'
    expect(
      await limits.enforceRateLimit(post(), 'build', undefined, { ...deps, env })
    ).toBeUndefined()
  })
})

describe('buckets when one network is served', () => {
  it('keeps the keys exactly as they were', async () => {
    const { limits, db, deps } = await setup(false)
    await limits.enforceRateLimit(post(), 'build', undefined, deps)
    expect([...db.counts.keys()].map((k) => k.split('|')[0])).toEqual(['ip:203.0.113.5:build'])
  })
})
