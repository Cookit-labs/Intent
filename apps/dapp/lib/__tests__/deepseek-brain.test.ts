import { describe, expect, it } from 'vitest'

import type { MarketContext, ProposalRequest } from '../agents/brain'
import { createDeepSeekBrain } from '../agents/brains/deepseek-brain'
import { validateProposal } from '../agents/tool-schema'
import { parseIntent } from '../parse-intent'

/**
 * Every failure mode gets its own test, because the fallback behaviour is what
 * keeps a competition renderable when an agent misbehaves. No network is
 * touched: `fetch` is injected.
 */

const SECRET = 'sk-test-do-not-leak-123456'

const market: MarketContext = {
  asOf: new Date().toISOString(),
  prices: { WETH: 3500, USDC: 1 },
  venues: [
    { id: 'uniswap', name: 'Uniswap', category: 'dex' },
    { id: 'curve', name: 'Curve', category: 'dex' },
  ],
  volatilityHint: 'normal',
  gasHint: 'normal',
}

const request: ProposalRequest = {
  intent: parseIntent('Accumulate 2 ETH below $3,200'),
  strategy: 'twap',
  market,
  chain: 'arc',
}

function goodArguments(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    // Required by the schema: strict mode has no optional fields, so an empty
    // string is the "no route was offered" case.
    routeId: '',
    reasoning: 'Slicing into six tranches over thirty minutes to limit impact.',
    projectedAvgPriceUsd: 3500,
    projectedSlippagePct: 0.18,
    venues: ['uniswap'],
    sliceCount: 6,
    confidence: 0.8,
    horizonMinutes: 30,
    ...overrides,
  })
}

function respondWith(payload: unknown, status = 200): typeof fetch {
  return (() =>
    Promise.resolve(
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    )) as unknown as typeof fetch
}

function toolResponse(args: string): unknown {
  return {
    choices: [{ message: { tool_calls: [{ function: { name: 'submit_proposal', arguments: args } }] } }],
    usage: { prompt_tokens: 1200, completion_tokens: 180, prompt_cache_hit_tokens: 900 },
  }
}

describe('deepseek brain', () => {
  it('returns a validated proposal on the happy path', async () => {
    const brain = createDeepSeekBrain({
      apiKey: SECRET,
      fetchImpl: respondWith(toolResponse(goodArguments())),
    })
    const outcome = await brain.propose(request)

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.proposal.strategy).toBe('twap')
    expect(outcome.proposal.sliceCount).toBe(6)
    expect(outcome.meta.degraded).toBe(false)
    expect(outcome.meta.costUsd).toBeGreaterThan(0)
  })

  it('reports missing configuration rather than calling out', async () => {
    const brain = createDeepSeekBrain({ apiKey: '', fetchImpl: respondWith({}) })
    const outcome = await brain.propose(request)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toBe('no_api_key')
    expect(brain.isConfigured()).toBe(false)
  })

  it('fails on malformed tool arguments', async () => {
    const brain = createDeepSeekBrain({
      apiKey: SECRET,
      fetchImpl: respondWith(toolResponse('{not json')),
    })
    const outcome = await brain.propose(request)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toBe('invalid_schema')
  })

  it('fails when the model replies with prose instead of a tool call', async () => {
    const brain = createDeepSeekBrain({
      apiKey: SECRET,
      fetchImpl: respondWith({ choices: [{ message: { content: 'I think you should buy.' } }] }),
    })
    const outcome = await brain.propose(request)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toBe('invalid_schema')
  })

  it('rejects a schema-valid but absurd slippage', async () => {
    // Strict mode constrains shape, not range: this is exactly what it lets through.
    const brain = createDeepSeekBrain({
      apiKey: SECRET,
      fetchImpl: respondWith(toolResponse(goodArguments({ projectedSlippagePct: 400 }))),
    })
    const outcome = await brain.propose(request)
    expect(outcome.ok).toBe(false)
  })

  it('rejects a fill price far from the reference', async () => {
    const brain = createDeepSeekBrain({
      apiKey: SECRET,
      fetchImpl: respondWith(toolResponse(goodArguments({ projectedAvgPriceUsd: 35000 }))),
    })
    const outcome = await brain.propose(request)
    expect(outcome.ok).toBe(false)
  })

  it('maps 429 to rate_limited and 500 to upstream_error', async () => {
    for (const [status, expected] of [
      [429, 'rate_limited'],
      [500, 'upstream_error'],
    ] as const) {
      const brain = createDeepSeekBrain({
        apiKey: SECRET,
        fetchImpl: respondWith({ error: 'nope' }, status),
      })
      const outcome = await brain.propose(request)
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.error).toBe(expected)
    }
  })

  it('reports an aborted request as a timeout', async () => {
    const brain = createDeepSeekBrain({
      apiKey: SECRET,
      fetchImpl: (() => {
        const err = new Error('aborted')
        err.name = 'AbortError'
        return Promise.reject(err)
      }) as unknown as typeof fetch,
    })
    const outcome = await brain.propose(request)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toBe('timeout')
  })

  it('never puts the api key in anything it returns', async () => {
    const cases = [
      respondWith(toolResponse(goodArguments())),
      respondWith({ error: 'boom' }, 500),
      respondWith(toolResponse('{bad')),
    ]
    for (const fetchImpl of cases) {
      const brain = createDeepSeekBrain({ apiKey: SECRET, fetchImpl })
      const outcome = await brain.propose(request)
      expect(JSON.stringify(outcome)).not.toContain(SECRET)
    }
  })

  it('sends the key as a bearer header and never in the body', async () => {
    let seenBody = ''
    let seenAuth = ''
    const brain = createDeepSeekBrain({
      apiKey: SECRET,
      fetchImpl: ((_url: string, init: RequestInit) => {
        seenBody = String(init.body)
        seenAuth = String((init.headers as Record<string, string>)['Authorization'])
        return Promise.resolve(
          new Response(JSON.stringify(toolResponse(goodArguments())), { status: 200 })
        )
      }) as unknown as typeof fetch,
    })
    await brain.propose(request)
    expect(seenAuth).toContain(SECRET)
    expect(seenBody).not.toContain(SECRET)
  })

  it('puts volatile content last so the cached prefix stays stable', async () => {
    let body = ''
    const brain = createDeepSeekBrain({
      apiKey: SECRET,
      fetchImpl: ((_u: string, init: RequestInit) => {
        body = String(init.body)
        return Promise.resolve(
          new Response(JSON.stringify(toolResponse(goodArguments())), { status: 200 })
        )
      }) as unknown as typeof fetch,
    })
    await brain.propose(request)
    const parsed = JSON.parse(body) as { messages: { role: string; content: string }[] }
    expect(parsed.messages[0]?.role).toBe('system')
    expect(parsed.messages.at(-1)?.role).toBe('user')
    expect(parsed.messages.at(-1)?.content).toContain('Accumulate 2 ETH')
  })
})

describe('validateProposal', () => {
  const ctx = { referencePriceUsd: 3500, allowedVenueIds: ['uniswap', 'curve'] }

  it('drops venues that were not offered rather than failing', () => {
    const result = validateProposal(JSON.parse(goodArguments({ venues: ['uniswap', 'sushi'] })), ctx)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.venues).toEqual(['uniswap'])
  })

  it('substitutes a venue when none of them were valid', () => {
    const result = validateProposal(JSON.parse(goodArguments({ venues: ['nope'] })), ctx)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.venues).toEqual(['uniswap'])
  })

  it('truncates an over-long reasoning to fit the bubble', () => {
    const result = validateProposal(
      JSON.parse(goodArguments({ reasoning: 'x'.repeat(1000) })),
      ctx
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.reasoning.length).toBeLessThanOrEqual(240)
  })
})

describe('route selection', () => {
  const ctx = {
    referencePriceUsd: 3500,
    allowedVenueIds: ['uniswap'],
    allowedRouteIds: ['horizon-1', 'horizon-2'],
  }

  it('accepts a route that was offered', () => {
    const r = validateProposal(JSON.parse(goodArguments({ routeId: 'horizon-1' })), ctx)
    expect(r.ok).toBe(true)
  })

  it('REJECTS a route that was never offered', () => {
    // A venue label can be dropped and the proposal still stands. A route id
    // selects the transaction that gets signed, so a wrong one must fail the
    // whole proposal rather than be substituted.
    const r = validateProposal(JSON.parse(goodArguments({ routeId: 'made-up' })), ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/was not offered/)
  })

  it('allows an empty route id when nothing was offered', () => {
    const r = validateProposal(JSON.parse(goodArguments({ routeId: '' })), {
      referencePriceUsd: 3500,
      allowedVenueIds: ['uniswap'],
    })
    expect(r.ok).toBe(true)
  })
})
