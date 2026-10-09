import { NextRequest } from 'next/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * What middleware does with the network of a request. It is the only place the
 * network header is written, so these cases are the security boundary: a
 * client-sent value is never believed, and mainnet is behind the gate.
 */

const SECRET = 'x'.repeat(40)

async function run(
  url: string,
  options: { env?: Record<string, string>; headers?: Record<string, string> } = {}
): Promise<Response> {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORK', '')
  vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORKS', '')
  vi.stubEnv('ACCESS_GATE', '')
  vi.stubEnv('AUTH_SECRET', SECRET)
  for (const [k, v] of Object.entries(options.env ?? {})) vi.stubEnv(k, v)
  const { middleware } = await import('../../middleware')
  return middleware(new NextRequest(url, { headers: options.headers ?? {} }))
}

/** The header middleware forwards to the route, as Next encodes it on the response. */
function forwardedNetwork(res: Response): string | null {
  return res.headers.get('x-middleware-request-x-intent-network')
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

const BOTH = { NEXT_PUBLIC_STELLAR_NETWORKS: 'testnet,mainnet' }

describe('the network header', () => {
  it('is set from the address of a page', async () => {
    const mainnet = await run('http://app.test/stellar-mainnet/apps', {
      env: { ...BOTH, ACCESS_GATE: 'off' },
    })
    expect(forwardedNetwork(mainnet)).toBe('mainnet')
    const testnet = await run('http://app.test/stellar-testnet/apps', { env: BOTH })
    expect(forwardedNetwork(testnet)).toBe('testnet')
  })

  it('overwrites a header the client sent on a page request', async () => {
    const res = await run('http://app.test/stellar-testnet/apps', {
      env: BOTH,
      headers: { 'x-intent-network': 'mainnet' },
    })
    expect(forwardedNetwork(res)).toBe('testnet')
  })

  it('is taken from the app’s own header on an API call, when the deployment serves it', async () => {
    const res = await run('http://app.test/api/swap/quote', {
      env: BOTH,
      headers: { 'x-intent-network': 'mainnet' },
    })
    expect(forwardedNetwork(res)).toBe('mainnet')
  })

  it('is the default when an API call names a network that is not served', async () => {
    const res = await run('http://app.test/api/swap/quote', {
      env: { NEXT_PUBLIC_STELLAR_NETWORK: 'testnet' },
      headers: { 'x-intent-network': 'mainnet' },
    })
    expect(forwardedNetwork(res)).toBe('testnet')
  })

  it('is the default when an API call names nothing, or nonsense', async () => {
    expect(forwardedNetwork(await run('http://app.test/api/health', { env: BOTH }))).toBe('testnet')
    const junk = await run('http://app.test/api/health', {
      env: BOTH,
      headers: { 'x-intent-network': 'pubnet' },
    })
    expect(forwardedNetwork(junk)).toBe('testnet')
  })
})

describe('the gate, per network', () => {
  it('sends an anonymous visitor to verify on mainnet, and lets testnet through', async () => {
    const mainnet = await run('http://app.test/stellar-mainnet/apps', { env: BOTH })
    expect(mainnet.status).toBe(307)
    expect(new URL(mainnet.headers.get('location') as string).pathname).toBe('/verify')

    const testnet = await run('http://app.test/stellar-testnet/apps', { env: BOTH })
    expect(testnet.status).toBe(200)
  })

  it('does not let a request pick testnet to reach mainnet pages', async () => {
    const res = await run('http://app.test/stellar-mainnet/apps', {
      env: BOTH,
      headers: { 'x-intent-network': 'testnet' },
    })
    expect(res.status).toBe(307)
  })

  it('never gates the API, and never gates the verification page', async () => {
    expect((await run('http://app.test/api/swap/quote', { env: BOTH })).status).toBe(200)
    expect((await run('http://app.test/verify', { env: BOTH })).status).toBe(200)
  })
})

describe('where the root and the old unprefixed addresses go', () => {
  const location = (res: Response): URL => new URL(res.headers.get('location') as string)

  it('opens on Stellar mainnet when both networks are served', async () => {
    const res = await run('http://app.test/', { env: BOTH })
    expect(res.status).toBe(307)
    expect(location(res).pathname).toBe('/stellar-mainnet/intents')
  })

  it('opens on the one Stellar address when one network is served', async () => {
    const res = await run('http://app.test/', {})
    expect(res.status).toBe(307)
    expect(location(res).pathname).toBe('/stellar/intents')
  })

  it('sends an old unprefixed screen to the same screen on the home chain, keeping the query', async () => {
    const res = await run('http://app.test/apps?x=1', { env: BOTH })
    expect(location(res).pathname).toBe('/stellar-mainnet/apps')
    expect(location(res).search).toBe('?x=1')
  })

  it('leaves chain addresses, the API and the verification page where they are', async () => {
    for (const path of ['/arc/intents', '/stellar-testnet/intents', '/api/health', '/verify']) {
      const res = await run(`http://app.test${path}`, { env: { ...BOTH, ACCESS_GATE: 'off' } })
      expect(res.headers.get('location')).toBeNull()
    }
  })

  it('does not put the root behind the gate: the visitor lands on mainnet and is then asked to verify', async () => {
    const root = await run('http://app.test/', { env: BOTH })
    expect(location(root).pathname).toBe('/stellar-mainnet/intents')
    const page = await run('http://app.test/stellar-mainnet/intents', { env: BOTH })
    expect(location(page).pathname).toBe('/verify')
    expect(location(page).searchParams.get('next')).toBe('/stellar-mainnet/intents')
  })
})

describe('the old /stellar address', () => {
  it('redirects to the default network when several are served', async () => {
    const res = await run('http://app.test/stellar/apps?x=1', { env: BOTH })
    expect(res.status).toBe(307)
    const to = new URL(res.headers.get('location') as string)
    expect(to.pathname).toBe('/stellar-testnet/apps')
    expect(to.search).toBe('?x=1')
  })

  it('is left alone when one network is served', async () => {
    const res = await run('http://app.test/stellar/apps', {})
    expect(res.status).toBe(200)
  })
})
