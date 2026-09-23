import { describe, expect, it } from 'vitest'

import {
  DEFAULT_NOETHER_API_URL,
  NoetherHttpError,
  NoetherOfflineError,
  createNoetherClient,
  noetherApiUrl,
  sessionToken,
} from '../perps/noether-client'

/**
 * The gateway client, with every request captured and every response canned.
 *
 * Shapes below are the live gateway's as read on 2026-09-23 from its Swagger
 * (`/docs/json`) and confirmed by unauthenticated calls: `/v1/health`,
 * `/v1/markets`, `/v1/markets/stats`, `/v1/vaults`, `/v1/keys/beta-status`
 * and `/v1/keys/challenge` all answered; `/v1/orders/prepare` answered
 * `401 missing_bearer` without a token and `401 malformed_bearer` with a
 * bare one, naming the form `Bearer <keyId>:<secret>`.
 */

const MARKET = 'CBHHWFAYLB3SXJCE232DC6WNSK74IBEOROAGCI2AFBA2H5NQOH2KYKNN'
const ROUTER = 'CBDVQKYEN6QMRGQZC77DFYEQXQHDMCVJ3TPBJKNERJVMIESA6GQT44LG'
const VAULT = 'CBSWA5P75NGV2LP5KOY7A7LOAX2CENI5OYBSJ5IVLHENKQJF2I3ZBSYE'
const USDC = 'CA63EPM4EEXUVUANF6FQUJEJ37RWRYIXCARWFXYUMPP7RLZWFNLTVNR4'
const ACCOUNT = 'GDA4JVVUE6CTF7FEGOFMKA3YE4E5J7SAAK7RACZLNIMXYF24OLLR3KZO'

function health(contracts: Record<string, { address: string } | undefined> = {}): unknown {
  return {
    status: 'ok',
    version: '0.0.0-dev',
    network: 'testnet',
    contracts: {
      market: { address: MARKET, source: 'env' },
      vault: { address: VAULT, source: 'env' },
      noetherRouter: { address: ROUTER, source: 'env' },
      usdcToken: { address: USDC, source: 'manifest' },
      ...contracts,
    },
    market: { pauseState: { supported: true, mode: 0, since: 1 } },
  }
}

interface Captured {
  url: string
  method: string
  headers: Record<string, string>
  body?: unknown
}

function gateway(
  routes: Record<string, { status?: number; body: unknown }>,
  captured: Captured[] = []
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const path = new URL(url).pathname + new URL(url).search
    captured.push({
      url,
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(
        Object.entries((init?.headers as Record<string, string> | undefined) ?? {})
      ),
      ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}),
    })
    const route = routes[path] ?? routes[new URL(url).pathname]
    if (route === undefined) return new Response('not found', { status: 404 })
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

describe('the gateway address', () => {
  it('defaults to the working Azure host, not the dead SDK default', () => {
    // `api.noether.exchange` and `docs.noether.exchange` are NXDOMAIN. The
    // host below was extracted from the production bundle and answers.
    expect(DEFAULT_NOETHER_API_URL).toBe(
      'https://noether-api.proudmeadow-533cf0d8.germanywestcentral.azurecontainerapps.io'
    )
    expect(noetherApiUrl({})).toBe(DEFAULT_NOETHER_API_URL)
  })

  it('takes NOETHER_API_URL when set, without a trailing slash', () => {
    expect(noetherApiUrl({ NOETHER_API_URL: 'http://localhost:4000/' })).toBe(
      'http://localhost:4000'
    )
  })
})

describe('resolving the venue from /v1/health', () => {
  it('reads the contract ids the gateway actually serves', async () => {
    const client = createNoetherClient({ fetchImpl: gateway({ '/v1/health': { body: health() } }) })
    const h = await client.readHealth()
    expect(h.contracts).toEqual({ market: MARKET, router: ROUTER, vault: VAULT, usdcToken: USDC })
    expect(h.version).toBe('0.0.0-dev')
    expect(h.network).toBe('testnet')
    expect(h.paused).toBe(false)
  })

  it('treats a missing market contract as the venue being offline', async () => {
    const client = createNoetherClient({
      fetchImpl: gateway({ '/v1/health': { body: health({ market: undefined }) } }),
    })
    await expect(client.readHealth()).rejects.toBeInstanceOf(NoetherOfflineError)
    await expect(client.readHealth()).rejects.toThrow(/market/)
  })

  it('treats a gateway that does not answer as offline', async () => {
    const client = createNoetherClient({ fetchImpl: gateway({}) })
    await expect(client.readHealth()).rejects.toBeInstanceOf(NoetherOfflineError)
  })

  it('refuses a gateway on another network', async () => {
    const client = createNoetherClient({
      fetchImpl: gateway({
        '/v1/health': { body: { ...(health() as object), network: 'mainnet' } },
      }),
    })
    await expect(client.readHealth()).rejects.toThrow(/testnet/)
  })

  it('reports a paused market', async () => {
    const paused = { ...(health() as object), market: { pauseState: { mode: 1, since: 1 } } }
    const client = createNoetherClient({ fetchImpl: gateway({ '/v1/health': { body: paused } }) })
    expect((await client.readHealth()).paused).toBe(true)
  })
})

describe('unauthenticated reads', () => {
  it('reads markets with their oracle price', async () => {
    const client = createNoetherClient({
      fetchImpl: gateway({
        '/v1/markets': {
          body: {
            markets: [
              {
                asset: { symbol: 'XLM', name: 'Stellar Lumens', decimals: 7 },
                oracle: {
                  asset: 'XLM',
                  price: '2129103',
                  priceFloat: 0.2129103,
                  timestamp: 1790167982,
                },
              },
            ],
          },
        },
      }),
    })
    expect(await client.readMarkets()).toEqual([
      {
        asset: 'XLM',
        name: 'Stellar Lumens',
        decimals: 7,
        markPrice: '2129103',
        markPriceUsd: 0.2129103,
        priceTimestamp: 1790167982,
      },
    ])
  })

  it('reads open interest and headroom per market', async () => {
    const client = createNoetherClient({
      fetchImpl: gateway({
        '/v1/markets/stats': {
          body: {
            stats: [
              {
                asset: 'XLM',
                openInterestLong: '252541116930',
                openInterestShort: '400000000000',
                openInterestNet: '-147458883070',
                openPositions: 5,
                volume24h: '150000000000',
                capacity: { headroomLong: '1000000000000', headroomShort: '1000000000000' },
              },
            ],
          },
        },
      }),
    })
    expect(await client.readStats()).toEqual([
      {
        asset: 'XLM',
        openInterestLong: '252541116930',
        openInterestShort: '400000000000',
        openPositions: 5,
        volume24h: '150000000000',
        headroomLong: '1000000000000',
        headroomShort: '1000000000000',
      },
    ])
  })

  it('reads vault APY in basis points', async () => {
    const client = createNoetherClient({
      fetchImpl: gateway({
        '/v1/vaults': {
          body: {
            vaults: [
              {
                id: 0,
                name: 'bigbig',
                totalUsdc: '11000000000',
                apyBps: 250,
                apyKind: 'annualized',
              },
            ],
          },
        },
      }),
    })
    expect(await client.readVaults()).toEqual([
      { id: 0, name: 'bigbig', totalUsdc: '11000000000', apyBps: 250, apyKind: 'annualized' },
    ])
  })

  it('reports a non-JSON answer as an HTTP error, not a crash', async () => {
    const client = createNoetherClient({
      fetchImpl: (async () => new Response('<html>', { status: 502 })) as unknown as typeof fetch,
    })
    await expect(client.readMarkets()).rejects.toBeInstanceOf(NoetherHttpError)
  })
})

describe('the API-key handshake', () => {
  it('asks whether the address may have a key at all', async () => {
    const captured: Captured[] = []
    const client = createNoetherClient({
      fetchImpl: gateway(
        { '/v1/keys/beta-status': { body: { gated: true, allowed: false } } },
        captured
      ),
    })
    expect(await client.betaStatus(ACCOUNT)).toEqual({ gated: true, allowed: false })
    expect(captured[0]?.url).toContain(`address=${ACCOUNT}`)
  })

  it('requests a challenge for the address', async () => {
    const captured: Captured[] = []
    const client = createNoetherClient({
      fetchImpl: gateway(
        {
          '/v1/keys/challenge': {
            body: { challengeHex: 'ab'.repeat(32), expiresAt: 1790168326354 },
          },
        },
        captured
      ),
    })
    expect(await client.requestChallenge(ACCOUNT)).toEqual({
      challengeHex: 'ab'.repeat(32),
      expiresAt: 1790168326354,
    })
    expect(captured[0]?.method).toBe('POST')
    expect(captured[0]?.body).toEqual({ address: ACCOUNT })
  })

  it('exchanges the signed challenge for a key, sending the XDR as `signature`', async () => {
    // The wire field is named `signature` but carries the whole signed
    // envelope, base64 — a legacy name the gateway kept for compatibility.
    const captured: Captured[] = []
    const client = createNoetherClient({
      fetchImpl: gateway(
        {
          '/v1/keys': {
            status: 201,
            body: { keyId: 'nk_1', secret: 's3', tier: 'free', owner: ACCOUNT, createdAt: 1 },
          },
        },
        captured
      ),
    })
    const key = await client.exchangeChallenge({
      address: ACCOUNT,
      challengeHex: 'ab'.repeat(32),
      signedXdr: 'AAAA',
    })
    expect(key).toEqual({ keyId: 'nk_1', secret: 's3' })
    expect(captured[0]?.body).toEqual({
      address: ACCOUNT,
      challenge: 'ab'.repeat(32),
      signature: 'AAAA',
      label: 'intent-dapp',
    })
  })

  it('names the closed beta when the gateway refuses the key', async () => {
    const client = createNoetherClient({
      fetchImpl: gateway({
        '/v1/keys': { status: 403, body: { error: 'not_in_beta', message: 'closed beta' } },
      }),
    })
    const failure = await client
      .exchangeChallenge({ address: ACCOUNT, challengeHex: 'ab', signedXdr: 'AAAA' })
      .catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(NoetherHttpError)
    expect((failure as NoetherHttpError).code).toBe('not_in_beta')
    expect((failure as NoetherHttpError).status).toBe(403)
  })

  it('joins key id and secret the way the gateway reads them', () => {
    expect(sessionToken({ keyId: 'nk_1', secret: 's3' })).toBe('nk_1:s3')
  })
})

describe('preparing and submitting an order', () => {
  it('asks for an isolated open with base-unit collateral and the bearer token', async () => {
    const captured: Captured[] = []
    const client = createNoetherClient({
      fetchImpl: gateway(
        {
          '/v1/orders/prepare': {
            body: { op: 'open_position', trader: ACCOUNT, xdr: 'AAAA', minResourceFee: '123' },
          },
        },
        captured
      ),
    })
    const prepared = await client.prepareOpen({
      token: 'nk_1:s3',
      asset: 'XLM',
      collateral: '500000000',
      leverage: 10,
      side: 'long',
    })
    expect(prepared).toEqual({ op: 'open_position', trader: ACCOUNT, xdr: 'AAAA' })
    expect(captured[0]?.headers['Authorization']).toBe('Bearer nk_1:s3')
    expect(captured[0]?.body).toEqual({
      op: 'open_position',
      asset: 'XLM',
      collateral: '500000000',
      leverage: 10,
      direction: 'Long',
    })
  })

  it('maps a short to the gateway direction', async () => {
    const captured: Captured[] = []
    const client = createNoetherClient({
      fetchImpl: gateway(
        { '/v1/orders/prepare': { body: { op: 'open_position', trader: ACCOUNT, xdr: 'AAAA' } } },
        captured
      ),
    })
    await client.prepareOpen({
      token: 't',
      asset: 'BTC',
      collateral: '10000000',
      leverage: 2,
      side: 'short',
    })
    expect((captured[0]?.body as { direction: string }).direction).toBe('Short')
  })

  it('refuses to prepare with collateral that is not a base-unit integer', async () => {
    const client = createNoetherClient({ fetchImpl: gateway({}) })
    await expect(
      client.prepareOpen({ token: 't', asset: 'XLM', collateral: '5.5', leverage: 2, side: 'long' })
    ).rejects.toThrow(/base units/)
  })

  it('surfaces the gateway refusal with its code', async () => {
    const client = createNoetherClient({
      fetchImpl: gateway({
        '/v1/orders/prepare': { status: 401, body: { error: 'missing_bearer' } },
      }),
    })
    const failure = await client
      .prepareOpen({ token: '', asset: 'XLM', collateral: '1', leverage: 1, side: 'long' })
      .catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(NoetherHttpError)
    expect((failure as NoetherHttpError).code).toBe('missing_bearer')
  })

  it('submits a signed envelope and reads the outcome', async () => {
    const captured: Captured[] = []
    const client = createNoetherClient({
      fetchImpl: gateway(
        {
          '/v1/tx/submit': {
            body: { hash: 'abc', status: 'SUCCESS', ledger: 4828856, contractError: null },
          },
        },
        captured
      ),
    })
    const out = await client.submit({ token: 'nk_1:s3', signedXdr: 'BBBB' })
    expect(out).toEqual({ hash: 'abc', status: 'SUCCESS', ledger: 4828856 })
    expect(captured[0]?.headers['Authorization']).toBe('Bearer nk_1:s3')
    expect(captured[0]?.body).toEqual({ signedXdr: 'BBBB' })
  })

  it('names the contract error when the transaction failed on-chain', async () => {
    const client = createNoetherClient({
      fetchImpl: gateway({
        '/v1/tx/submit': {
          body: {
            hash: 'abc',
            status: 'FAILED',
            contractError: { code: 7, name: 'InsufficientCollateral' },
          },
        },
      }),
    })
    const out = await client.submit({ token: 't', signedXdr: 'BBBB' })
    expect(out).toEqual({
      hash: 'abc',
      status: 'FAILED',
      contractError: { code: 7, name: 'InsufficientCollateral' },
    })
  })
})
