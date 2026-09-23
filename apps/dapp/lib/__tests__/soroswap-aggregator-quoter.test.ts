import { describe, expect, it } from 'vitest'

import type { ProtocolWhitelist } from '../swap/aggregator-protocols'
import { resolveAsset, type ClassicAsset } from '../swap/assets'
import { sacFor } from '../swap/build-soroban'
import { SOROSWAP_AGGREGATOR } from '../swap/contract-registry'
import { sourceDisplayName } from '../swap/quote'
import type { QuoteRequest } from '../swap/quote'
import type { AggregatorApiQuote, ApiResult, SoroswapApi } from '../swap/soroswap-api'
import { createSoroswapAggregatorQuoter } from '../swap/sources/soroswap-aggregator-quoter'

/**
 * The aggregator as a quote source.
 *
 * A distinct venue from the Soroswap AMM the app already simulates against:
 * that one prices a single pool through `router_get_amounts_out`, this one
 * asks Soroswap's hosted route-finder to split the swap across Soroswap,
 * Aquarius and the classic book. Several of its answers therefore originate
 * from a vendor whose router is already a source of its own, which is why the
 * route carries its own id — an agent comparing "soroswap" against
 * "soroswap-aggregator" is told which is which — and why the direct quoters
 * stay in the line-up beside it rather than being replaced.
 *
 * Everything here runs against an injected API and whitelist. The quoter's
 * job is the boundary: refuse before the network what it can refuse locally,
 * ask with the right whitelist, and refuse an answer that does not match the
 * question.
 */

const xlm = resolveAsset('XLM')
const usdc = resolveAsset('USDC')
if (xlm === undefined || usdc === undefined) throw new Error('registry missing XLM or USDC')
const XLM: ClassicAsset = xlm
const USDC: ClassicAsset = usdc

const XLM_SAC = sacFor(XLM)
const USDC_SAC = sacFor(USDC)

const apiQuote: AggregatorApiQuote = {
  assetIn: XLM_SAC,
  assetOut: USDC_SAC,
  amountIn: '300000000',
  amountOut: '9067253',
  otherAmountThreshold: '9021917',
  platform: 'aggregator',
  routePlan: [
    { protocol: 'soroswap', path: [XLM_SAC, USDC_SAC], percent: '60' },
    { protocol: 'aqua', path: [XLM_SAC, 'CINTERMEDIATE', USDC_SAC], percent: '40' },
  ],
  raw: { tradeType: 'EXACT_IN' },
}

const whitelist: ProtocolWhitelist = {
  protocols: ['soroswap', 'aqua', 'sdex'],
  adapters: [],
  resolvedAt: 0,
}

interface FakeApiOptions {
  aggregator?: string | undefined
  quote?: ApiResult<AggregatorApiQuote> | 'throw'
}

function fakeApi(options: FakeApiOptions = {}): SoroswapApi & { quoteCalls: unknown[] } {
  const api = {
    quoteCalls: [] as unknown[],
    isConfigured: () => true,
    async quote(req: unknown): Promise<ApiResult<AggregatorApiQuote>> {
      api.quoteCalls.push(req)
      if (options.quote === 'throw') throw new Error('boom')
      return options.quote ?? { ok: true, value: apiQuote }
    },
    async build(): Promise<ApiResult<string>> {
      return { ok: false, reason: 'upstream_error', detail: 'not under test' }
    },
    async contractAddress(): Promise<string | undefined> {
      return 'aggregator' in options ? options.aggregator : SOROSWAP_AGGREGATOR
    },
  }
  return api
}

function sendReq(amount = '300000000'): QuoteRequest {
  return { kind: 'strict_send', from: XLM, to: USDC, sendAmount: amount }
}

/** `null` stands for "the adapters could not be read"; `undefined` would pick the default. */
function quoter(api = fakeApi(), protocols: ProtocolWhitelist | null = whitelist) {
  return createSoroswapAggregatorQuoter({
    apiKey: 'sk_test',
    api,
    protocolsImpl: async () => protocols ?? undefined,
  })
}

describe('presence', () => {
  it('is absent without an API key', () => {
    expect(createSoroswapAggregatorQuoter({ apiKey: '' }).isConfigured()).toBe(false)
  })

  it('is present with one', () => {
    expect(createSoroswapAggregatorQuoter({ apiKey: 'sk_test' }).isConfigured()).toBe(true)
  })

  it('names itself apart from the AMM', () => {
    // "via soroswap" and "via soroswap-aggregator" are different claims about
    // where a fill came from, and the confirm screen must be able to make
    // either.
    const source = quoter()
    expect(source.id).toBe('soroswap-aggregator')
    expect(source.displayName).not.toBe('Soroswap')
    expect(sourceDisplayName('soroswap-aggregator')).toBe(source.displayName)
    expect(sourceDisplayName('soroswap')).toBe('Soroswap')
  })
})

describe('what is refused before the network', () => {
  it('declines a fixed-output request', async () => {
    const api = fakeApi()
    const out = await quoter(api).quote({
      kind: 'strict_receive',
      from: XLM,
      to: USDC,
      receiveAmount: '1000000',
    })

    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.failure.reason).toBe('unsupported_pair')
    expect(api.quoteCalls).toHaveLength(0)
  })

  it('declines an asset the app has not verified', async () => {
    const api = fakeApi()
    const out = await quoter(api).quote({
      kind: 'strict_send',
      from: XLM,
      to: {
        kind: 'classic',
        code: 'USDCoin',
        issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      },
      sendAmount: '100',
    })

    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.failure.reason).toBe('unsupported_pair')
    expect(api.quoteCalls).toHaveLength(0)
  })
})

describe('a quote through the resolved aggregator', () => {
  it('asks with the live whitelist and the canonical contracts', async () => {
    const api = fakeApi()
    await quoter(api).quote(sendReq())

    expect(api.quoteCalls).toEqual([
      {
        assetIn: XLM_SAC,
        assetOut: USDC_SAC,
        amount: '300000000',
        protocols: ['soroswap', 'aqua', 'sdex'],
        slippageBps: 50,
      },
    ])
  })

  it('carries its own id, the split, and no substituted asset', async () => {
    const out = await quoter().quote(sendReq())

    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.quote.source).toBe('soroswap-aggregator')
    expect(out.quote.kind).toBe('strict_send')
    expect(out.quote.sendAmount).toBe('300000000')
    expect(out.quote.destAmount).toBe('9067253')
    // No classic hops to replay: the API replays its own plan at build time.
    expect(out.quote.path).toEqual([])
    // The plan itself, so an agent can see that 40% went a longer way.
    expect(out.quote.routePlan).toEqual([
      { protocol: 'soroswap', percent: '60', hops: 0 },
      { protocol: 'aqua', percent: '40', hops: 1 },
    ])
    expect(out.quote.platform).toBe('aggregator')
    // Both ends are Stellar Asset Contracts, which *are* the classic assets.
    expect(out.quote.deliversAsset).toBeUndefined()
  })

  it('keeps the raw quote for the builder', async () => {
    const out = await quoter().quoteWithRaw(sendReq())

    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.quoted.raw).toBe(apiQuote)
    expect(out.quoted.aggregatorId).toBe(SOROSWAP_AGGREGATOR)
    expect(out.quoted.protocols).toEqual(['soroswap', 'aqua', 'sdex'])
  })
})

describe('what makes the source unavailable', () => {
  it('cannot resolve the aggregator id', async () => {
    const api = fakeApi({ aggregator: undefined })
    const out = await quoter(api).quote(sendReq())

    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.failure.reason).toBe('unavailable')
    expect(api.quoteCalls).toHaveLength(0)
  })

  it('is handed an aggregator this app has not reviewed', async () => {
    // A rotated contract shows up here, not as a signed call to a stranger.
    const api = fakeApi({ aggregator: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC' })
    const out = await quoter(api).quote(sendReq())

    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.failure.reason).toBe('unavailable')
    expect(api.quoteCalls).toHaveLength(0)
  })

  it('cannot read the adapters', async () => {
    const api = fakeApi()
    const out = await quoter(api, null).quote(sendReq())

    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.failure.reason).toBe('unavailable')
    expect(api.quoteCalls).toHaveLength(0)
  })
})

describe('an answer that does not match the question is refused', () => {
  it('refuses a plan through a venue it did not ask for', async () => {
    const api = fakeApi({
      quote: {
        ok: true,
        value: {
          ...apiQuote,
          routePlan: [{ protocol: 'phoenix', path: [XLM_SAC, USDC_SAC], percent: '100' }],
        },
      },
    })
    const out = await quoter(api).quote(sendReq())

    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.failure.reason).toBe('upstream_error')
      expect(out.failure.detail).toMatch(/phoenix/)
    }
  })

  it('refuses a quote for a different amount or pair', async () => {
    const wrongAmount = fakeApi({ quote: { ok: true, value: { ...apiQuote, amountIn: '1' } } })
    const wrongPair = fakeApi({ quote: { ok: true, value: { ...apiQuote, assetOut: XLM_SAC } } })

    const a = await quoter(wrongAmount).quote(sendReq())
    const b = await quoter(wrongPair).quote(sendReq())

    expect(a.ok).toBe(false)
    expect(b.ok).toBe(false)
  })

  it('refuses a quote that delivers nothing', async () => {
    const api = fakeApi({ quote: { ok: true, value: { ...apiQuote, amountOut: '0' } } })
    const out = await quoter(api).quote(sendReq())

    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.failure.reason).toBe('no_route')
  })
})

describe('failures pass through as outcomes', () => {
  it("carries the API's own reason", async () => {
    const api = fakeApi({ quote: { ok: false, reason: 'no_route', detail: 'No route found' } })
    const out = await quoter(api).quote(sendReq())

    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.failure.source).toBe('soroswap-aggregator')
      expect(out.failure.reason).toBe('no_route')
      expect(out.failure.detail).toBe('No route found')
    }
  })

  it('never throws', async () => {
    const out = await quoter(fakeApi({ quote: 'throw' })).quote(sendReq())

    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.failure.reason).toBe('upstream_error')
  })
})
