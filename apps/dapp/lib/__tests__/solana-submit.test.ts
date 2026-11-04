import { getBase58Decoder } from '@solana/kit'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { afterSubmitting } from '../chains/signing-flow'
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
    expect(calls.filter((c) => c.method === 'getSignatureStatuses')).toHaveLength(4)
  })

  it('does not claim failure while the transaction could still land', async () => {
    stubRpc((method) => {
      if (method === 'sendTransaction') return ok(signed.signature)
      if (method === 'isBlockhashValid') return ok({ context: { slot: 1 }, value: true })
      return status(null)
    })
    const result = await submit({}, 2)(input(signed.transaction))
    expect(result).toMatchObject({
      ok: false,
      pending: true,
      error: expect.stringContaining('solscan.io'),
    })
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

  describe('blockhash invalid after the send was accepted', () => {
    const EXPIRED =
      'This transaction expired before it reached the network, so nothing moved. Build it again and sign right away.'
    const THROWS = Symbol('the read never got an answer')
    const RPC_ERROR = Symbol('the read was answered with a JSON-RPC error')
    const EMPTY = Symbol('the read was answered with an empty list')
    const processed = { confirmationStatus: 'processed', err: null }
    const confirmed = { confirmationStatus: 'confirmed', err: null }

    /** Three polls and then the final read, each answered in turn. */
    function reads(answers: unknown[], blockhashValid = false) {
      let read = 0
      return stubRpc((method) => {
        if (method === 'sendTransaction') return ok(signed.signature)
        if (method === 'isBlockhashValid')
          return ok({ context: { slot: 1 }, value: blockhashValid })
        const answer = answers[read]
        read += 1
        if (answer === THROWS) throw new Error('socket hang up')
        if (answer === RPC_ERROR) return { error: { code: -32005, message: 'Node is behind' } }
        if (answer === EMPTY) return ok({ context: { slot: 1 }, value: [] })
        return status(answer)
      })
    }

    it('stays pending when a poll failed while the transaction landed', async () => {
      reads([THROWS, null, null, null])
      const result = await submit()(input(signed.transaction))
      expect(result).toMatchObject({ ok: false, pending: true })
      expect(JSON.stringify(result)).not.toContain('nothing moved')
      expect(afterSubmitting(result, 'solana')).toMatchObject({ phase: 'pending', latched: true })
    })

    it.each([
      ['every poll and the final read throw', [THROWS, THROWS, THROWS, THROWS]],
      ['only the last poll throws', [null, null, THROWS, null]],
      ['a poll gets a JSON-RPC error', [null, RPC_ERROR, null, null]],
      ['a poll gets an empty list', [EMPTY, null, null, null]],
      ['only the final read throws', [null, null, null, THROWS]],
      ['only the final read gets a JSON-RPC error', [null, null, null, RPC_ERROR]],
      ['a poll saw it processed and later reads lost it', [processed, null, null, null]],
      ['the final read sees it processed', [null, null, null, processed]],
    ])('stays pending when %s', async (_name, answers) => {
      reads(answers)
      const result = await submit()(input(signed.transaction))
      expect(result).toMatchObject({ ok: false, pending: true })
    })

    it('counts a status read answered with a server error as unanswered', async () => {
      vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
        const { method } = JSON.parse(String(init.body)) as { method: string }
        if (method === 'sendTransaction') {
          return new Response(JSON.stringify({ result: signed.signature }))
        }
        if (method === 'isBlockhashValid') {
          return new Response(JSON.stringify({ result: { value: false } }))
        }
        return new Response(JSON.stringify({ result: { value: [null] } }), { status: 503 })
      })
      await expect(submit()(input(signed.transaction))).resolves.toMatchObject({
        ok: false,
        pending: true,
      })
    })

    it('is final only when every poll and the final read answered and none saw it', async () => {
      reads([null, null, null, null])
      await expect(submit()(input(signed.transaction))).resolves.toEqual({
        ok: false,
        error: EXPIRED,
      })
    })

    it('makes the final read after the blockhash answer, searching history', async () => {
      const { calls } = reads([null, null, null, null])
      await submit()(input(signed.transaction))
      expect(calls.at(-2)?.method).toBe('isBlockhashValid')
      expect(calls.at(-1)?.method).toBe('getSignatureStatuses')
      expect(calls.at(-1)?.params[0]).toEqual([signed.signature])
      expect(calls.at(-1)?.params[1]).toEqual({ searchTransactionHistory: true })
    })

    it('reports success when the final read finds it confirmed', async () => {
      reads([THROWS, null, null, confirmed])
      await expect(submit()(input(signed.transaction))).resolves.toEqual({
        ok: true,
        hash: signed.signature,
        explorerUrl: `https://solscan.io/tx/${signed.signature}`,
      })
    })

    it('does not make a final read while the blockhash is still valid', async () => {
      const { calls } = reads([null, null, null], true)
      const result = await submit()(input(signed.transaction))
      expect(result).toMatchObject({ ok: false, pending: true })
      expect(calls.filter((c) => c.method === 'getSignatureStatuses')).toHaveLength(3)
    })
  })

  describe('a transaction that failed in a block', () => {
    const failed = { InstructionError: [0, 'x'] }

    it('does not believe a processed failure, which can sit on a dropped fork', async () => {
      stubRpc((method) => {
        if (method === 'sendTransaction') return ok(signed.signature)
        if (method === 'isBlockhashValid') return ok({ context: { slot: 1 }, value: true })
        return status({ confirmationStatus: 'processed', err: failed })
      })
      const result = await submit()(input(signed.transaction))
      expect(result).toMatchObject({ ok: false, pending: true })
      expect(JSON.stringify(result)).not.toContain('did not move')
    })

    it('stays pending when a processed failure is all there is at expiry', async () => {
      stubRpc((method) => {
        if (method === 'sendTransaction') return ok(signed.signature)
        if (method === 'isBlockhashValid') return ok({ context: { slot: 1 }, value: false })
        return status({ confirmationStatus: 'processed', err: failed })
      })
      await expect(submit()(input(signed.transaction))).resolves.toMatchObject({
        ok: false,
        pending: true,
      })
    })

    it('reports the success that follows a processed failure on a dropped fork', async () => {
      let polls = 0
      stubRpc((method) => {
        if (method === 'sendTransaction') return ok(signed.signature)
        polls += 1
        return polls === 1
          ? status({ confirmationStatus: 'processed', err: failed })
          : status({ confirmationStatus: 'confirmed', err: null })
      })
      await expect(submit()(input(signed.transaction))).resolves.toMatchObject({ ok: true })
    })

    it.each(['confirmed', 'finalized'])('believes a failure at %s', async (confirmationStatus) => {
      stubRpc((method) =>
        method === 'sendTransaction'
          ? ok(signed.signature)
          : status({ confirmationStatus, err: failed })
      )
      const result = await submit()(input(signed.transaction))
      expect(result).toEqual({
        ok: false,
        error: `This transaction landed but failed, so your tokens did not move. Network fees may still apply. Details: https://solscan.io/tx/${signed.signature}`,
      })
    })
  })

  describe('what the node answered to the send', () => {
    it.each([
      [
        'an instruction failing in simulation',
        {
          code: -32002,
          message: 'Transaction simulation failed',
          data: { err: { InstructionError: [1, { Custom: 6001 }] }, logs: [] },
        },
        'The network’s simulation of this transaction failed, so nothing was sent. Check your balance and build it again, since prices may have moved.',
      ],
      [
        'BlockhashNotFound',
        {
          code: -32002,
          message: 'Transaction simulation failed: Blockhash not found',
          data: { err: 'BlockhashNotFound', logs: [] },
        },
        'This transaction expired before it reached the network, so nothing moved. Build it again and sign right away.',
      ],
      [
        'a blockhash that is only named in the -32002 message',
        { code: -32002, message: 'Transaction simulation failed: Blockhash not found' },
        'This transaction expired before it reached the network, so nothing moved. Build it again and sign right away.',
      ],
      [
        'AccountNotFound',
        { code: -32002, message: 'simulation failed', data: { err: 'AccountNotFound', logs: [] } },
        'This wallet doesn’t have enough SOL to pay the network fee, so nothing was sent. Add a little SOL and try again.',
      ],
      [
        'InsufficientFundsForFee',
        {
          code: -32002,
          message: 'simulation failed',
          data: { err: 'InsufficientFundsForFee', logs: [] },
        },
        'This wallet doesn’t have enough SOL to pay the network fee, so nothing was sent. Add a little SOL and try again.',
      ],
      [
        'a balance error in the simulation logs',
        {
          code: -32002,
          message: 'Transaction simulation failed',
          data: {
            err: { InstructionError: [1, { Custom: 1 }] },
            logs: ['Program log: Error: insufficient funds'],
          },
        },
        'This wallet’s balance is too low for this transaction, so nothing was sent. Check your balance, including a little SOL for fees, and try again.',
      ],
    ])('keeps %s clean, as written', async (_name, error, wording) => {
      const { calls } = stubRpc(() => ({ error }))
      const result = await submit()(input(signed.transaction))
      expect(result).toEqual({ ok: false, error: wording })
      expect(calls).toHaveLength(1)
      expect(afterSubmitting(result, 'solana')).toMatchObject({ phase: 'failed', latched: false })
    })

    it.each([
      ['an internal error', { code: -32603, message: 'Internal error' }],
      ['a node that is behind', { code: -32005, message: 'Node is behind by 42 slots' }],
      ['a gateway error with no code', { message: 'Bad gateway' }],
      ['a gateway that mentions simulation', { code: -32603, message: 'Simulation timed out' }],
      ['a gateway that mentions the blockhash', { code: -32000, message: 'Blockhash not found' }],
      [
        'balance words outside a preflight failure',
        { code: -32603, message: 'x', data: { logs: ['insufficient funds'] } },
      ],
      [
        'a transaction that already landed',
        {
          code: -32002,
          message: 'Transaction simulation failed: This transaction has already been processed',
          data: { err: 'AlreadyProcessed', logs: [] },
        },
      ],
      [
        'an already processed message with no error name',
        {
          code: -32002,
          message: 'Transaction simulation failed: This transaction has already been processed',
        },
      ],
    ])('treats %s as unknown', async (_name, error) => {
      stubRpc(() => ({ error }))
      const result = await submit()(input(signed.transaction))
      expect(result).toMatchObject({
        ok: false,
        pending: true,
        error: expect.stringContaining(`https://solscan.io/tx/${signed.signature}`),
      })
      expect(JSON.stringify(result)).not.toMatch(/nothing was sent|nothing moved/)
      expect(afterSubmitting(result, 'solana')).toMatchObject({ phase: 'pending', latched: true })
    })

    it('does not read a refusal out of a non-2xx answer', async () => {
      vi.stubGlobal(
        'fetch',
        async () =>
          new Response(
            JSON.stringify({ error: { code: -32002, message: 'Transaction simulation failed' } }),
            { status: 502 }
          )
      )
      await expect(submit()(input(signed.transaction))).rejects.toThrow()
    })
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

  const EXPIRED_SWAP =
    'This swap expired before it landed, so nothing moved. Get a fresh quote and sign right away.'
  const UNREADABLE_SWAP =
    'Jupiter could not read this signed transaction, so nothing moved. Sign a fresh quote with the same wallet.'

  it.each([
    [-1, EXPIRED_SWAP],
    [-1004, EXPIRED_SWAP],
    [-1005, EXPIRED_SWAP],
    [-2003, EXPIRED_SWAP],
    [-2, UNREADABLE_SWAP],
    [-3, UNREADABLE_SWAP],
    [-1002, UNREADABLE_SWAP],
    [-1003, UNREADABLE_SWAP],
    [-2002, UNREADABLE_SWAP],
  ])('keeps execute code %i clean, as written', async (code, wording) => {
    answering({ status: 'Failed', code, error: 'upstream text' })
    const result = await venue.submit?.(executeInput)
    expect(result).toEqual({ ok: false, error: wording })
    expect(afterSubmitting(result, 'solana')).toMatchObject({ phase: 'failed', latched: false })
  })

  it.each([
    ['-1000, which only says it failed to land', { status: 'Failed', code: -1000 }],
    ['-2000, which only says it failed to land', { status: 'Failed', code: -2000 }],
    ['an unknown code', { status: 'Failed', code: -9999, error: 'upstream text' }],
    ['a failure with no code', { status: 'Failed' }],
    ['Success with no signature', { status: 'Success', code: 0 }],
    ['Success with a clean code and no signature', { status: 'Success', code: -1 }],
    ['a status it has never used', { status: 'Processing', code: -1 }],
    ['a clean code with no status on a 200', { code: -1 }],
    ['an unreadable body on a 200', 'not an execute reply'],
  ])('treats %s as unknown', async (_name, body) => {
    answering(body)
    const result = await venue.submit?.(executeInput)
    expect(result).toMatchObject({
      ok: false,
      pending: true,
      error: expect.stringMatching(/don.t send it again/i),
    })
    expect(result).toMatchObject({ error: expect.stringMatching(/wallet.s activity/i) })
    expect(JSON.stringify(result)).not.toMatch(
      /did not go through|did not land|nothing moved|nothing was sent|upstream text/
    )
    expect(afterSubmitting(result, 'solana')).toMatchObject({ phase: 'pending', latched: true })
  })

  it.each([
    ['-1000', { status: 'Failed', code: -1000, signature: 'jupiter-signature' }, 200],
    ['an unknown code', { status: 'Failed', code: -9999, signature: 'jupiter-signature' }, 200],
    ['a non-2xx answer', { status: 'Success', signature: 'jupiter-signature' }, 400],
  ])('points at Jupiter’s signature for %s', async (_name, body, statusCode) => {
    answering(body, statusCode)
    const result = await venue.submit?.(executeInput)
    expect(result).toMatchObject({
      ok: false,
      pending: true,
      error: expect.stringContaining('https://solscan.io/tx/jupiter-signature'),
    })
    expect(result).toMatchObject({ error: expect.stringMatching(/don.t send it again/i) })
  })

  it.each([400, 401, 403, 404, 408, 409, 422])(
    'treats a %i with no known code as unknown',
    async (statusCode) => {
      answering({ error: 'bad' }, statusCode)
      const result = await venue.submit?.(executeInput)
      expect(result).toMatchObject({
        ok: false,
        pending: true,
        error: expect.stringMatching(/don.t send it again/i),
      })
      expect(JSON.stringify(result)).not.toContain('nothing was sent')
      expect(afterSubmitting(result, 'solana')).toMatchObject({ phase: 'pending', latched: true })
    }
  )

  it('treats a non-2xx with an unreadable body as unknown', async () => {
    vi.stubGlobal('fetch', async () => new Response('<html>Bad request</html>', { status: 400 }))
    await expect(venue.submit?.(executeInput)).resolves.toMatchObject({ ok: false, pending: true })
  })

  it.each([
    ['-1000', { status: 'Failed', code: -1000 }],
    ['an unknown code', { code: -9999 }],
    ['a clean code beside a Success status', { status: 'Success', code: -1 }],
  ])('treats a 400 carrying %s as unknown', async (_name, body) => {
    answering(body, 400)
    await expect(venue.submit?.(executeInput)).resolves.toMatchObject({ ok: false, pending: true })
  })

  it.each([
    ['with a Failed status', { status: 'Failed', code: -1005 }, EXPIRED_SWAP],
    ['with no status', { code: -2 }, UNREADABLE_SWAP],
  ])('believes a known clean code on a 400 %s', async (_name, body, wording) => {
    answering(body, 400)
    await expect(venue.submit?.(executeInput)).resolves.toEqual({ ok: false, error: wording })
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
