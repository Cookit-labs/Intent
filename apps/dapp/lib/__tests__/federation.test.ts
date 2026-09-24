import { Keypair } from '@stellar/stellar-sdk'
import { describe, expect, it } from 'vitest'

import { NameLookupFailed, NameNotFound } from '../names/errors'
import { resolveFederation } from '../names/federation'
import { isFederationAddress } from '../names/kind'

/**
 * SEP-2 federation, without a network.
 *
 * Two fetches stand between a `name*domain` and an account: the domain's
 * `stellar.toml`, which names the federation server, and the server's own
 * answer. Each is stubbed by URL so a test can break exactly one of them.
 */

const TARGET = Keypair.random().publicKey()

interface Stub {
  toml?: string | { status: number }
  answer?: unknown | { status: number }
  server?: string
}

function stubbedFetch(
  stub: Stub
): typeof fetch & { urls: string[]; inits: (RequestInit | undefined)[] } {
  const server = stub.server ?? 'https://lobstr.co/federation'
  const urls: string[] = []
  const inits: (RequestInit | undefined)[] = []
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    urls.push(url)
    inits.push(init)
    if (url.endsWith('/.well-known/stellar.toml')) {
      const toml = stub.toml ?? `NETWORK_PASSPHRASE="x"\nFEDERATION_SERVER="${server}"\n`
      if (typeof toml === 'object') return new Response('', { status: toml.status })
      return new Response(toml, { status: 200 })
    }
    if (url.startsWith(server)) {
      const answer = stub.answer ?? { account_id: TARGET, memo_type: 'text', memo: 'hello' }
      if (typeof answer === 'object' && answer !== null && 'status' in answer) {
        return new Response('{}', { status: (answer as { status: number }).status })
      }
      return new Response(JSON.stringify(answer), { status: 200 })
    }
    return new Response('', { status: 500 })
  }) as unknown as typeof fetch & { urls: string[]; inits: (RequestInit | undefined)[] }
  impl.urls = urls
  impl.inits = inits
  return impl
}

describe('isFederationAddress', () => {
  it('accepts name*domain', () => {
    expect(isFederationAddress('alice*lobstr.co')).toBe(true)
    expect(isFederationAddress('bob.smith*example.org')).toBe(true)
    expect(isFederationAddress('Alice*Lobstr.CO')).toBe(true)
  })

  it('rejects a .xlm name, a raw key and a bare word', () => {
    expect(isFederationAddress('deon.xlm')).toBe(false)
    expect(isFederationAddress(TARGET)).toBe(false)
    expect(isFederationAddress('alice')).toBe(false)
    expect(isFederationAddress('*lobstr.co')).toBe(false)
    expect(isFederationAddress('alice*lobstr')).toBe(false)
  })
})

describe('resolveFederation', () => {
  it('reads the server from the toml and the account from the server', async () => {
    const fetchImpl = stubbedFetch({})

    const resolved = await resolveFederation('alice*lobstr.co', { fetchImpl })

    expect(resolved).toEqual({ address: TARGET, memo: 'hello', memoType: 'text' })
    expect(fetchImpl.urls[0]).toBe('https://lobstr.co/.well-known/stellar.toml')
    expect(fetchImpl.urls[1]).toBe(
      `https://lobstr.co/federation?q=${encodeURIComponent('alice*lobstr.co')}&type=name`
    )
  })

  it('returns no memo when the server names none', async () => {
    const fetchImpl = stubbedFetch({ answer: { account_id: TARGET } })
    const resolved = await resolveFederation('alice*lobstr.co', { fetchImpl })
    expect(resolved).toEqual({ address: TARGET })
  })

  it('refuses a domain that publishes no federation server', async () => {
    const fetchImpl = stubbedFetch({ toml: 'NETWORK_PASSPHRASE="x"\n' })
    await expect(resolveFederation('alice*lobstr.co', { fetchImpl })).rejects.toThrow(
      NameLookupFailed
    )
    expect(fetchImpl.urls).toHaveLength(1)
  })

  it('refuses a federation server that is not https', async () => {
    const fetchImpl = stubbedFetch({ server: 'http://lobstr.co/federation' })
    await expect(resolveFederation('alice*lobstr.co', { fetchImpl })).rejects.toThrow(
      NameLookupFailed
    )
    expect(fetchImpl.urls).toHaveLength(1)
  })

  it('refuses an unreachable toml', async () => {
    const fetchImpl = stubbedFetch({ toml: { status: 503 } })
    await expect(resolveFederation('alice*lobstr.co', { fetchImpl })).rejects.toThrow(
      NameLookupFailed
    )
  })

  it('reports a name the server does not know as NameNotFound', async () => {
    const fetchImpl = stubbedFetch({ answer: { status: 404 } })
    await expect(resolveFederation('nobody*lobstr.co', { fetchImpl })).rejects.toThrow(NameNotFound)
  })

  it('refuses an account id that is not a public key', async () => {
    const fetchImpl = stubbedFetch({ answer: { account_id: 'not-a-key' } })
    await expect(resolveFederation('alice*lobstr.co', { fetchImpl })).rejects.toThrow(
      NameLookupFailed
    )
  })

  it('refuses a memo type outside text, id and hash', async () => {
    const fetchImpl = stubbedFetch({
      answer: { account_id: TARGET, memo_type: 'return', memo: '1' },
    })
    await expect(resolveFederation('alice*lobstr.co', { fetchImpl })).rejects.toThrow(
      NameLookupFailed
    )
  })

  it('refuses something that is not a federation address before fetching', async () => {
    const fetchImpl = stubbedFetch({})
    await expect(resolveFederation('deon.xlm', { fetchImpl })).rejects.toThrow(NameLookupFailed)
    expect(fetchImpl.urls).toHaveLength(0)
  })

  it('reports a network failure as NameLookupFailed', async () => {
    const fetchImpl = (async () => {
      throw new Error('fetch failed')
    }) as unknown as typeof fetch
    await expect(resolveFederation('alice*lobstr.co', { fetchImpl })).rejects.toThrow(
      NameLookupFailed
    )
  })

  it('refuses a memo that is not a string', async () => {
    // SEP-2 says the memo is a string. A number would be read through
    // JavaScript's float and, past 2^53, land on a different sub-account.
    const fetchImpl = stubbedFetch({
      answer: { account_id: TARGET, memo_type: 'id', memo: 9007199254740993 },
    })
    await expect(resolveFederation('alice*lobstr.co', { fetchImpl })).rejects.toThrow(
      NameLookupFailed
    )
  })
})

describe('the server is not a proxy for whoever types a domain', () => {
  it('bounds both fetches in time and never follows a redirect', async () => {
    const fetchImpl = stubbedFetch({})
    await resolveFederation('alice*lobstr.co', { fetchImpl })

    expect(fetchImpl.inits).toHaveLength(2)
    for (const init of fetchImpl.inits) {
      expect(init?.redirect).toBe('error')
      expect(init?.signal).toBeInstanceOf(AbortSignal)
    }
  })

  it('refuses a federation server on a loopback, private or unqualified host', async () => {
    for (const server of [
      'https://127.0.0.1/federation',
      'https://10.0.0.1/federation',
      'https://[::1]/federation',
      'https://localhost/federation',
      'https://fed.localhost/federation',
      'https://fed.internal/federation',
      'https://fed.local/federation',
      'https://intranet/federation',
    ]) {
      const fetchImpl = stubbedFetch({ server })
      await expect(resolveFederation('alice*lobstr.co', { fetchImpl }), server).rejects.toThrow(
        NameLookupFailed
      )
      expect(fetchImpl.urls, server).toHaveLength(1)
    }
  })

  it('refuses a typed domain on a reserved suffix before fetching anything', async () => {
    const fetchImpl = stubbedFetch({})
    await expect(resolveFederation('alice*intranet.internal', { fetchImpl })).rejects.toThrow(
      NameLookupFailed
    )
    expect(fetchImpl.urls).toHaveLength(0)
  })

  it('does not echo the upstream status code', async () => {
    const fetchImpl = stubbedFetch({ toml: { status: 503 } })
    await expect(resolveFederation('alice*lobstr.co', { fetchImpl })).rejects.not.toThrow(/503/)
  })
})
