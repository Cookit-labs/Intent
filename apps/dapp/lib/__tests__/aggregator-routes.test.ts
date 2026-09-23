import { afterEach, describe, expect, it, vi } from 'vitest'

import { defaultQuoteSources, quoteRoutes } from '../agents/market-context'
import { USDC, XLM } from '../swap/assets'
import type { QuoteSource, SwapQuote } from '../swap/quote'

/**
 * The aggregator in the agents' line-up.
 *
 * Two things are pinned. It is present exactly when a key is set, and absent
 * otherwise — not present-but-failing, which would show four agents a venue
 * that never answers. And when it does answer, the route it becomes says
 * what the plan was: `path` is empty for an aggregator quote because there
 * are no classic hops to replay, and a route that read "direct" for a swap
 * split 60/40 across two AMMs would hide the one fact that distinguishes it
 * from the direct quoters beside it.
 */

const split: SwapQuote = {
  source: 'soroswap-aggregator',
  kind: 'strict_send',
  from: XLM,
  to: USDC,
  sendAmount: '300000000',
  destAmount: '9067253',
  path: [],
  routePlan: [
    { protocol: 'soroswap', percent: '60', hops: 0 },
    { protocol: 'aqua', percent: '40', hops: 1 },
  ],
  platform: 'aggregator',
  quotedAt: new Date().toISOString(),
}

function stubSource(configured: boolean, quote: SwapQuote = split): QuoteSource {
  return {
    id: 'soroswap-aggregator',
    displayName: 'Soroswap Aggregator',
    isConfigured: () => configured,
    quote: async () => ({ ok: true, quote }),
  }
}

afterEach(() => vi.unstubAllEnvs())

describe('presence in the line-up', () => {
  it('is in the default sources only when a key is set', () => {
    vi.stubEnv('SOROSWAP_API_KEY', '')
    const without = defaultQuoteSources().find((s) => s.id === 'soroswap-aggregator')
    expect(without).toBeDefined()
    expect(without?.isConfigured()).toBe(false)

    vi.stubEnv('SOROSWAP_API_KEY', 'sk_test')
    const withKey = defaultQuoteSources().find((s) => s.id === 'soroswap-aggregator')
    expect(withKey?.isConfigured()).toBe(true)
  })

  it('keeps the direct quoters beside it rather than replacing them', () => {
    // Several of the aggregator's routes originate from Soroswap's own router
    // and from Aquarius's. Independent sources are what make the comparison
    // a comparison; one vendor's view of every venue is not.
    const ids = defaultQuoteSources().map((s) => s.id)
    expect(ids).toContain('horizon')
    expect(ids).toContain('soroswap')
    expect(ids).toContain('aquarius')
    expect(ids).toContain('soroswap-aggregator')
  })

  it('is skipped, not failed, when unconfigured', async () => {
    const routes = await quoteRoutes('stellar', 'XLM', 'USDC', '300000000', undefined, {
      sources: [stubSource(false)],
    })
    expect(routes).toEqual([])
  })
})

describe('the route an agent reads', () => {
  it('carries the aggregator id and is executable', async () => {
    const [route] = await quoteRoutes('stellar', 'XLM', 'USDC', '300000000', undefined, {
      sources: [stubSource(true)],
    })

    expect(route?.id).toBe('soroswap-aggregator-1')
    expect(route?.source).toBe('soroswap-aggregator')
    // Both ends are canonical Stellar Asset Contracts, so nothing is
    // substituted and the route can be signed.
    expect(route?.executable).toBe(true)
    expect(route?.receiveAmount).toBe('0.9067253 USDC')
  })

  it('describes the split rather than calling it direct', async () => {
    const [route] = await quoteRoutes('stellar', 'XLM', 'USDC', '300000000', undefined, {
      sources: [stubSource(true)],
    })

    expect(route?.via).toBe('split 60% soroswap direct + 40% aqua via 1 hop')
    expect(route?.hops).toBe(1)
  })

  it('still reads direct for a single-venue plan with no hops', async () => {
    const single: SwapQuote = {
      ...split,
      routePlan: [{ protocol: 'sdex', percent: '100', hops: 0 }],
      platform: 'sdex',
    }
    const [route] = await quoteRoutes('stellar', 'XLM', 'USDC', '300000000', undefined, {
      sources: [stubSource(true, single)],
    })

    expect(route?.via).toBe('100% sdex direct')
  })
})
