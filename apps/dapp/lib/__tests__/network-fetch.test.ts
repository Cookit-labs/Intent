import { describe, expect, it } from 'vitest'

import { networkFetch } from '../api/network-fetch'

const ORIGIN = 'https://app.test'

function spy(): { base: typeof fetch; calls: { url: string; headers: Headers }[] } {
  const calls: { url: string; headers: Headers }[] = []
  const base = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : {}))
    calls.push({ url: input instanceof Request ? input.url : String(input), headers })
    return new Response('{}')
  }) as typeof fetch
  return { base, calls }
}

describe('networkFetch', () => {
  it('tags the app’s own API calls with the page’s network', async () => {
    const { base, calls } = spy()
    const f = networkFetch(base, 'mainnet', ORIGIN)
    await f('/api/swap/quote')
    await f(`${ORIGIN}/api/lend/build`, { method: 'POST' })
    expect(calls.map((c) => c.headers.get('x-intent-network'))).toEqual(['mainnet', 'mainnet'])
  })

  it('leaves every other request alone', async () => {
    const { base, calls } = spy()
    const f = networkFetch(base, 'mainnet', ORIGIN)
    await f('/images/logo.webp')
    await f('https://horizon.stellar.org/accounts/G')
    await f('https://other.test/api/swap/quote')
    await f('http://localhost:8080/api/v1/x')
    expect(calls.every((c) => c.headers.get('x-intent-network') === null)).toBe(true)
  })

  it('keeps the headers the caller set, and the page’s network wins over a caller’s', async () => {
    const { base, calls } = spy()
    const f = networkFetch(base, 'testnet', ORIGIN)
    await f('/api/x', {
      headers: { 'content-type': 'application/json', 'x-intent-network': 'mainnet' },
    })
    expect(calls[0]?.headers.get('content-type')).toBe('application/json')
    expect(calls[0]?.headers.get('x-intent-network')).toBe('testnet')
  })

  it('handles a Request object and keeps its headers', async () => {
    const { base, calls } = spy()
    const f = networkFetch(base, 'testnet', ORIGIN)
    await f(
      new Request(`${ORIGIN}/api/offers?account=G`, { headers: { accept: 'application/json' } })
    )
    expect(calls[0]?.headers.get('accept')).toBe('application/json')
    expect(calls[0]?.headers.get('x-intent-network')).toBe('testnet')
  })
})
