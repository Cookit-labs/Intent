import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  mainnet: true,
  weave: {} as Record<string, unknown>,
  repo: {} as Record<string, unknown>,
  deposit: {} as Record<string, unknown>,
  report: [] as unknown[][],
  session: undefined as { email: string } | undefined,
  linq: undefined as Record<string, unknown> | undefined,
}))

vi.mock('../server/session', () => ({ readSessionFromRequest: () => state.session }))
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
vi.mock('../linq/client', async (original) => {
  const actual = await original<typeof import('../linq/client')>()
  return { ...actual, createLinqClient: () => state.linq ?? actual.createLinqClient() }
})
vi.mock('../server/rate-limit', () => ({ enforceRateLimit: async () => undefined }))
vi.mock('../server/report', () => ({
  reportError: (...args: unknown[]) => state.report.push(args),
}))

import { POST } from '../../app/api/cashout/orders/route'
import { WALLET_HEADER } from '../wallet-header'

const KEY = '3f7c1b2a-84e9-4c11-b3d2-0a9f7e123456'
const DIGITS = '254700001234'
const HOLDER = 'JANE ADEYEMI'
const REQUESTER = 'wallet:alice.near'

const body = {
  chain: 'sui',
  account: 'alice.near',
  amount: '25.5',
  currency: 'KES',
  institution: 'MPESA',
  accountIdentifier: DIGITS,
  idempotencyKey: KEY,
}

function post(over: Record<string, unknown> = {}, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/cashout/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [WALLET_HEADER]: 'alice.near', ...headers },
    body: JSON.stringify({ ...body, ...over }),
  })
}

const placed = {
  id: 'ord_1',
  status: 'awaiting_deposit',
  sourceAssetKey: 'crypto:SUI:USDC',
  destAssetKey: 'fiat:KES',
  deposit: {
    address: 'weave.near',
    memo: undefined,
    amount: '25.5',
    token: 'USDC',
    chain: 'SUI',
    expiresAt: '2026-11-04T13:00:00.000Z',
  },
}

function weave(
  over: Record<string, unknown> = {}
): Record<string, ReturnType<typeof vi.fn> | boolean> {
  return {
    configured: true,
    institutions: vi.fn(async () => ({
      ok: true,
      value: [{ name: 'M-Pesa', code: 'MPESA', type: 'mobile_money' }],
    })),
    verifyAccount: vi.fn(async () => ({ ok: true, value: { accountName: HOLDER } })),
    quote: vi.fn(async () => ({
      ok: true,
      value: { destAmount: 3200.5, netUsd: 25, seconds: 90 },
    })),
    createOrder: vi.fn(async () => ({ ok: true, value: placed })),
    getOrder: vi.fn(),
    ...over,
  } as Record<string, ReturnType<typeof vi.fn> | boolean>
}

function repo(over: Record<string, unknown> = {}): Record<string, ReturnType<typeof vi.fn>> {
  return {
    getByIdempotencyKey: vi.fn(async () => undefined),
    hasUnconfirmedSend: vi.fn(async () => false),
    findHolder: vi.fn(async () => undefined),
    insert: vi.fn(async () => undefined),
    ...over,
  } as Record<string, ReturnType<typeof vi.fn>>
}

const called = (fn: unknown): ReturnType<typeof vi.fn> => fn as ReturnType<typeof vi.fn>

beforeEach(() => {
  state.mainnet = true
  state.report = []
  state.session = undefined
  state.weave = weave()
  state.repo = repo()
  state.linq = undefined
  state.deposit = {
    usdcDecimals: 6,
    supportsMemo: false,
    isAccount: (a: string) => a.endsWith('.near'),
    isDepositAddress: (a: string) => a.endsWith('.near'),
    // Far more than any test asks for, so the amount is never fitted unless a test says so.
    usdcBalance: vi.fn(async () => BigInt('1000000000000')),
  }
  vi.stubEnv('WEAVE_CASHOUT_CURRENCIES', 'NGN,KES')
})

describe('checks before anything is asked of Weave', () => {
  async function refused(request: Request, status: number): Promise<Record<string, unknown>> {
    const res = await POST(request)
    expect(res.status).toBe(status)
    expect(called(state.weave['createOrder'])).not.toHaveBeenCalled()
    expect(called(state.repo['insert'])).not.toHaveBeenCalled()
    return (await res.json()) as Record<string, unknown>
  }

  it('needs a requester', async () => {
    await refused(
      new Request('http://localhost/api/cashout/orders', { method: 'POST', body: '{}' }),
      401
    )
  })

  it('needs a configured client', async () => {
    state.weave = weave({ configured: false })
    await refused(post(), 503)
  })

  it.each([
    ['an unknown chain', { chain: 'ethereum' }],
    ['an amount with too many places', { amount: '1.1234567' }],
    ['an amount that is not decimal text', { amount: 25 }],
    ['a zero amount', { amount: '0' }],
    ['an account that is not on the chain', { account: 'alice.sol' }],
    ['a currency that is not live', { currency: 'UGX' }],
    ['an unknown currency', { currency: 'BRL' }],
    ['a key that is not a uuid', { idempotencyKey: 'x' }],
    ['a malformed account identifier', { accountIdentifier: '12 34;' }],
  ])('refuses %s', async (_name, over) => {
    await refused(post(over), 400)
  })

  it('refuses Stellar naira, which stays on the Linq flow', async () => {
    await refused(post({ chain: 'stellar', currency: 'NGN' }), 400)
  })

  it('makes an order from NEAR, which Weave takes since 12 November 2026', async () => {
    const fromNear = {
      ...placed,
      sourceAssetKey: 'crypto:NEAR:USDC',
      deposit: { ...placed.deposit, chain: 'NEAR' },
    }
    state.weave = weave({ createOrder: vi.fn(async () => ({ ok: true, value: fromNear })) })
    const res = await POST(post({ chain: 'near' }))
    expect(res.status).toBe(200)
    expect(called(state.weave['createOrder']).mock.calls[0]?.[0].chain).toBe('near')
  })

  it('refuses a Stellar cash-out off mainnet', async () => {
    state.mainnet = false
    await refused(post({ chain: 'stellar', currency: 'KES' }), 403)
  })

  it('still serves other chains when the page is on Stellar testnet', async () => {
    state.mainnet = false
    expect((await POST(post())).status).toBe(200)
  })

  it('refuses a body that is not JSON', async () => {
    await refused(
      new Request('http://localhost/api/cashout/orders', {
        method: 'POST',
        headers: { [WALLET_HEADER]: 'alice.near' },
        body: 'nope',
      }),
      400
    )
  })

  it('refuses an institution Weave does not list for the currency', async () => {
    await refused(post({ institution: 'OTHER' }), 400)
  })
})

describe('a retry of the same attempt', () => {
  const existing = {
    id: KEY,
    chain: 'sui',
    status: 'waiting',
    providerStatus: 'awaiting_deposit',
    accountIdentifier: DIGITS,
    accountName: HOLDER,
    depositHash: undefined,
    expiresAt: undefined,
    amount: '25.5',
    depositAddress: 'weave.near',
  }

  it('stores and shows what Weave needs to receive, when it runs a little over', async () => {
    state.weave = weave({
      createOrder: vi.fn(async () => ({
        ok: true,
        value: { ...placed, deposit: { ...placed.deposit, amount: '25.77' } },
      })),
    })
    const res = await POST(post())
    expect(res.status).toBe(200)
    expect((await res.json()).order.amount).toBe('25.77')
    expect(called(state.repo['insert']).mock.calls[0]?.[0].amount).toBe('25.77')
  })

  it('refuses a new order while an earlier deposit from this wallet is unconfirmed', async () => {
    state.repo = repo({ hasUnconfirmedSend: vi.fn(async () => true) })
    const res = await POST(post())
    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json.error).toBe('send_unconfirmed')
    expect(json.message).toMatch(/not confirmed/i)
    expect(state.repo['insert']).not.toHaveBeenCalled()
  })

  it('returns the order already made, scoped to this requester', async () => {
    state.repo = repo({ getByIdempotencyKey: vi.fn(async () => existing) })
    const res = await POST(post())
    expect(res.status).toBe(200)
    expect((await res.json()).order.depositAddress).toBe('weave.near')
    expect(called(state.repo['getByIdempotencyKey'])).toHaveBeenCalledWith(KEY, REQUESTER)
    expect(called(state.weave['createOrder'])).not.toHaveBeenCalled()
    expect(called(state.weave['quote'])).not.toHaveBeenCalled()
  })

  it('says an order that ended unpaid is closed, rather than handing it back', async () => {
    state.repo = repo({
      getByIdempotencyKey: vi.fn(async () => ({ ...existing, status: 'expired' })),
    })
    const res = await POST(post())
    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json.error).toBe('order_closed')
    expect(JSON.stringify(json)).not.toContain('weave.near')
  })

  it('says an order past its expiry is closed', async () => {
    state.repo = repo({
      getByIdempotencyKey: vi.fn(async () => ({
        ...existing,
        expiresAt: '2020-01-01T00:00:00.000Z',
      })),
    })
    expect((await POST(post())).status).toBe(409)
  })
})

describe('the size of a cash-out', () => {
  it('has no dollar limit of its own', async () => {
    called(state.weave['quote']).mockResolvedValueOnce({
      ok: true,
      value: { destAmount: 1, netUsd: 50_000, seconds: 1 },
    })
    called(state.weave['createOrder']).mockResolvedValueOnce({
      ok: true,
      value: { ...placed, deposit: { ...placed.deposit, amount: '50000' } },
    })
    expect((await POST(post({ amount: '50000' }))).status).toBe(200)
  })
})

describe('an amount near the whole balance', () => {
  it('is asked of Weave as the balance less its fee room, so the one order can be paid', async () => {
    state.deposit = { ...state.deposit, usdcBalance: vi.fn(async () => BigInt('25500000')) }
    await POST(post())
    expect(called(state.weave['createOrder']).mock.calls[0]?.[0].amount).toBe('25.217606')
  })

  it('is asked whole on Stellar, whose flow takes exactly the amount asked', async () => {
    // Weave's Stellar flow of 12 November 2026 answered 5 asked with a deposit of exactly 5.
    state.deposit = {
      ...state.deposit,
      usdcDecimals: 7,
      usdcBalance: vi.fn(async () => BigInt('255000000')),
    }
    await POST(post({ chain: 'stellar', account: 'alice.near' }))
    expect(called(state.weave['createOrder']).mock.calls[0]?.[0].amount).toBe('25.5')
  })

  it('is asked as it was when the deposit already fits', async () => {
    state.deposit = { ...state.deposit, usdcBalance: vi.fn(async () => BigInt('30000000')) }
    await POST(post())
    expect(called(state.weave['createOrder']).mock.calls[0]?.[0].amount).toBe('25.5')
  })

  it('is asked as it was when the balance could not be read', async () => {
    state.deposit = {
      ...state.deposit,
      usdcBalance: vi.fn(async () => {
        throw new Error('rpc down')
      }),
    }
    await POST(post())
    expect(called(state.weave['createOrder']).mock.calls[0]?.[0].amount).toBe('25.5')
  })
})

describe('the holder', () => {
  it('comes from the server lookup and never from the browser', async () => {
    await POST(post({ accountName: 'SOMEONE ELSE', bankAccountName: 'SOMEONE ELSE' }))
    expect(called(state.weave['verifyAccount'])).toHaveBeenCalledWith({
      institution: 'MPESA',
      accountIdentifier: DIGITS,
      currency: 'KES',
    })
    expect(called(state.weave['createOrder']).mock.calls[0]?.[0].accountName).toBe(HOLDER)
    expect(called(state.repo['insert']).mock.calls[0]?.[0].accountName).toBe(HOLDER)
  })

  it("can come from this requester's earlier order to the same account", async () => {
    state.repo = repo({ findHolder: vi.fn(async () => 'JANE FROM BEFORE') })
    await POST(post())
    expect(called(state.repo['findHolder'])).toHaveBeenCalledWith(REQUESTER, 'KES', 'MPESA', DIGITS)
    expect(called(state.weave['verifyAccount'])).not.toHaveBeenCalled()
    expect(called(state.weave['createOrder']).mock.calls[0]?.[0].accountName).toBe(
      'JANE FROM BEFORE'
    )
  })

  it('asks Weave when the record cannot be read', async () => {
    state.repo = repo({
      findHolder: vi.fn(async () => {
        throw new Error('db down')
      }),
    })
    expect((await POST(post())).status).toBe(200)
    expect(called(state.weave['verifyAccount'])).toHaveBeenCalled()
  })

  it('makes no order for an account that cannot be verified', async () => {
    state.weave = weave({
      verifyAccount: vi.fn(async () => ({ ok: false, code: 'rejected', message: 'No.' })),
    })
    const res = await POST(post())
    expect(res.status).toBe(422)
    expect(called(state.weave['createOrder'])).not.toHaveBeenCalled()
  })
})

describe('the quote', () => {
  const netUsd = (value: number) =>
    vi.fn(async () => ({ ok: true, value: { destAmount: 100, netUsd: value, seconds: 1 } }))

  it('refuses a cost above five percent worked out from netUsd', async () => {
    state.weave = weave({ quote: netUsd(24.2) })
    const res = await POST(post())
    expect(res.status).toBe(422)
    const { message } = await res.json()
    expect(message).toMatch(/5%/)
    expect(called(state.weave['createOrder'])).not.toHaveBeenCalled()
  })

  it('allows a cost of exactly five percent', async () => {
    state.weave = weave({
      quote: netUsd(95),
      createOrder: vi.fn(async () => ({
        ok: true,
        value: { ...placed, deposit: { ...placed.deposit, amount: '100' } },
      })),
    })
    expect((await POST(post({ amount: '100' }))).status).toBe(200)
  })

  it('refuses just above five percent', async () => {
    state.weave = weave({ quote: netUsd(94.99) })
    expect((await POST(post({ amount: '100' }))).status).toBe(422)
  })

  it('makes no order without a quote', async () => {
    state.weave = weave({
      quote: vi.fn(async () => ({ ok: false, code: 'rejected', message: 'No price.' })),
    })
    const res = await POST(post())
    expect(res.status).toBe(422)
    expect((await res.json()).message).toBe('No price.')
    expect(called(state.weave['createOrder'])).not.toHaveBeenCalled()
  })
})

describe('checking the answer against what was asked', () => {
  const answering = (deposit: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    state.weave = weave({
      createOrder: vi.fn(async () => ({
        ok: true,
        value: { ...placed, ...extra, deposit: { ...placed.deposit, ...deposit } },
      })),
    })
  }

  it.each([
    ['chain', { chain: 'SOLANA' }, {}],
    ['token', { token: 'USDT' }, {}],
    ['amount', { amount: '26.1' }, {}],
    ['address', { address: 'evil.sol' }, {}],
    ['memo', { memo: 'M1' }, {}],
    ['dest_asset', {}, { destAssetKey: 'fiat:NGN' }],
  ])('stores and returns nothing on a wrong %s', async (field, deposit, extra) => {
    answering(deposit, extra)
    const res = await POST(post())
    expect(res.status).toBe(502)
    const json = await res.json()
    expect(json.message).toMatch(/nothing was signed or sent/i)
    expect(JSON.stringify(json)).not.toMatch(/weave\.near|evil\.sol|M1/)
    expect(called(state.repo['insert'])).not.toHaveBeenCalled()

    expect(state.report).toHaveLength(1)
    const report = JSON.stringify(state.report[0])
    expect(report).toContain(field)
    expect(report).not.toContain(DIGITS)
    expect(report).not.toContain(HOLDER)
    expect(report).not.toContain('M1')
  })

  it('accepts a memo on a chain that can carry one, and stores it', async () => {
    state.deposit = { ...state.deposit, supportsMemo: true }
    answering({ memo: 'M1' })
    const res = await POST(post())
    expect(res.status).toBe(200)
    expect(called(state.repo['insert']).mock.calls[0]?.[0].depositMemo).toBe('M1')
    expect((await res.json()).order.depositMemo).toBe('M1')
  })

  it('stores an empty memo as no memo', async () => {
    answering({ memo: '' })
    expect((await POST(post())).status).toBe(200)
    expect(called(state.repo['insert']).mock.calls[0]?.[0].depositMemo).toBeUndefined()
  })

  it('accepts lower-case names and an amount written differently', async () => {
    answering({ chain: 'sui', token: 'usdc', amount: '25.5000000' })
    expect((await POST(post())).status).toBe(200)
  })
})

describe('what Weave could not answer', () => {
  it('answers a duplicate reference with no local row without making a second', async () => {
    state.weave = weave({
      createOrder: vi.fn(async () => ({
        ok: false,
        code: 'duplicate',
        message: 'This attempt could not be confirmed. Review it again to start a new one.',
      })),
    })
    const res = await POST(post())
    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json.error).toBe('order_closed')
    expect(json.message).toMatch(/could not be confirmed/)
    expect(called(state.weave['createOrder'])).toHaveBeenCalledTimes(1)
    expect(called(state.repo['insert'])).not.toHaveBeenCalled()
  })

  it('says an unknown outcome is unknown', async () => {
    state.weave = weave({
      createOrder: vi.fn(async () => ({ ok: false, code: 'unknown', message: 'No clear answer.' })),
    })
    const res = await POST(post())
    expect(res.status).toBe(504)
    expect(called(state.repo['insert'])).not.toHaveBeenCalled()
  })

  it("reports Weave's reason for a refusal, and keeps it from the browser", async () => {
    state.weave = weave({
      createOrder: vi.fn(async () => ({
        ok: false,
        code: 'rejected',
        message: 'The cash-out could not be started. Nothing was signed or sent.',
        detail: 'NEAR Intents 400: tokenIn is not valid',
      })),
    })
    const res = await POST(post())
    expect(res.status).toBe(422)
    expect(JSON.stringify(await res.json())).not.toContain('tokenIn')
    expect(state.report).toHaveLength(1)
    expect(JSON.stringify(state.report[0])).toContain('tokenIn is not valid')
  })

  it('names the order Weave made when its answer could not be used', async () => {
    state.weave = weave({
      createOrder: vi.fn(async () => ({
        ok: false,
        code: 'unexpected',
        message: 'Unreadable.',
        detail: 'order ord_9 awaiting_deposit with no deposit instruction',
      })),
    })
    expect((await POST(post())).status).toBe(502)
    expect(JSON.stringify(state.report[0])).toContain('ord_9')
  })

  it('reports an answer it could not read, with no account details', async () => {
    state.weave = weave({
      createOrder: vi.fn(async () => ({ ok: false, code: 'unexpected', message: 'Unreadable.' })),
    })
    expect((await POST(post())).status).toBe(502)
    expect(state.report).toHaveLength(1)
    expect(JSON.stringify(state.report[0])).not.toContain(DIGITS)
  })
})

describe('a good order', () => {
  it('sends the request to Weave with the wallet as refund address', async () => {
    await POST(post())
    expect(called(state.weave['createOrder'])).toHaveBeenCalledWith({
      chain: 'sui',
      currency: 'KES',
      amount: '25.5',
      account: 'alice.near',
      institutionCode: 'MPESA',
      accountIdentifier: DIGITS,
      accountName: HOLDER,
      reference: KEY,
      customer: { externalId: REQUESTER },
    })
  })

  it('tells Weave the email when there is a real one', async () => {
    state.session = { email: 'user@example.com' }
    await POST(post())
    expect(called(state.weave['createOrder']).mock.calls[0]?.[0].customer).toEqual({
      email: 'user@example.com',
    })
  })

  it('stores the row from what was asked and answered', async () => {
    await POST(post())
    expect(called(state.repo['insert']).mock.calls[0]?.[0]).toMatchObject({
      chain: 'sui',
      email: REQUESTER,
      account: 'alice.near',
      providerOrder: 'ord_1',
      idempotencyKey: KEY,
      currency: 'KES',
      institutionCode: 'MPESA',
      institutionName: 'M-Pesa',
      accountIdentifier: DIGITS,
      accountName: HOLDER,
      depositAddress: 'weave.near',
      amount: '25.5',
      estimatedDest: '3200.5',
      expiresAt: '2026-11-04T13:00:00.000Z',
      status: 'waiting',
      providerStatus: 'awaiting_deposit',
    })
  })

  it('returns only the masked account', async () => {
    const res = await POST(post())
    expect(res.status).toBe(200)
    const text = JSON.stringify(await res.json())
    expect(text).not.toContain(DIGITS)
    expect(text).toContain('••••1234')
  })

  it('never hands out a deposit address it could not record', async () => {
    state.repo = repo({
      insert: vi.fn(async () => {
        throw new Error(`insert ${DIGITS} ${HOLDER} failed`)
      }),
    })
    const res = await POST(post())
    expect(res.status).toBe(503)
    const json = await res.json()
    expect(JSON.stringify(json)).not.toContain('weave.near')
    expect(json.message).toMatch(/nothing was signed or sent/i)
    const report = JSON.stringify(
      state.report.map((r) => [r[0], String((r[1] as Error).message), r[2]])
    )
    expect(report).not.toContain(DIGITS)
    expect(report).not.toContain(HOLDER)
  })
})

describe('the naira limit, on every chain', () => {
  afterEach(() => vi.unstubAllEnvs())

  const naira = (destAmount: number) =>
    weave({
      quote: vi.fn(async () => ({ ok: true, value: { destAmount, netUsd: 25, seconds: 90 } })),
      createOrder: vi.fn(async () => ({
        ok: true,
        value: { ...placed, destAssetKey: 'fiat:NGN' },
      })),
    })

  it('refuses a naira payout over ₦2,000,000 before any order is made', async () => {
    state.weave = naira(2_000_001)
    const res = await POST(post({ currency: 'NGN' }))
    expect(res.status).toBe(422)
    const json = (await res.json()) as { error: string; message: string }
    expect(json.error).toBe('over_limit')
    expect(json.message).toMatch(/₦2,000,000/)
    expect(called(state.weave['createOrder'])).not.toHaveBeenCalled()
  })

  it('makes a naira payout of up to ₦2,000,000', async () => {
    state.weave = naira(2_000_000)
    expect((await POST(post({ currency: 'NGN' }))).status).toBe(200)
  })

  it('leaves payouts in other currencies alone', async () => {
    state.weave = weave({
      quote: vi.fn(async () => ({
        ok: true,
        value: { destAmount: 3_200_000, netUsd: 25, seconds: 90 },
      })),
    })
    expect((await POST(post({ currency: 'KES' }))).status).toBe(200)
  })

  it('takes NAIRA_MAX_NGN when it is set', async () => {
    vi.stubEnv('NAIRA_MAX_NGN', '5000000')
    state.weave = naira(3_000_000)
    expect((await POST(post({ currency: 'NGN' }))).status).toBe(200)
  })

  it('counts what Linq would pay, which can be more than Weave, before Linq makes an order', async () => {
    state.weave = naira(1_900_000)
    const linqOrder = vi.fn()
    state.linq = {
      configured: true,
      getRate: vi.fn(async () => ({ ok: true, value: { ngnPerUsd: 90_000 } })),
      verifyBank: vi.fn(),
      createOrder: linqOrder,
    }
    const res = await POST(post({ currency: 'NGN', chain: 'sui' }))
    expect(res.status).toBe(422)
    expect(linqOrder).not.toHaveBeenCalled()
    expect(called(state.weave['createOrder'])).not.toHaveBeenCalled()
  })
})
