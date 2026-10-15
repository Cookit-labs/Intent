import { beforeEach, describe, expect, it, vi } from 'vitest'

const orchestrateWithLlm = vi.fn()
const isLlmParseConfigured = vi.fn()
const logIntentRead = vi.fn()

vi.mock('../orchestrate/orchestrate', () => ({
  orchestrateWithLlm: (...args: unknown[]) => orchestrateWithLlm(...args),
}))
vi.mock('../parse-intent-llm', () => ({
  isLlmParseConfigured: () => isLlmParseConfigured(),
}))
vi.mock('../server/rate-limit', () => ({ enforceRateLimit: async () => undefined }))
vi.mock('../server/analytics', () => ({
  logIntentRead: (...args: unknown[]) => logIntentRead(...args),
}))
vi.mock('../lend/venues', () => ({ configuredLendingVenues: () => ['blend'] }))
vi.mock('../swap/live-assets', () => ({
  ensureLiveAssets: async () => undefined,
  tickersIn: () => [],
}))
vi.mock('../swap/asset-registry', () => ({
  tradeableSymbols: () => ['XLM', 'USDC'],
  resolveVerifiedAsset: (s: string) => (['XLM', 'USDC'].includes(s) ? { symbol: s } : undefined),
}))

const reading = {
  action: 'swap',
  tokenIn: 'XLM',
  tokenOut: 'USDC',
  amountUsd: 5,
  amountIsUsd: true,
  amountStated: true,
  followOn: null,
}

function post(body: unknown): Request {
  return new Request('http://localhost/api/intent/orchestrate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const turns = (content: string) => [{ role: 'user', content }]

async function route() {
  return import('../../app/api/intent/orchestrate/route')
}

beforeEach(() => {
  vi.clearAllMocks()
  isLlmParseConfigured.mockReturnValue(true)
})

describe('POST /api/intent/orchestrate', () => {
  it('returns the reading and the standalone instruction for an act', async () => {
    orchestrateWithLlm.mockResolvedValue({
      status: 'act',
      reading,
      style: 'limit',
      limitPriceUsd: 0.19,
      instruction: 'Swap $5 of XLM to USDC',
      context: ['Asset: XLM'],
    })
    const { POST } = await route()
    const res = await POST(post({ turns: turns('flip $5 of lumens into dollars') }))
    expect(await res.json()).toMatchObject({
      outcome: 'act',
      action: 'swap',
      tokenIn: 'XLM',
      tokenOut: 'USDC',
      amountUsd: 5,
      amountStated: true,
      amountIsUsd: true,
      followOn: null,
      style: 'limit',
      limitPriceUsd: 0.19,
      instruction: 'Swap $5 of XLM to USDC',
      context: ['Asset: XLM'],
    })
    expect(logIntentRead).toHaveBeenCalledWith(
      expect.objectContaining({ understood: true, action: 'swap' })
    )
  })

  it('passes the question, help and out-of-scope answers through', async () => {
    const { POST } = await route()

    orchestrateWithLlm.mockResolvedValueOnce({ status: 'ask', question: 'Which asset?' })
    expect(await (await POST(post({ turns: turns('cash out') }))).json()).toEqual({
      outcome: 'ask',
      question: 'Which asset?',
    })

    orchestrateWithLlm.mockResolvedValueOnce({ status: 'help' })
    expect(await (await POST(post({ turns: turns('what can I do?') }))).json()).toEqual({
      outcome: 'help',
    })

    orchestrateWithLlm.mockResolvedValueOnce({ status: 'out_of_scope', reason: 'Exercise.' })
    expect(await (await POST(post({ turns: turns('go jogging') }))).json()).toEqual({
      outcome: 'out_of_scope',
      reason: 'Exercise.',
    })
    // Understood and declined, so the admin read rate is not dragged down by it.
    expect(logIntentRead).toHaveBeenCalledWith({ understood: true, action: 'out_of_scope' })
  })

  it('says unavailable, not an error, when the model could not read it', async () => {
    orchestrateWithLlm.mockResolvedValue(null)
    const { POST } = await route()
    const res = await POST(post({ turns: turns('hmm') }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ outcome: 'unavailable', reason: 'unreadable' })
  })

  it('names an unrecognised ticker so the chat can ask which token was meant', async () => {
    orchestrateWithLlm.mockResolvedValue(null)
    const { POST } = await route()
    const res = await POST(post({ turns: turns('swap $5 of XLM to DOGE') }))
    expect(await res.json()).toEqual({
      outcome: 'unavailable',
      reason: 'unknown_token',
      tokens: ['DOGE'],
    })
  })

  it('refuses a swap of an asset that can be borrowed but not traded', async () => {
    orchestrateWithLlm.mockResolvedValue({
      status: 'act',
      reading: { ...reading, tokenOut: 'WBTC' },
      instruction: 'Swap $5 of XLM to WBTC',
      context: [],
    })
    const { POST } = await route()
    const res = await POST(post({ turns: turns('swap $5 of XLM to wbtc') }))
    expect(await res.json()).toEqual({ outcome: 'unavailable', reason: 'not_tradeable' })
  })

  it('says not configured without calling the model when there is no key', async () => {
    isLlmParseConfigured.mockReturnValue(false)
    const { POST } = await route()
    const res = await POST(post({ turns: turns('swap') }))
    expect(await res.json()).toEqual({ outcome: 'unavailable', reason: 'not_configured' })
    expect(orchestrateWithLlm).not.toHaveBeenCalled()
  })

  it('refuses a body that is not a short list of turns', async () => {
    const { POST } = await route()
    expect((await POST(post({ turns: [] }))).status).toBe(400)
    expect((await POST(post({ turns: turns('x'.repeat(501)) }))).status).toBe(400)
    expect(orchestrateWithLlm).not.toHaveBeenCalled()
  })
})
