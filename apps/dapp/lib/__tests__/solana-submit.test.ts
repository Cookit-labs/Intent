import { getBase58Decoder } from '@solana/kit'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createJupiterSwapVenue } from '../chains/solana/jupiter-swap'
import { createSolanaSubmit } from '../chains/solana/submit'
import {
  CAPTURE_ACCOUNT,
  JUPITER_LEND_USDC_DEPOSIT,
  JUPITER_SOL_TO_USDC,
} from '../chains/solana/__fixtures__/captured-transactions'
import type { SubmitInput } from '../chains/types'

/**
 * No signature here is real, and nothing reaches a network: fetch is stubbed. The
 * bytes stand in for what a wallet returns, so the signature slot is only non-zero.
 */
function fakeSigned(base64: string): { transaction: string; signature: string } {
  const bytes = Buffer.from(base64, 'base64')
  bytes.fill(7, 1, 65)
  return {
    transaction: bytes.toString('base64'),
    signature: getBase58Decoder().decode(bytes.subarray(1, 65)),
  }
}

const signed = fakeSigned(JUPITER_LEND_USDC_DEPOSIT)
const input = (signedTransaction: string): SubmitInput => ({
  account: CAPTURE_ACCOUNT,
  venueId: 'kamino',
  signed: { family: 'solana', signedTransaction },
})

type Rpc = (method: string, params: unknown[]) => unknown

function stubRpc(rpc: Rpc): { calls: { url: string; method: string; params: unknown[] }[] } {
  const calls: { url: string; method: string; params: unknown[] }[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const { method, params } = JSON.parse(String(init.body)) as {
      method: string
      params: unknown[]
    }
    calls.push({ url, method, params })
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: 1, ...(rpc(method, params) as object) })
    )
  })
  return { calls }
}

const ok = (result: unknown) => ({ result })
const status = (value: unknown) => ok({ context: { slot: 1 }, value: [value] })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('solana submit', () => {
  const submit = (env: Record<string, string> = {}, maxPolls = 3) =>
    createSolanaSubmit({ env, pollMs: 0, maxPolls })

  it('sends, polls and returns the hash and a Solscan link', async () => {
    let polls = 0
    const { calls } = stubRpc((method) => {
      if (method === 'sendTransaction') return ok(signed.signature)
      polls += 1
      return polls === 1 ? status(null) : status({ confirmationStatus: 'confirmed', err: null })
    })
    await expect(submit()(input(signed.transaction))).resolves.toEqual({
      ok: true,
      hash: signed.signature,
      explorerUrl: `https://solscan.io/tx/${signed.signature}`,
    })
    expect(calls[0]?.url).toBe('https://solana-rpc.publicnode.com')
    expect(calls[0]?.params[0]).toBe(signed.transaction)
    expect(calls[0]?.params[1]).toMatchObject({ encoding: 'base64' })
    expect(polls).toBe(2)
  })

  it('uses SOLANA_RPC_URL when set', async () => {
    const { calls } = stubRpc((method) =>
      method === 'sendTransaction'
        ? ok(signed.signature)
        : status({ confirmationStatus: 'finalized', err: null })
    )
    await submit({ SOLANA_RPC_URL: 'https://rpc.example.test' })(input(signed.transaction))
    expect(calls[0]?.url).toBe('https://rpc.example.test')
  })

  it('refuses unsigned bytes without calling anyone', async () => {
    const { calls } = stubRpc(() => ok(''))
    const result = await submit()(input(JUPITER_LEND_USDC_DEPOSIT))
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/sign/i) })
    expect(calls).toHaveLength(0)
  })

  it('refuses another chain’s payload', async () => {
    const result = await submit()({
      account: CAPTURE_ACCOUNT,
      venueId: 'kamino',
      signed: { family: 'near', hashes: ['x'] },
    })
    expect(result.ok).toBe(false)
  })

  it('explains an expired blockhash at send', async () => {
    stubRpc(() => ({
      error: {
        code: -32002,
        message: 'Transaction simulation failed: Blockhash not found',
        data: { err: 'BlockhashNotFound', logs: [] },
      },
    }))
    const result = await submit()(input(signed.transaction))
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/expired/i) })
    expect(result).toMatchObject({ error: expect.stringMatching(/nothing moved/i) })
  })

  it('explains a failed simulation without raw logs', async () => {
    stubRpc(() => ({
      error: {
        code: -32002,
        message: 'Transaction simulation failed',
        data: { err: { InstructionError: [1, { Custom: 6001 }] }, logs: ['Program log: secret'] },
      },
    }))
    const result = await submit()(input(signed.transaction))
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/simulation|check/i) })
    expect(JSON.stringify(result)).not.toMatch(/secret|6001/)
  })

  it('explains a balance that is too low', async () => {
    stubRpc(() => ({
      error: {
        code: -32002,
        message: 'Transaction simulation failed',
        data: {
          err: { InstructionError: [1, { Custom: 1 }] },
          logs: ['Program log: Error: insufficient funds'],
        },
      },
    }))
    const result = await submit()(input(signed.transaction))
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/balance|enough/i) })
  })

  it('says when no SOL is left for the fee', async () => {
    stubRpc(() => ({
      error: {
        code: -32002,
        message: 'Transaction simulation failed',
        data: { err: 'AccountNotFound', logs: [] },
      },
    }))
    const result = await submit()(input(signed.transaction))
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/SOL/) })
  })

  it('reports a transaction that landed and failed', async () => {
    stubRpc((method) =>
      method === 'sendTransaction'
        ? ok(signed.signature)
        : status({ confirmationStatus: 'confirmed', err: { InstructionError: [0, 'x'] } })
    )
    const result = await submit()(input(signed.transaction))
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('solscan.io') })
  })

  it('stops polling at its bound and calls an expired blockhash final', async () => {
    const { calls } = stubRpc((method) => {
      if (method === 'sendTransaction') return ok(signed.signature)
      if (method === 'isBlockhashValid') return ok({ context: { slot: 1 }, value: false })
      return status(null)
    })
    const result = await submit({}, 3)(input(signed.transaction))
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/expired/i) })
    expect(calls.filter((c) => c.method === 'getSignatureStatuses')).toHaveLength(3)
  })

  it('does not claim failure while the transaction could still land', async () => {
    stubRpc((method) => {
      if (method === 'sendTransaction') return ok(signed.signature)
      if (method === 'isBlockhashValid') return ok({ context: { slot: 1 }, value: true })
      return status(null)
    })
    const result = await submit({}, 2)(input(signed.transaction))
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('solscan.io') })
    expect(result).toMatchObject({ error: expect.stringMatching(/before trying again/i) })
  })

  it('treats a failed send over the network as unknown, for the route to report', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('socket hang up')
    })
    await expect(submit()(input(signed.transaction))).rejects.toThrow()
  })

  it('keeps polling through a failed status read', async () => {
    let polls = 0
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const { method } = JSON.parse(String(init.body)) as { method: string }
      if (method === 'sendTransaction') {
        return new Response(JSON.stringify({ result: signed.signature }))
      }
      polls += 1
      if (polls === 1) throw new Error('flaky')
      return new Response(
        JSON.stringify({ result: { value: [{ confirmationStatus: 'confirmed', err: null }] } })
      )
    })
    await expect(submit()(input(signed.transaction))).resolves.toMatchObject({ ok: true })
  })
})

describe('jupiter execute', () => {
  const swapSigned = fakeSigned(JUPITER_SOL_TO_USDC)
  const venue = createJupiterSwapVenue({ priceUsd: async () => 1, env: {}, retryDelayMs: 0 })
  const executeInput: SubmitInput = {
    account: CAPTURE_ACCOUNT,
    venueId: 'jupiter',
    signed: { family: 'solana', signedTransaction: swapSigned.transaction },
    context: { requestId: 'request-1' },
  }

  function answering(body: unknown, statusCode = 200): { requests: unknown[]; urls: string[] } {
    const requests: unknown[] = []
    const urls: string[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      urls.push(url)
      requests.push(JSON.parse(String(init.body)))
      return new Response(JSON.stringify(body), { status: statusCode })
    })
    return { requests, urls }
  }

  it('passes the signed bytes and request id to execute, and returns the hash', async () => {
    const { requests, urls } = answering({
      status: 'Success',
      signature: swapSigned.signature,
      code: 0,
    })
    await expect(venue.submit?.(executeInput)).resolves.toEqual({
      ok: true,
      hash: swapSigned.signature,
      explorerUrl: `https://solscan.io/tx/${swapSigned.signature}`,
    })
    expect(urls[0]).toBe('https://api.jup.ag/swap/v2/execute')
    expect(requests[0]).toEqual({
      signedTransaction: swapSigned.transaction,
      requestId: 'request-1',
    })
  })

  it('refuses without a request id', async () => {
    answering({})
    const { context: _context, ...rest } = executeInput
    await expect(venue.submit?.(rest)).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/fresh quote/i),
    })
  })

  it('refuses unsigned bytes without calling Jupiter', async () => {
    const { urls } = answering({})
    await expect(
      venue.submit?.({
        ...executeInput,
        signed: { family: 'solana', signedTransaction: JUPITER_SOL_TO_USDC },
      })
    ).resolves.toMatchObject({ ok: false })
    expect(urls).toHaveLength(0)
  })

  it.each([
    [-1, /expired|fresh quote/i],
    [-1005, /expired/i],
    [-1004, /expired/i],
    [-1000, /did not land/i],
    [-1003, /sign/i],
    [-9999, /did not go through/i],
  ])('explains execute code %i', async (code, message) => {
    answering({ status: 'Failed', code, error: 'upstream text' })
    const result = await venue.submit?.(executeInput)
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(message) })
    expect(JSON.stringify(result)).not.toContain('upstream text')
  })

  it('reports a rejected request as nothing sent', async () => {
    answering({ error: 'bad' }, 400)
    await expect(venue.submit?.(executeInput)).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/fresh quote/i),
    })
  })

  it('leaves an unknown outcome to the route, which tells the user to check their wallet', async () => {
    answering({}, 500)
    await expect(venue.submit?.(executeInput)).rejects.toThrow()
    vi.stubGlobal('fetch', async () => {
      throw new DOMException('timed out', 'TimeoutError')
    })
    await expect(venue.submit?.(executeInput)).rejects.toThrow()
  })
})
