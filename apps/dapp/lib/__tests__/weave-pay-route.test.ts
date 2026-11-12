import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  mainnet: true,
  weave: {} as Record<string, unknown>,
  repo: {} as Record<string, unknown>,
  deposit: {} as Record<string, unknown>,
  report: [] as unknown[][],
  logged: [] as unknown[],
  notified: [] as unknown[][],
}))

vi.mock('@intent/config', async (original) => ({
  ...(await original<typeof import('@intent/config')>()),
  isMainnet: () => state.mainnet,
}))
vi.mock('../weave/client', async (original) => ({
  ...(await original<typeof import('../weave/client')>()),
  createWeaveClient: () => state.weave,
}))
vi.mock('../weave/orders', async (original) => ({
  ...(await original<typeof import('../weave/orders')>()),
  getWeaveOrderRepo: async () => state.repo,
}))
vi.mock('../weave/deposit', () => ({ depositChain: () => state.deposit }))
vi.mock('../linq/client', () => ({
  createLinqClient: () => ({
    getStatus: async () => ({ ok: true, value: { status: 'initiated', amountNGN: 0 } }),
  }),
}))
vi.mock('../chains/near/oneclick', () => ({
  notifyDeposit: async (...args: unknown[]) => {
    state.notified.push(args)
  },
}))
vi.mock('../server/rate-limit', () => ({ enforceRateLimit: async () => undefined }))
vi.mock('../server/report', () => ({
  reportError: (...args: unknown[]) => state.report.push(args),
}))
vi.mock('../server/analytics', () => ({
  logExecution: async (input: unknown) => {
    state.logged.push(input)
  },
}))

import { POST as build } from '../../app/api/cashout/orders/[id]/build/route'
import { maxDuration, POST as submit } from '../../app/api/cashout/orders/[id]/submit/route'
import { ChainActionRefused } from '../chains/types'
import { WALLET_HEADER } from '../wallet-header'

const ID = '3f7c1b2a-84e9-4c11-b3d2-0a9f7e123456'
const DIGITS = '254700001234'
const HOLDER = 'JANE ADEYEMI'
const MEMO = 'MEMO99'
const context = { params: Promise.resolve({ id: ID }) }

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ID,
    chain: 'solana',
    email: 'wallet:alice',
    account: 'alice',
    providerOrder: 'ord_1',
    idempotencyKey: 'key',
    currency: 'KES',
    institutionCode: 'MPESA',
    institutionName: 'M-Pesa',
    accountIdentifier: DIGITS,
    accountName: HOLDER,
    depositAddress: 'weaveDeposit',
    depositMemo: MEMO,
    amount: '25.5',
    estimatedDest: '3200.5',
    expiresAt: '2999-01-01T00:00:00.000Z',
    status: 'waiting',
    providerStatus: 'awaiting_deposit',
    depositHash: undefined,
    createdAt: '2026-11-04T11:00:00.000Z',
    ...over,
  }
}

const EXPECTATION = {
  account: 'alice',
  depositAddress: 'weaveDeposit',
  memo: MEMO,
  amount: '25.5',
}

function req(path: string, payload?: unknown): Request {
  return new Request(`http://localhost/api/cashout/orders/${ID}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [WALLET_HEADER]: 'alice.near' },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  })
}

const SIGNED = { family: 'solana', signedTransaction: 'c2lnbmVk' }
const SIGNING = { family: 'solana', transaction: 'dHg=' }

const fn = (value: unknown): ReturnType<typeof vi.fn> => value as ReturnType<typeof vi.fn>

function live(status: string): void {
  state.weave = {
    configured: true,
    getOrder: vi.fn(async () => ({ ok: true, value: { id: 'ord_1', status } })),
  }
}

function stored(over: Record<string, unknown> = {}): void {
  state.repo = {
    getForEmail: vi.fn(async () => row(over)),
    setStatus: vi.fn(async () => undefined),
    setDepositHash: vi.fn(async () => 'stored'),
    claimSend: vi.fn(async () => true),
    releaseSend: vi.fn(async () => undefined),
  }
}

beforeEach(() => {
  state.mainnet = true
  state.report = []
  state.logged = []
  state.notified = []
  live('awaiting_deposit')
  stored()
  state.deposit = {
    build: vi.fn(async () => SIGNING),
    assertSafe: vi.fn(),
    submit: vi.fn(async () => ({ ok: true, hash: 'hash1', explorerUrl: 'https://x/hash1' })),
  }
})

const refusals: [string, () => void, number][] = [
  ['now processing at Weave', () => live('processing'), 409],
  ['completed at Weave', () => live('completed'), 409],
  ['expired at Weave', () => live('expired'), 409],
  ['in a state Weave has not documented', () => live('settling'), 503],
  ['stored as already paid into', () => stored({ depositHash: 'earlier' }), 409],
  ['past its expiry', () => stored({ expiresAt: '2020-01-01T00:00:00.000Z' }), 409],
  ['stored as failed', () => stored({ status: 'failed', providerStatus: 'failed' }), 409],
  [
    'one Weave cannot be asked about',
    () => {
      state.weave = {
        configured: true,
        getOrder: vi.fn(async () => ({ ok: false, code: 'unavailable', message: 'x' })),
      }
    },
    503,
  ],
]

describe('POST build', () => {
  it('builds from the row alone and checks the payload before returning it', async () => {
    const res = await build(req('build', { amount: '9999', depositAddress: 'evil' }), context)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ signing: SIGNING })
    expect(fn(state.deposit['build'])).toHaveBeenCalledWith(EXPECTATION)
    expect(fn(state.deposit['assertSafe'])).toHaveBeenCalledWith(SIGNING, EXPECTATION)
  })

  it('reads the order scoped to this requester', async () => {
    await build(req('build'), context)
    expect(fn(state.repo['getForEmail'])).toHaveBeenCalledWith(ID, 'wallet:alice.near')
  })

  it("answers not found for a wrong id or somebody else's", async () => {
    state.repo = { getForEmail: vi.fn(async () => undefined) }
    expect((await build(req('build'), context)).status).toBe(404)
    expect(fn(state.deposit['build'])).not.toHaveBeenCalled()
  })

  it('refuses a Stellar order off mainnet', async () => {
    state.mainnet = false
    stored({ chain: 'stellar' })
    expect((await build(req('build'), context)).status).toBe(403)
    expect(fn(state.deposit['build'])).not.toHaveBeenCalled()
  })

  it.each(refusals)('refuses an order %s', async (_name, arrange, status) => {
    arrange()
    const res = await build(req('build'), context)
    expect(res.status).toBe(status)
    expect((await res.json()).message).toMatch(/\./)
    expect(fn(state.deposit['build'])).not.toHaveBeenCalled()
  })

  it('returns nothing to sign when the check on the payload refuses it', async () => {
    fn(state.deposit['assertSafe']).mockImplementation(() => {
      throw new ChainActionRefused('This transaction does something else.')
    })
    const res = await build(req('build'), context)
    expect(res.status).toBe(422)
    const json = await res.json()
    expect(json.signing).toBeUndefined()
    expect(json.message).toBe('This transaction does something else.')
  })

  it('says nothing was signed when the build fails, and reports no details', async () => {
    fn(state.deposit['build']).mockRejectedValue(new Error(`rpc ${MEMO} ${DIGITS} ${HOLDER}`))
    const res = await build(req('build'), context)
    expect(res.status).toBe(502)
    const text = JSON.stringify(await res.json())
    expect(text).toMatch(/nothing was signed or sent/i)
    expect(text).not.toContain(MEMO)
    const report = JSON.stringify(state.report.map((r) => [(r[1] as Error).message, r[2]]))
    expect(report).not.toMatch(new RegExp(`${MEMO}|${DIGITS}|${HOLDER}`))
  })
})

describe('POST submit', () => {
  it('sends against the row, stores the hash and logs an off-ramp', async () => {
    const res = await submit(req('submit', { signed: SIGNED, amount: '9999' }), context)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, hash: 'hash1', explorerUrl: 'https://x/hash1' })
    expect(fn(state.deposit['submit'])).toHaveBeenCalledWith(SIGNED, EXPECTATION)
    expect(fn(state.repo['setDepositHash'])).toHaveBeenCalledWith(ID, 'hash1')
    expect(state.logged[0]).toMatchObject({
      kind: 'offramp',
      account: 'alice',
      network: 'mainnet',
      feeSponsored: false,
    })
  })

  it('moves no status itself', async () => {
    await submit(req('submit', { signed: SIGNED }), context)
    expect(fn(state.repo['setStatus'])).not.toHaveBeenCalled()
  })

  it.each([
    ['nothing', undefined],
    ['an unknown family', { signed: { family: 'bitcoin', tx: 'x' } }],
    ['a solana payload with no bytes', { signed: { family: 'solana', signedTransaction: '' } }],
    ['a sui payload with no signature', { signed: { family: 'sui', transaction: 'x' } }],
  ])('refuses %s', async (_name, payload) => {
    expect((await submit(req('submit', payload), context)).status).toBe(400)
    expect(fn(state.deposit['submit'])).not.toHaveBeenCalled()
  })

  it.each([
    ['solana', { family: 'near', hashes: ['h'] }],
    ['near', { family: 'solana', signedTransaction: 'x' }],
    ['sui', { family: 'evm', hash: '0xabc' }],
    ['stellar', { family: 'solana', signedTransaction: 'x' }],
    ['avalanche', { family: 'stellar', signedXdr: 'x' }],
    ['avalanche', { family: 'avalanche', hash: '0xabc' }],
  ])('refuses a %s order signed by another family', async (chain, signed) => {
    stored({ chain })
    const res = await submit(req('submit', { signed }), context)
    expect(res.status).toBe(400)
    expect(fn(state.deposit['submit'])).not.toHaveBeenCalled()
  })

  it.each([
    ['stellar', { family: 'stellar', signedXdr: 'AAAA' }],
    ['solana', SIGNED],
    ['sui', { family: 'sui', transaction: 'x', signature: 'y' }],
    ['near', { family: 'near', hashes: ['h'] }],
    ['avalanche', { family: 'evm', hash: '0xabc' }],
  ])('accepts a %s order signed by its own family', async (chain, signed) => {
    stored({ chain })
    expect((await submit(req('submit', { signed }), context)).status).toBe(200)
    expect(fn(state.deposit['submit'])).toHaveBeenCalledWith(signed, EXPECTATION)
  })

  it('passes a Stellar envelope to the log, so its volume can be read', async () => {
    stored({ chain: 'stellar' })
    await submit(req('submit', { signed: { family: 'stellar', signedXdr: 'AAAA' } }), context)
    expect(state.logged[0]).toMatchObject({ signedXdr: 'AAAA' })
  })

  it.each(refusals)('refuses an order %s', async (_name, arrange, status) => {
    arrange()
    const res = await submit(req('submit', { signed: SIGNED }), context)
    expect(res.status).toBe(status)
    expect(fn(state.deposit['submit'])).not.toHaveBeenCalled()
    expect((await res.json()).error).toMatch(/nothing (more )?was sent/i)
  })

  it('does not claim nothing was sent when the wallet sends for itself', async () => {
    stored({ chain: 'near', depositHash: 'earlier' })
    const res = await submit(req('submit', { signed: { family: 'near', hashes: ['h'] } }), context)
    expect(res.status).toBe(409)
    const { error: message } = await res.json()
    expect(message).not.toMatch(/nothing (more )?was sent/i)
    expect(message).toMatch(/do not send it again/i)
  })

  it.each([
    ['near', { family: 'near', hashes: ['h'] }],
    ['avalanche', { family: 'evm', hash: '0xabc' }],
  ])(
    'records a %s transfer Weave has already seen, because the wallet has already sent it',
    async (chain, signed) => {
      stored({ chain })
      live('processing')
      const res = await submit(req('submit', { signed }), context)
      expect(res.status).toBe(200)
      expect(fn(state.repo['setDepositHash'])).toHaveBeenCalledWith(ID, 'hash1')
    }
  )

  describe('the send claim', () => {
    it('is taken before the chain is asked to send', async () => {
      const order: string[] = []
      fn(state.repo['claimSend']).mockImplementation(async () => {
        order.push('claim')
        return true
      })
      fn(state.deposit['submit']).mockImplementation(async () => {
        order.push('send')
        return { ok: true, hash: 'hash1', explorerUrl: 'https://x/hash1' }
      })
      await submit(req('submit', { signed: SIGNED }), context)
      expect(order).toEqual(['claim', 'send'])
    })

    it('stops a second send and says not to send again', async () => {
      fn(state.repo['claimSend']).mockResolvedValue(false)
      const res = await submit(req('submit', { signed: SIGNED }), context)
      expect(res.status).toBe(409)
      expect(fn(state.deposit['submit'])).not.toHaveBeenCalled()
      const json = await res.json()
      expect(json).toMatchObject({ ok: false, pending: true, code: 'send_started' })
      expect(json.error).toMatch(/do not send/i)
    })

    it('refuses to send when the claim cannot be recorded', async () => {
      fn(state.repo['claimSend']).mockRejectedValue(new Error('db down'))
      const res = await submit(req('submit', { signed: SIGNED }), context)
      expect(res.status).toBe(503)
      expect(fn(state.deposit['submit'])).not.toHaveBeenCalled()
      expect((await res.json()).error).toMatch(/nothing was sent/i)
    })

    it('still records a wallet-sent transfer when the claim cannot be recorded', async () => {
      stored({ chain: 'avalanche' })
      fn(state.repo['claimSend']).mockRejectedValue(new Error('db down'))
      const res = await submit(req('submit', { signed: { family: 'evm', hash: '0xabc' } }), context)
      expect(res.status).toBe(200)
      expect(fn(state.deposit['submit'])).toHaveBeenCalled()
    })

    it('is released when the network definitely refused the send', async () => {
      fn(state.deposit['submit']).mockResolvedValue({ ok: false, error: 'The network refused it.' })
      await submit(req('submit', { signed: SIGNED }), context)
      expect(fn(state.repo['releaseSend'])).toHaveBeenCalledWith(ID)
    })

    it('is released when the signed bytes were refused before sending', async () => {
      fn(state.deposit['submit']).mockRejectedValue(new ChainActionRefused('Wrong amount.'))
      await submit(req('submit', { signed: SIGNED }), context)
      expect(fn(state.repo['releaseSend'])).toHaveBeenCalledWith(ID)
    })

    it.each([
      ['a good send', async () => ({ ok: true, hash: 'hash1', explorerUrl: 'https://x/hash1' })],
      ['a pending send', async () => ({ ok: false, pending: true, error: 'Sent.' })],
      [
        'a send that threw',
        async () => {
          throw new Error('rpc died')
        },
      ],
    ])('is kept after %s, because the money may have moved', async (_name, outcome) => {
      fn(state.deposit['submit']).mockImplementation(outcome)
      await submit(req('submit', { signed: SIGNED }), context)
      expect(fn(state.repo['releaseSend'])).not.toHaveBeenCalled()
    })

    it("does not release another request's claim", async () => {
      fn(state.repo['claimSend']).mockResolvedValue(false)
      stored({ chain: 'avalanche' })
      fn(state.repo['claimSend']).mockResolvedValue(false)
      fn(state.deposit['submit']).mockResolvedValue({ ok: false, error: 'Not this deposit.' })
      await submit(req('submit', { signed: { family: 'evm', hash: '0xforged' } }), context)
      expect(fn(state.repo['releaseSend'])).not.toHaveBeenCalled()
    })

    it('is released when a wallet-sent hash was already counted elsewhere', async () => {
      stored({ chain: 'avalanche' })
      fn(state.repo['setDepositHash']).mockResolvedValue('reused')
      fn(state.deposit['submit']).mockResolvedValue({
        ok: true,
        hash: '0xold',
        explorerUrl: 'https://x/0xold',
      })
      await submit(req('submit', { signed: { family: 'evm', hash: '0xold' } }), context)
      expect(fn(state.repo['releaseSend'])).toHaveBeenCalledWith(ID)
    })

    it('stops a new deposit being built while a send is unresolved', async () => {
      stored({ sendStarted: true })
      const res = await build(req('build'), context)
      expect(res.status).toBe(409)
      expect(fn(state.deposit['build'])).not.toHaveBeenCalled()
      const { error, message } = await res.json()
      expect(error).toBe('send_started')
      expect(message).toMatch(/do not send/i)
      expect(message).not.toMatch(/nothing (more )?was sent/i)
    })
  })

  it('allows the longest confirmation a chain can poll for', () => {
    expect(maxDuration).toBe(60)
  })

  it('refuses a second submit once a hash is stored, without calling the chain', async () => {
    stored({ chain: 'avalanche', depositHash: '0xabc' })
    const res = await submit(req('submit', { signed: { family: 'evm', hash: '0xabc' } }), context)
    expect(res.status).toBe(409)
    expect(fn(state.deposit['submit'])).not.toHaveBeenCalled()
    expect(fn(state.repo['setDepositHash'])).not.toHaveBeenCalled()
  })

  it('refuses a hash already counted, rather than answering that it paid this order', async () => {
    stored({ chain: 'avalanche' })
    fn(state.repo['setDepositHash']).mockResolvedValue('reused')
    fn(state.deposit['submit']).mockResolvedValue({
      ok: true,
      hash: '0xold',
      explorerUrl: 'https://x/0xold',
    })
    const res = await submit(req('submit', { signed: { family: 'evm', hash: '0xold' } }), context)
    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json).toMatchObject({ ok: false, code: 'hash_reused' })
    expect(json.hash).toBeUndefined()
    expect(json.error).toMatch(/do not send it again/i)
    expect(state.logged[0]).toMatchObject({ result: { ok: false, reason: 'hash_reused' } })
    expect(state.report).toHaveLength(1)
  })

  it('passes on the wording of a pending result, and moves no status', async () => {
    const error = "Your USDC deposit was sent (abc) but isn't confirmed yet. Don't send it again."
    fn(state.deposit['submit']).mockResolvedValue({ ok: false, error, pending: true })
    const res = await submit(req('submit', { signed: SIGNED }), context)
    expect(res.status).toBe(202)
    const json = await res.json()
    expect(json).toEqual({ ok: false, pending: true, error })
    expect(fn(state.repo['setStatus'])).not.toHaveBeenCalled()
    expect(fn(state.repo['setDepositHash'])).not.toHaveBeenCalled()
    expect(state.logged[0]).toMatchObject({ result: { reason: 'pending' } })
  })

  it('stores the hash of a pending transfer when there is one', async () => {
    fn(state.deposit['submit']).mockResolvedValue({
      ok: false,
      error: 'Sent.',
      pending: true,
      hash: 'hash2',
    })
    const res = await submit(req('submit', { signed: SIGNED }), context)
    expect(res.status).toBe(202)
    expect(fn(state.repo['setDepositHash'])).toHaveBeenCalledWith(ID, 'hash2')
    expect((await res.json()).hash).toBe('hash2')
  })

  it('passes on a refusal from the network and stores nothing', async () => {
    fn(state.deposit['submit']).mockResolvedValue({ ok: false, error: 'The network refused it.' })
    const res = await submit(req('submit', { signed: SIGNED }), context)
    expect(res.status).toBe(422)
    expect((await res.json()).error).toBe('The network refused it.')
    expect(fn(state.repo['setDepositHash'])).not.toHaveBeenCalled()
  })

  it('says a check that refused the bytes before sending', async () => {
    fn(state.deposit['submit']).mockRejectedValue(new ChainActionRefused('Wrong amount.'))
    const res = await submit(req('submit', { signed: SIGNED }), context)
    expect(res.status).toBe(422)
    expect((await res.json()).error).toBe('Wrong amount.')
  })

  it('says to check the wallet when sending throws, because the outcome is unknown', async () => {
    fn(state.deposit['submit']).mockRejectedValue(new Error(`rpc died ${MEMO} ${DIGITS} ${HOLDER}`))
    const res = await submit(req('submit', { signed: SIGNED }), context)
    expect(res.status).toBe(502)
    const answer = await res.json()
    const text = JSON.stringify(answer)
    expect(text).toMatch(/check your wallet/i)
    expect(text).not.toContain('rpc died')
    expect(answer).toMatchObject({ ok: false, pending: true })
    const report = JSON.stringify(state.report.map((r) => [(r[1] as Error).message, r[2]]))
    expect(report).toContain('rpc died')
    expect(report).not.toMatch(new RegExp(`${MEMO}|${DIGITS}|${HOLDER}`))
  })

  it('still reports success when the transfer landed and only the record failed', async () => {
    stored()
    fn(state.repo['setDepositHash']).mockRejectedValue(new Error('db down'))
    const res = await submit(req('submit', { signed: SIGNED }), context)
    expect(res.status).toBe(200)
    expect((await res.json()).hash).toBe('hash1')
    expect(state.report).toHaveLength(1)
  })
})

describe('telling NEAR Intents the deposit has landed', () => {
  it.each([
    ['solana', SIGNED],
    ['sui', { family: 'sui', transaction: 'dHg=', signature: 'c2ln' }],
    ['avalanche', { family: 'evm', hash: '0xabc' }],
  ] as const)(
    'passes a confirmed %s deposit on, so its bridge need not find it',
    async (chain, signed) => {
      stored({ chain })
      const res = await submit(req('submit', { signed }), context)
      expect(res.status).toBe(200)
      expect(state.notified).toEqual([['weaveDeposit', 'hash1']])
    }
  )

  it('names the sending account on NEAR', async () => {
    stored({ chain: 'near' })
    await submit(req('submit', { signed: { family: 'near', hashes: ['h1'] } }), context)
    expect(state.notified).toEqual([['weaveDeposit', 'hash1', 'alice']])
  })

  it("leaves Stellar alone, because Weave's Stellar flow does not bridge through NEAR Intents", async () => {
    stored({ chain: 'stellar' })
    await submit(req('submit', { signed: { family: 'stellar', signedXdr: 'AAAA' } }), context)
    expect(state.notified).toEqual([])
  })

  it('leaves a Linq order alone', async () => {
    stored({ chain: 'sui', provider: 'linq' })
    const res = await submit(
      req('submit', { signed: { family: 'sui', transaction: 'dHg=', signature: 'c2ln' } }),
      context
    )
    expect(res.status).toBe(200)
    expect(state.notified).toEqual([])
  })

  it('says nothing for a transfer not yet confirmed', async () => {
    state.deposit['submit'] = vi.fn(async () => ({
      ok: false,
      pending: true,
      hash: 'hash1',
      error: 'x',
    }))
    await submit(req('submit', { signed: SIGNED }), context)
    expect(state.notified).toEqual([])
  })

  it('says nothing for a hash already counted', async () => {
    state.repo['setDepositHash'] = vi.fn(async () => 'reused')
    await submit(req('submit', { signed: SIGNED }), context)
    expect(state.notified).toEqual([])
  })
})
