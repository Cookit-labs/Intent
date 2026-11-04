import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { afterSubmitting } from '../chains/signing-flow'

const state = vi.hoisted(() => ({
  submit: undefined as unknown,
  assertSafe: undefined as unknown,
  submitted: 0,
}))

vi.mock('../server/analytics', () => ({ logExecution: async () => undefined }))
vi.mock('../server/rate-limit', () => ({ enforceRateLimit: async () => undefined }))
vi.mock('../server/report', () => ({ reportError: () => undefined }))
vi.mock('../chains/registry', () => ({
  chainModule: () => ({
    chain: 'solana',
    submit: (input: unknown) => {
      state.submitted += 1
      return (state.submit as (i: unknown) => unknown)(input)
    },
    venues: [{ id: 'v', assertSafe: () => (state.assertSafe as () => void)() }],
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

beforeEach(() => {
  state.assertSafe = () => undefined
  state.submitted = 0
})

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

  it('answers pending even if a refusal is thrown once sending has started', async () => {
    // Loaded here because the route gets a fresh copy of this module after each reset.
    const { ChainActionRefused } = await import('../chains/types')
    state.submit = async () => {
      throw new ChainActionRefused('Refused after the send.')
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

describe('the chain submit route before anything is sent', () => {
  it('answers 422 with the refusal when the signed bytes fail the safety check', async () => {
    const { ChainActionRefused } = await import('../chains/types')
    state.assertSafe = () => {
      throw new ChainActionRefused('This transaction calls a program it should not need.')
    }
    state.submit = async () => ({ ok: true, hash: 'x', explorerUrl: 'y' })
    const res = await post()
    expect(res.status).toBe(422)
    await expect(res.json()).resolves.toEqual({
      ok: false,
      error: 'This transaction calls a program it should not need.',
    })
    expect(state.submitted).toBe(0)
  })

  it('says nothing was sent when the safety check itself breaks', async () => {
    state.assertSafe = () => {
      throw new TypeError('cannot read the transaction')
    }
    state.submit = async () => ({ ok: true, hash: 'x', explorerUrl: 'y' })
    const res = await post()
    const json = (await res.json()) as { error: string; pending?: boolean }
    expect(res.status).toBe(422)
    expect(json.pending).toBeUndefined()
    expect(json.error).toMatch(/nothing was sent/i)
    expect(JSON.stringify(json)).not.toContain('cannot read the transaction')
    expect(afterSubmitting(json, 'solana')).toMatchObject({ phase: 'failed', latched: false })
    expect(state.submitted).toBe(0)
  })
})
