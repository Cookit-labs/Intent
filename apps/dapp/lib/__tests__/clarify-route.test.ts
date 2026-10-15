import { beforeEach, describe, expect, it, vi } from 'vitest'

const clarifyWithLlm = vi.fn()

vi.mock('../clarify/clarify', () => ({
  clarifyWithLlm: (...args: unknown[]) => clarifyWithLlm(...args),
}))
vi.mock('../server/rate-limit', () => ({ enforceRateLimit: async () => undefined }))

function post(body: unknown): Request {
  return new Request('http://localhost/api/intent/clarify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function route() {
  return import('../../app/api/intent/clarify/route')
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/intent/clarify', () => {
  it('returns the question the model asked', async () => {
    clarifyWithLlm.mockResolvedValue({ status: 'ask', question: 'Which asset?' })
    const { POST } = await route()
    const res = await POST(post({ turns: [{ role: 'user', content: 'offramp $5' }] }))
    expect(await res.json()).toEqual({ status: 'ask', question: 'Which asset?' })
  })

  it('returns the request written out, with the earlier turns passed as context', async () => {
    clarifyWithLlm.mockResolvedValue({
      status: 'ready',
      instruction: 'Send 1 USDC to deon.xlm',
      context: ['Asset: USDC'],
    })
    const { POST } = await route()
    const res = await POST(
      post({
        turns: [{ role: 'user', content: 'send half of it to deon.xlm' }],
        context: ['Earlier in this chat (done): swap $2 of XLM to USDC'],
      })
    )
    expect(await res.json()).toMatchObject({
      status: 'ready',
      instruction: 'Send 1 USDC to deon.xlm',
    })
    expect(clarifyWithLlm).toHaveBeenCalledWith(
      [{ role: 'user', content: 'send half of it to deon.xlm' }],
      { context: ['Earlier in this chat (done): swap $2 of XLM to USDC'] }
    )
  })

  it('says skip, not an error, when the model could not help', async () => {
    clarifyWithLlm.mockResolvedValue(null)
    const { POST } = await route()
    const res = await POST(post({ turns: [{ role: 'user', content: 'x' }] }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'skip' })
  })

  it('refuses a body that is not a short list of turns', async () => {
    const { POST } = await route()
    expect((await POST(post({ turns: [] }))).status).toBe(400)
    expect((await POST(post({ turns: [{ role: 'system', content: 'x' }] }))).status).toBe(400)
    expect((await POST(post({ turns: [{ role: 'user', content: 'x'.repeat(501) }] }))).status).toBe(
      400
    )
    expect(clarifyWithLlm).not.toHaveBeenCalled()
  })
})
