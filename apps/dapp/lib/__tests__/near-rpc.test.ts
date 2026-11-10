import { afterEach, describe, expect, it, vi } from 'vitest'

import { followTransaction } from '../chains/near/rhea-read'
import { readNearBalances } from '../chains/near/balances'
import { spendableBalance, viewCall, waitForTransaction } from '../chains/near/rpc'

const FIRST = 'https://free.rpc.fastnear.com'
const SECOND = 'https://near.drpc.org'

function viewAnswer(value: unknown): Response {
  const bytes = Array.from(Buffer.from(JSON.stringify(value)))
  return new Response(JSON.stringify({ result: { result: bytes } }), { status: 200 })
}

/** Answers per address, and records the order the addresses were tried in. */
function network(answers: Record<string, () => Response | Promise<Response>>): string[] {
  const tried: string[] = []
  vi.stubGlobal('fetch', async (url: string) => {
    tried.push(url)
    const answer = answers[url]
    if (answer === undefined) throw new Error(`unexpected call to ${url}`)
    return answer()
  })
  return tried
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('reading NEAR when an RPC is busy', () => {
  it('asks the next RPC when the first is rate limited', async () => {
    const tried = network({
      [FIRST]: () => new Response('', { status: 429 }),
      [SECOND]: () => viewAnswer('42'),
    })
    await expect(viewCall<string>('wrap.near', 'ft_balance_of')).resolves.toBe('42')
    expect(tried).toEqual([FIRST, SECOND])
  })

  it('asks the next RPC when the first cannot be reached', async () => {
    const tried = network({
      [FIRST]: () => Promise.reject(new TypeError('fetch failed')),
      [SECOND]: () => viewAnswer('42'),
    })
    await expect(viewCall<string>('wrap.near', 'ft_balance_of')).resolves.toBe('42')
    expect(tried).toEqual([FIRST, SECOND])
  })

  it('stops at the first RPC that answers', async () => {
    const tried = network({ [FIRST]: () => viewAnswer('42') })
    await expect(viewCall<string>('wrap.near', 'ft_balance_of')).resolves.toBe('42')
    expect(tried).toEqual([FIRST])
  })

  it('takes a contract error as the answer, because every RPC would say the same', async () => {
    const tried = network({
      [FIRST]: () =>
        new Response(JSON.stringify({ error: { cause: { name: 'UNKNOWN_ACCOUNT' } } }), {
          status: 200,
        }),
    })
    await expect(viewCall('nobody.near', 'x')).rejects.toThrow('UNKNOWN_ACCOUNT')
    expect(tried).toEqual([FIRST])
  })

  it('tries a configured RPC first, then falls back to the public ones', async () => {
    vi.stubEnv('NEAR_RPC_URL', 'https://paid.example')
    const tried = network({
      'https://paid.example': () => new Response('', { status: 503 }),
      [FIRST]: () => new Response('', { status: 429 }),
      [SECOND]: () => viewAnswer('42'),
    })
    await expect(viewCall<string>('wrap.near', 'x')).resolves.toBe('42')
    expect(tried).toEqual(['https://paid.example', FIRST, SECOND])
  })

  it('does not ask a configured RPC twice when it is also a public one', async () => {
    vi.stubEnv('NEAR_RPC_URL', SECOND)
    const tried = network({
      [SECOND]: () => new Response('', { status: 429 }),
      [FIRST]: () => new Response('', { status: 429 }),
    })
    await expect(viewCall('wrap.near', 'x')).rejects.toThrow('rpc responded 429')
    expect(tried).toEqual([SECOND, FIRST])
  })

  it('says why when every RPC fails', async () => {
    network({
      [FIRST]: () => new Response('', { status: 429 }),
      [SECOND]: () => new Response('', { status: 502 }),
    })
    await expect(viewCall('wrap.near', 'x')).rejects.toThrow('rpc responded 502')
  })

  it('stops when the caller gave up, rather than trying the next RPC', async () => {
    const caller = new AbortController()
    const tried = network({
      [FIRST]: () => {
        caller.abort()
        return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      },
      [SECOND]: () => viewAnswer('42'),
    })
    await expect(viewCall('wrap.near', 'x', {}, caller.signal)).rejects.toThrow('aborted')
    expect(tried).toEqual([FIRST])
  })
})

describe('following a transaction when an RPC is busy', () => {
  it('reads the receipts from the next RPC, so a finished swap is not left unknown', async () => {
    const finished = {
      status: { SuccessValue: Buffer.from('"7"').toString('base64') },
      transaction: { signer_id: 'me.near', receiver_id: 'v2.ref-finance.near', actions: [] },
      receipts_outcome: [
        { outcome: { executor_id: 'v2.ref-finance.near', logs: ['swapped'], status: {} } },
      ],
    }
    let calls = 0
    network({
      // The status poll is answered, then the receipts read that follows it is refused.
      [FIRST]: () => {
        calls += 1
        return calls === 1
          ? new Response(JSON.stringify({ result: finished }), { status: 200 })
          : new Response('', { status: 429 })
      },
      [SECOND]: () => new Response(JSON.stringify({ result: finished }), { status: 200 }),
    })

    await expect(followTransaction('hash', 'me.near', 5_000)).resolves.toMatchObject({
      state: 'success',
      returned: '"7"',
      receipts: [{ executor: 'v2.ref-finance.near', logs: ['swapped'] }],
    })
  })
})

describe('what a finished transaction moved', () => {
  it('reads a Transfer, with its amount, and keeps it apart from contract calls', async () => {
    network({
      [FIRST]: () =>
        new Response(
          JSON.stringify({
            result: {
              status: { SuccessValue: '' },
              transaction: {
                signer_id: 'me.near',
                receiver_id: 'bob.near',
                actions: [{ Transfer: { deposit: '7' } }],
              },
            },
          }),
          { status: 200 }
        ),
    })
    await expect(waitForTransaction('hash', 'me.near', 5_000)).resolves.toEqual({
      state: 'success',
      signer: 'me.near',
      receiver: 'bob.near',
      calls: [],
      transfers: ['7'],
    })
  })

  it('reads a Transfer inside a delegate action, as a wallet that uses one sends it', async () => {
    network({
      [FIRST]: () =>
        new Response(
          JSON.stringify({
            result: {
              status: { SuccessValue: '' },
              transaction: {
                signer_id: 'relayer.near',
                receiver_id: 'me.near',
                actions: [
                  {
                    Delegate: {
                      delegate_action: {
                        sender_id: 'me.near',
                        receiver_id: 'bob.near',
                        actions: [{ NonDelegateAction: { Transfer: { deposit: '7' } } }],
                      },
                    },
                  },
                ],
              },
            },
          }),
          { status: 200 }
        ),
    })
    await expect(waitForTransaction('hash', 'me.near', 5_000)).resolves.toMatchObject({
      state: 'success',
      signer: 'me.near',
      receiver: 'bob.near',
      transfers: ['7'],
    })
  })
})

describe('an RPC that answers but is in trouble itself', () => {
  it.each(['TIMEOUT_ERROR', 'INTERNAL_ERROR', 'UNKNOWN_BLOCK'])(
    'asks the next RPC after %s, which says nothing about the chain',
    async (name) => {
      const tried = network({
        [FIRST]: () =>
          new Response(JSON.stringify({ error: { cause: { name } } }), { status: 200 }),
        [SECOND]: () => viewAnswer('42'),
      })
      await expect(viewCall<string>('wrap.near', 'x')).resolves.toBe('42')
      expect(tried).toEqual([FIRST, SECOND])
    }
  )

  it('moves on from an RPC that hangs, soon enough for a short read to still get an answer', async () => {
    vi.stubGlobal('fetch', (url: string, init: RequestInit) =>
      url === FIRST
        ? new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('timed out')))
          })
        : Promise.resolve(viewAnswer('42'))
    )
    const startedAt = Date.now()
    await expect(viewCall<string>('wrap.near', 'x')).resolves.toBe('42')
    expect(Date.now() - startedAt).toBeLessThan(3_000)
  })
})

describe('what NEAR an account can actually spend', () => {
  const account = (amount: string, locked: string, storage: number) => ({
    result: { amount, locked, storage_usage: storage },
  })
  const ONE = '1000000000000000000000000'

  it('holds back what its storage needs, at 1e19 yocto a byte', async () => {
    network({ [FIRST]: () => new Response(JSON.stringify(account(ONE, '0', 30_000))) })
    await expect(spendableBalance('me.near')).resolves.toBe('700000000000000000000000')
  })

  it('takes storage out of a staked amount first, because locked NEAR pays for it too', async () => {
    network({ [FIRST]: () => new Response(JSON.stringify(account(ONE, ONE, 30_000))) })
    await expect(spendableBalance('me.near')).resolves.toBe(ONE)
  })

  it('never reads below nothing', async () => {
    network({ [FIRST]: () => new Response(JSON.stringify(account('1', '0', 30_000))) })
    await expect(spendableBalance('me.near')).resolves.toBe('0')
  })

  it('is what the wallet balance shows, so every reserve check uses it', async () => {
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url.includes('api.fastnear.com')) return new Response(JSON.stringify({ tokens: [] }))
      const body = JSON.parse(String(init?.body)) as { params: { request_type: string } }
      return body.params.request_type === 'view_account'
        ? new Response(JSON.stringify(account(ONE, '0', 30_000)))
        : viewAnswer('0')
    })
    const read = await readNearBalances('me.near')
    expect(read.tokens.find((t) => t.native)?.amount).toBe('0.7')
  })
})
