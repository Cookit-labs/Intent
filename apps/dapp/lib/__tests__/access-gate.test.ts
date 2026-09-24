import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { gateEnabled } from '../server/access-gate'

/**
 * Whether the OTP access gate is on.
 *
 * `ACCESS_GATE` decides outright; unset, the gate follows the network — on
 * for mainnet, off for testnet. The decision is a pure function so the
 * table below is the whole contract. The middleware test underneath checks
 * that the function is actually consulted: `matcher` is static, so a gate
 * that is off has to be off inside the handler, not in the config.
 */

describe('gateEnabled', () => {
  it.each([
    [{ ACCESS_GATE: 'on' }, true],
    [{ ACCESS_GATE: 'on', NEXT_PUBLIC_STELLAR_NETWORK: 'testnet' }, true],
    [{ ACCESS_GATE: 'off' }, false],
    [{ ACCESS_GATE: 'off', NEXT_PUBLIC_STELLAR_NETWORK: 'mainnet' }, false],
    [{ NEXT_PUBLIC_STELLAR_NETWORK: 'mainnet' }, true],
    [{ NEXT_PUBLIC_STELLAR_NETWORK: 'testnet' }, false],
    [{}, false],
    [{ ACCESS_GATE: ' ON ' }, true],
    [{ ACCESS_GATE: 'Off' }, false],
    [{ ACCESS_GATE: '', NEXT_PUBLIC_STELLAR_NETWORK: 'mainnet' }, true],
    [{ ACCESS_GATE: 'maybe', NEXT_PUBLIC_STELLAR_NETWORK: 'mainnet' }, true],
    [{ ACCESS_GATE: 'maybe', NEXT_PUBLIC_STELLAR_NETWORK: 'testnet' }, false],
  ])('%j → %s', (env, expected) => {
    expect(gateEnabled(env)).toBe(expected)
  })
})

describe('the middleware', () => {
  const KEYS = ['ACCESS_GATE', 'AUTH_SECRET', 'NEXT_PUBLIC_STELLAR_NETWORK'] as const
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })

  afterEach(() => {
    for (const k of KEYS) {
      const was = saved[k]
      if (was === undefined) delete process.env[k]
      else process.env[k] = was
    }
  })

  async function run(path = '/stellar'): Promise<Response> {
    const { middleware } = await import('../../middleware')
    return middleware(new NextRequest(`http://localhost${path}`))
  }

  it('matches the app pages again, not the api or its own pages', async () => {
    const { config } = await import('../../middleware')
    expect(config.matcher).toHaveLength(1)
    const pattern = new RegExp(`^${config.matcher[0]}$`)
    expect(pattern.test('/stellar')).toBe(true)
    expect(pattern.test('/stellar/apps')).toBe(true)
    for (const own of ['/api/swap/quote', '/verify', '/waitlist', '/admin/waitlist', '/icon']) {
      expect(pattern.test(own), own).toBe(false)
    }
  })

  it('lets everything through when the gate is off', async () => {
    process.env['ACCESS_GATE'] = 'off'
    process.env['AUTH_SECRET'] = 'a'.repeat(48)
    const res = await run()
    expect(res.status).toBe(200)
    expect(res.headers.get('location')).toBeNull()
  })

  it('redirects an unverified visitor to /verify when the gate is on', async () => {
    process.env['ACCESS_GATE'] = 'on'
    process.env['AUTH_SECRET'] = 'a'.repeat(48)
    const res = await run('/stellar/apps')
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe('http://localhost/verify?next=%2Fstellar%2Fapps')
  })

  it('is on by default on mainnet', async () => {
    process.env['NEXT_PUBLIC_STELLAR_NETWORK'] = 'mainnet'
    process.env['AUTH_SECRET'] = 'a'.repeat(48)
    expect((await run()).status).toBe(307)
  })

  it('is off by default on testnet', async () => {
    process.env['NEXT_PUBLIC_STELLAR_NETWORK'] = 'testnet'
    process.env['AUTH_SECRET'] = 'a'.repeat(48)
    expect((await run()).status).toBe(200)
  })
})
