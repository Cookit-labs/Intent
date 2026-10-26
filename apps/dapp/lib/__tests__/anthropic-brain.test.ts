import Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'

import type { MarketContext, ProposalRequest } from '../agents/brain'
import { createClaudeBrain } from '../agents/brains/anthropic'
import { parseIntent } from '../parse-intent'

/**
 * Claude runs through Anthropic's SDK, not the chat-completions client, so its
 * request shape and its failure modes are tested on their own. The SDK's
 * transport is faked: no network, no key.
 */

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
  agent: 'anthropic:claude-opus-5-5',
  seat: 0,
  market,
  chain: 'arc',
}

const proposal = {
  routeId: '',
  reasoning: 'Slicing into six tranches over thirty minutes to limit impact.',
  projectedAvgPriceUsd: 3500,
  projectedSlippagePct: 0.18,
  venues: ['uniswap'],
  sliceCount: 6,
  confidence: 0.8,
  horizonMinutes: 30,
  executionMode: 'fill',
  restPriceUsd: 0,
  splitPct: 0,
  thenAction: 'none',
  thenVenue: '',
}

function message(content: unknown[], stopReason = 'tool_use'): unknown {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 2300, output_tokens: 400, cache_read_input_tokens: 1800 },
  }
}

function clientReturning(
  status: number,
  body: unknown,
  sent: unknown[] = [],
  headers: Record<string, string> = {}
): Anthropic {
  return new Anthropic({
    apiKey: 'sk-ant-test',
    maxRetries: 0,
    fetch: (async (_url: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', ...headers },
      })
    }) as typeof fetch,
  })
}

describe('claude brain', () => {
  it('turns a submit_proposal call into a validated proposal', async () => {
    const sent: Record<string, unknown>[] = []
    const brain = createClaudeBrain({
      client: clientReturning(
        200,
        message([{ type: 'tool_use', id: 't1', name: 'submit_proposal', input: proposal }]),
        sent
      ),
    })
    const outcome = await brain.propose(request)
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.proposal.sliceCount).toBe(6)
    if (outcome.ok) expect(outcome.meta.cachedTokens).toBe(1800)

    const body = sent[0]
    expect(body).toMatchObject({
      model: 'claude-opus-5-5',
      tool_choice: { type: 'auto' },
      fallbacks: 'default',
      output_config: { effort: 'medium' },
    })
    expect(body).not.toHaveProperty('temperature')
    expect(body).not.toHaveProperty('thinking')
  })

  it('reports a refusal as refused', async () => {
    const brain = createClaudeBrain({
      client: clientReturning(200, message([], 'refusal')),
    })
    expect(await brain.propose(request)).toMatchObject({ ok: false, error: 'refused' })
  })

  it('reports a prose reply as invalid_schema', async () => {
    const brain = createClaudeBrain({
      client: clientReturning(200, message([{ type: 'text', text: 'I would buy.' }], 'end_turn')),
    })
    expect(await brain.propose(request)).toMatchObject({ ok: false, error: 'invalid_schema' })
  })

  it('reports a 429 as rate_limited with its retry-after', async () => {
    const brain = createClaudeBrain({
      client: clientReturning(
        429,
        { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } },
        [],
        { 'retry-after': '20' }
      ),
    })
    expect(await brain.propose(request)).toMatchObject({
      ok: false,
      error: 'rate_limited',
      retryAfterMs: 20_000,
    })
  })

  it('is not configured without a key', () => {
    expect(createClaudeBrain({ apiKey: '' }).isConfigured()).toBe(false)
  })
})
