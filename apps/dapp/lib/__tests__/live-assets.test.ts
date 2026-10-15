import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Live = typeof import('../swap/live-assets')
type Registry = typeof import('../swap/asset-registry')

let live: Live
let registry: Registry

beforeEach(async () => {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORK', 'mainnet')
  vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORKS', '')
  live = await import('../swap/live-assets')
  registry = await import('../swap/asset-registry')
})

afterEach(() => vi.unstubAllEnvs())

const PYUSD_ISSUER = 'GDQE7IXJ4HUHV6RQHIUPRJSEZE4DRS5WY577O2FY6YQ5LVWZ7JZTU2V5'
const FAKE_ISSUER = 'GBXRPL45NPHCVMFFAYZVUVFFVKSIZ362ZXFP7I2ETNQ3QKZMFLPRDTD5'
const OTHER_ISSUER = 'GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC'

const TOML = `
ACCOUNTS=["x"]

[[CURRENCIES]]
code="PYUSD"
issuer="${PYUSD_ISSUER}"
name="PayPal USD"

[[CURRENCIES]]
code="OTHER"
issuer="${OTHER_ISSUER}"
`

interface Site {
  homeDomain: Record<string, string>
  toml: Record<string, string>
  list: { code: string; issuer: string; name?: string }[]
}

function fakeFetch(site: Site): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('tokenList.json')) {
      return new Response(JSON.stringify({ assets: site.list }))
    }
    const account = /\/accounts\/(G[A-Z0-9]+)$/.exec(url)?.[1]
    if (account !== undefined) {
      const domain = site.homeDomain[account]
      return new Response(JSON.stringify(domain === undefined ? {} : { home_domain: domain }))
    }
    const toml = /^https:\/\/([^/]+)\/\.well-known\/stellar\.toml$/.exec(url)?.[1]
    if (toml !== undefined && site.toml[toml] !== undefined) {
      return new Response(site.toml[toml])
    }
    return new Response('nope', { status: 404 })
  }) as typeof fetch
}

describe('tomlNames', () => {
  it('needs the code and the issuer in the same block', () => {
    expect(live.tomlNames(TOML, 'PYUSD', PYUSD_ISSUER)).toBe(true)
    expect(live.tomlNames(TOML, 'PYUSD', OTHER_ISSUER)).toBe(false)
    expect(live.tomlNames(TOML, 'OTHER', PYUSD_ISSUER)).toBe(false)
  })
})

describe('verifyIssuer', () => {
  it('returns the domain only when the site names the account back', async () => {
    const ok = fakeFetch({
      homeDomain: { [PYUSD_ISSUER]: 'paxos.test' },
      toml: { 'paxos.test': TOML },
      list: [],
    })
    expect(await live.verifyIssuer('PYUSD', PYUSD_ISSUER, 'https://h', ok)).toBe('paxos.test')

    const liar = fakeFetch({
      homeDomain: { [FAKE_ISSUER]: 'paxos.test' },
      toml: { 'paxos.test': TOML },
      list: [],
    })
    expect(await live.verifyIssuer('PYUSD', FAKE_ISSUER, 'https://h', liar)).toBeNull()
  })
})

describe('ensureLiveAssets', () => {
  it('admits a listed token whose issuer proves itself', async () => {
    const f = fakeFetch({
      homeDomain: { [PYUSD_ISSUER]: 'paxos.test' },
      toml: { 'paxos.test': TOML },
      list: [{ code: 'PYUSD', issuer: PYUSD_ISSUER, name: 'PayPal USD' }],
    })
    await live.ensureLiveAssets(['pyusd'], { fetchImpl: f, network: 'mainnet' })
    const pyusd = registry.resolveVerifiedAsset('PYUSD')
    expect(pyusd?.issuer).toBe(PYUSD_ISSUER)
    expect(pyusd?.homeDomain).toBe('paxos.test')
    expect(registry.tradeableSymbols()).toContain('PYUSD')
  })

  it('refuses a listed token whose issuer cannot prove itself', async () => {
    const f = fakeFetch({
      homeDomain: {},
      toml: {},
      list: [{ code: 'SCAM', issuer: FAKE_ISSUER }],
    })
    await live.ensureLiveAssets(['SCAM'], { fetchImpl: f, network: 'mainnet' })
    expect(registry.resolveVerifiedAsset('SCAM')).toBeUndefined()
  })

  it('refuses a name that two issuers answer to', async () => {
    const f = fakeFetch({
      homeDomain: { [PYUSD_ISSUER]: 'paxos.test', [FAKE_ISSUER]: 'paxos.test' },
      toml: { 'paxos.test': TOML },
      list: [
        { code: 'PYUSD', issuer: PYUSD_ISSUER },
        { code: 'PYUSD', issuer: FAKE_ISSUER },
      ],
    })
    await live.ensureLiveAssets(['PYUSD'], { fetchImpl: f, network: 'mainnet' })
    expect(registry.resolveVerifiedAsset('PYUSD')).toBeUndefined()
  })

  it('does nothing off mainnet and leaves hand-written assets alone', async () => {
    const f = fakeFetch({ homeDomain: {}, toml: {}, list: [{ code: 'USDC', issuer: FAKE_ISSUER }] })
    await live.ensureLiveAssets(['USDC'], { fetchImpl: f, network: 'testnet' })
    await live.ensureLiveAssets(['USDC'], { fetchImpl: f, network: 'mainnet' })
    expect(registry.resolveVerifiedAsset('USDC')?.issuer).not.toBe(FAKE_ISSUER)
  })
})
