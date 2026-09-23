import { afterEach, describe, expect, it, vi } from 'vitest'

import { createSoroswapApi, resetSoroswapApiCache } from '../swap/soroswap-api'

/**
 * The hosted Soroswap API, spoken to directly.
 *
 * Three JSON calls: a quote, a build that turns the quote into unsigned XDR,
 * and a contract-id lookup that needs no key. The official SDK wraps the same
 * three in axios with no way to inject a transport, so it is not used — every
 * test here hands in a fetch and no test touches the network.
 *
 * What is pinned is the wire format, verified against the API's own OpenAPI
 * document at /api-json and the SDK's serialiser: the key travels as a bearer
 * token (an `X-API-Key` header is a 403), the amount is a decimal string of
 * stroops, and the quote object must go back to /quote/build exactly as it
 * came.
 */

const XLM_SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'
const USDC_SAC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const ACCOUNT = 'GCYQ3NXJHGD7P36OVKII6GKVLAENQ6ZETYOBAPZTI4R6ZWUU6QLHVVUX'

/** A quote as the API returns it, with the number-or-string looseness it shows. */
const apiQuote = {
  assetIn: XLM_SAC,
  assetOut: USDC_SAC,
  amountIn: '10000000',
  amountOut: 9067253,
  otherAmountThreshold: 9021917,
  tradeType: 'EXACT_IN',
  priceImpactPct: '0.50',
  platform: 'aggregator',
  rawTrade: {
    amountIn: '10000000',
    amountOutMin: '9021917',
    distribution: [
      { protocol_id: 'soroswap', path: [XLM_SAC, USDC_SAC], parts: 10, is_exact_in: true },
    ],
  },
  routePlan: [{ swapInfo: { protocol: 'soroswap', path: [XLM_SAC, USDC_SAC] }, percent: '100' }],
}

interface Captured {
  url: string
  init: RequestInit | undefined
}

/** A fetch that answers every call the same way and records what it was asked. */
function respond(
  status: number,
  body: unknown,
  calls: Captured[] = []
): { fetchImpl: typeof fetch; calls: Captured[] } {
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const quoteReq = {
  assetIn: XLM_SAC,
  assetOut: USDC_SAC,
  amount: '10000000',
  protocols: ['soroswap', 'aqua', 'sdex'] as const,
  slippageBps: 50,
}

afterEach(() => {
  resetSoroswapApiCache()
  vi.unstubAllEnvs()
})

describe('configuration', () => {
  it('is not configured without a key', () => {
    vi.stubEnv('SOROSWAP_API_KEY', '')
    expect(createSoroswapApi({ apiKey: '' }).isConfigured()).toBe(false)
  })

  it('reads the key from SOROSWAP_API_KEY when none is passed', () => {
    vi.stubEnv('SOROSWAP_API_KEY', 'sk_from_env')
    expect(createSoroswapApi().isConfigured()).toBe(true)
  })
})

describe('quoting', () => {
  it('asks for a testnet quote with the bearer key and the protocol list', async () => {
    const { fetchImpl, calls } = respond(200, apiQuote)
    const api = createSoroswapApi({ apiKey: 'sk_test', fetchImpl })

    await api.quote(quoteReq)

    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(call?.url).toBe('https://api.soroswap.finance/quote?network=testnet')
    expect(call?.init?.method).toBe('POST')
    const headers = new Headers(call?.init?.headers)
    expect(headers.get('authorization')).toBe('Bearer sk_test')
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      assetIn: XLM_SAC,
      assetOut: USDC_SAC,
      amount: '10000000',
      tradeType: 'EXACT_IN',
      protocols: ['soroswap', 'aqua', 'sdex'],
      slippageBps: 50,
    })
  })

  it('normalises the amounts to strings and keeps the body for build', async () => {
    const { fetchImpl } = respond(200, apiQuote)
    const api = createSoroswapApi({ apiKey: 'sk_test', fetchImpl })

    const out = await api.quote(quoteReq)

    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.value.amountIn).toBe('10000000')
    // Sent as a JSON number by the API; a string here, because every amount
    // downstream is BigInt-parsed and a number would lose precision first.
    expect(out.value.amountOut).toBe('9067253')
    expect(out.value.otherAmountThreshold).toBe('9021917')
    expect(out.value.platform).toBe('aggregator')
    expect(out.value.routePlan).toEqual([
      { protocol: 'soroswap', path: [XLM_SAC, USDC_SAC], percent: '100' },
    ])
    // Verbatim, so /quote/build receives exactly what /quote produced.
    expect(out.value.raw).toEqual(apiQuote)
  })

  it('reports a rejected key as unavailable, not as no route', async () => {
    const { fetchImpl } = respond(403, { statusCode: 403, message: 'Forbidden resource' })
    const api = createSoroswapApi({ apiKey: 'sk_bad', fetchImpl })

    const out = await api.quote(quoteReq)

    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toBe('unavailable')
  })

  it("reports the API's own no-route answer as no_route", async () => {
    const { fetchImpl } = respond(400, { statusCode: 400, message: 'No route found' })
    const api = createSoroswapApi({ apiKey: 'sk_test', fetchImpl })

    const out = await api.quote(quoteReq)

    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.reason).toBe('no_route')
      expect(out.detail).toBe('No route found')
    }
  })

  it('reports a server fault as upstream_error', async () => {
    const { fetchImpl } = respond(502, 'bad gateway')
    const api = createSoroswapApi({ apiKey: 'sk_test', fetchImpl })

    const out = await api.quote(quoteReq)

    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toBe('upstream_error')
  })

  it('refuses a quote whose amounts it cannot read', async () => {
    const { fetchImpl } = respond(200, { ...apiQuote, amountOut: '9,067,253' })
    const api = createSoroswapApi({ apiKey: 'sk_test', fetchImpl })

    const out = await api.quote(quoteReq)

    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toBe('upstream_error')
  })

  it('never throws when the transport fails', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    const api = createSoroswapApi({ apiKey: 'sk_test', fetchImpl })

    const out = await api.quote(quoteReq)

    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toBe('upstream_error')
  })
})

describe('building', () => {
  it('sends the quote back verbatim with the account as sender and recipient', async () => {
    const { fetchImpl, calls } = respond(200, { xdr: 'AAAAAgAAAAB8' })
    const api = createSoroswapApi({ apiKey: 'sk_test', fetchImpl })

    const out = await api.build(
      {
        assetIn: XLM_SAC,
        assetOut: USDC_SAC,
        amountIn: '10000000',
        amountOut: '9067253',
        otherAmountThreshold: '9021917',
        platform: 'aggregator',
        routePlan: [],
        raw: apiQuote,
      },
      ACCOUNT
    )

    expect(out.ok).toBe(true)
    if (out.ok) expect(out.value).toBe('AAAAAgAAAAB8')
    expect(calls[0]?.url).toBe('https://api.soroswap.finance/quote/build?network=testnet')
    // `to` is not a parameter of this client. The proceeds go to the account
    // that funds the swap, and there is nowhere in this interface to say
    // otherwise.
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      quote: apiQuote,
      from: ACCOUNT,
      to: ACCOUNT,
    })
  })

  it('refuses a build answer with no xdr', async () => {
    const { fetchImpl } = respond(200, { message: 'built', xdr: '' })
    const api = createSoroswapApi({ apiKey: 'sk_test', fetchImpl })

    const out = await api.build(
      {
        assetIn: XLM_SAC,
        assetOut: USDC_SAC,
        amountIn: '10000000',
        amountOut: '9067253',
        otherAmountThreshold: '9021917',
        platform: 'aggregator',
        routePlan: [],
        raw: apiQuote,
      },
      ACCOUNT
    )

    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toBe('upstream_error')
  })
})

describe('resolving contract ids', () => {
  const AGGREGATOR = 'CC74XDT7UVLUZCELKBIYXFYIX6A6LGPWURJVUXGRPQO745RWX7WEURMA'

  it('asks the API without a key and caches the answer for the TTL', async () => {
    let now = 1_000_000
    const { fetchImpl, calls } = respond(200, { address: AGGREGATOR })
    const api = createSoroswapApi({
      apiKey: '',
      fetchImpl,
      now: () => now,
      contractTtlMs: 60_000,
    })

    expect(await api.contractAddress('aggregator')).toBe(AGGREGATOR)
    expect(await api.contractAddress('aggregator')).toBe(AGGREGATOR)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://api.soroswap.finance/api/testnet/aggregator')
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBeNull()

    // Past the TTL, it is asked again: a testnet reset or a rotated contract
    // must show up, and a cache that never expires would hide it.
    now += 60_001
    expect(await api.contractAddress('aggregator')).toBe(AGGREGATOR)
    expect(calls).toHaveLength(2)
  })

  it('returns nothing on a failure and does not cache it', async () => {
    const answers = [
      new Response('upstream down', { status: 503 }),
      new Response(JSON.stringify({ address: AGGREGATOR }), { status: 200 }),
    ]
    let count = 0
    const fetchImpl = (async () => {
      count += 1
      return answers.shift() as Response
    }) as unknown as typeof fetch
    const api = createSoroswapApi({ apiKey: '', fetchImpl })

    expect(await api.contractAddress('router')).toBeUndefined()
    expect(await api.contractAddress('router')).toBe(AGGREGATOR)
    expect(count).toBe(2)
  })

  it('refuses an answer that is not a contract id', async () => {
    const { fetchImpl } = respond(200, { address: 'not-a-contract' })
    const api = createSoroswapApi({ apiKey: '', fetchImpl })

    expect(await api.contractAddress('router')).toBeUndefined()
  })

  it('never throws when the transport fails', async () => {
    const fetchImpl = (async () => {
      throw new Error('ENOTFOUND')
    }) as unknown as typeof fetch
    const api = createSoroswapApi({ apiKey: '', fetchImpl })

    await expect(api.contractAddress('aggregator')).resolves.toBeUndefined()
  })
})
