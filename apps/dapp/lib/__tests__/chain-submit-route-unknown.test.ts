import { afterEach, describe, expect, it, vi } from 'vitest'

import { afterSubmitting } from '../chains/signing-flow'

const state = vi.hoisted(() => ({ submit: undefined as unknown }))

vi.mock('../server/analytics', () => ({ logExecution: async () => undefined }))
vi.mock('../server/rate-limit', () => ({ enforceRateLimit: async () => undefined }))
vi.mock('../server/report', () => ({ reportError: () => undefined }))
vi.mock('../chains/registry', () => ({
  chainModule: () => ({
    chain: 'solana',
    submit: (input: unknown) => (state.submit as (i: unknown) => unknown)(input),
    venues: [{ id: 'v', assertSafe: () => undefined }],
  }),
}))

const body = {
  account: '11111111111111111111111111111111',
  venueId: 'v',
  signed: { family: 'solana', signedTransaction: 'abc' },
}

async function post(): Promise<Response> {
  const { POST } = await import('../../app/api/chain/[chain]/submit/route')
  return POST(
    new Request('http://localhost/api/chain/solana/submit', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ chain: 'solana' }) }
  )
}

afterEach(() => vi.resetModules())

describe('the chain submit route when the outcome is unknown', () => {
  it('answers pending (202) from its catch-all, which holds the latch', async () => {
    state.submit = async () => {
      throw new Error('rpc timed out')
    }
    const res = await post()
    const json = await res.json()
    expect(res.status).toBe(202)
    expect(json).toMatchObject({ ok: false, pending: true })
    expect(afterSubmitting(json, 'solana')).toMatchObject({ phase: 'pending', latched: true })
  })

  it('still answers 422 for a clean refusal, which releases the latch on a signed-bytes wallet', async () => {
    state.submit = async () => ({ ok: false, error: 'The network rejected this transaction.' })
    const res = await post()
    const json = await res.json()
    expect(res.status).toBe(422)
    expect(afterSubmitting(json, 'solana')).toMatchObject({ phase: 'failed', latched: false })
  })
})
