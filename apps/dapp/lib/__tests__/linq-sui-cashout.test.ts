import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  weave: {} as Record<string, unknown>,
  linq: {} as Record<string, unknown>,
  repo: {} as Record<string, unknown>,
  deposit: {} as Record<string, unknown>,
  report: [] as unknown[][],
}))

vi.mock('../weave/client', async (original) => ({
  ...(await original<typeof import('../weave/client')>()),
  createWeaveClient: () => state.weave,
}))
vi.mock('../linq/client', async (original) => ({
  ...(await original<typeof import('../linq/client')>()),
  createLinqClient: () => state.linq,
}))
vi.mock('../weave/orders', async (original) => ({
  ...(await original<typeof import('../weave/orders')>()),
  getWeaveOrderRepo: async () => state.repo,
}))
vi.mock('../weave/deposit', () => ({ depositChain: () => state.deposit }))
vi.mock('../server/rate-limit', () => ({ enforceRateLimit: async () => undefined }))
vi.mock('../server/report', () => ({
  reportError: (...args: unknown[]) => state.report.push(args),
}))

import { POST } from '../../app/api/cashout/orders/route'
import { GET as quote } from '../../app/api/cashout/quote/route'
import { linqBank, placeWithLinq, sameHolder } from '../weave/linq-cashout'
import { syncOrder, type WeaveOrderRow } from '../weave/orders'
import { nextLinqStatus } from '../weave/status'
import { WALLET_HEADER } from '../wallet-header'

const KEY = '3f7c1b2a-84e9-4c11-b3d2-0a9f7e123456'
const WALLET = `0x${'2c'.repeat(32)}`
const LINQ_DEPOSIT = `0x${'ab'.repeat(32)}`
const SOLANA_WALLET = '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV'
const SOLANA_LINQ_DEPOSIT = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'
const DIGITS = '8100003682'
const HOLDER = 'JANE ADEYEMI'

const called = (fn: unknown): ReturnType<typeof vi.fn> => fn as ReturnType<typeof vi.fn>

const linqOrder = {
  id: 'lq_1',
  depositAddress: LINQ_DEPOSIT,
  coin: 'usdc',
  amountCoin: 1,
  amountNGN: 1368.39,
  rate: 1368.39,
  status: 'initiated',
}

function linq(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    configured: true,
    getRate: vi.fn(async () => ({ ok: true, value: { ngnPerUsd: 1368.39 } })),
    verifyBank: vi.fn(async () => ({
      ok: true,
      value: { accountName: 'Jane  Adeyemi', bankName: 'OPay' },
    })),
    createOrder: vi.fn(async () => ({ ok: true, value: linqOrder })),
    getStatus: vi.fn(),
    ...over,
  }
}

const weaveOrder = {
  id: 'wv_1',
  status: 'awaiting_deposit',
  sourceAssetKey: 'crypto:SUI:USDC',
  destAssetKey: 'fiat:NGN',
  deposit: {
    address: `0x${'cd'.repeat(32)}`,
    memo: undefined,
    amount: '1',
    token: 'USDC',
    chain: 'SUI',
    expiresAt: '2026-11-06T13:00:00.000Z',
  },
}

function weave(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    configured: true,
    institutions: vi.fn(async () => ({
      ok: true,
      value: [{ name: 'OPay', code: 'OPAYNGPC', type: 'bank' }],
    })),
    verifyAccount: vi.fn(async () => ({ ok: true, value: { accountName: HOLDER } })),
    quote: vi.fn(async () => ({
      ok: true,
      value: { destAmount: 1329.29, netUsd: 0.97, seconds: 90 },
    })),
    createOrder: vi.fn(async () => ({ ok: true, value: weaveOrder })),
    getOrder: vi.fn(),
    ...over,
  }
}

function post(over: Record<string, unknown> = {}): Request {
  return new Request('http://localhost/api/cashout/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [WALLET_HEADER]: WALLET },
    body: JSON.stringify({
      chain: 'sui',
      account: WALLET,
      amount: '1',
      currency: 'NGN',
      institution: 'OPAYNGPC',
      accountIdentifier: DIGITS,
      idempotencyKey: KEY,
      ...over,
    }),
  })
}

beforeEach(() => {
  state.report = []
  state.weave = weave()
  state.linq = linq()
  state.repo = {
    getByIdempotencyKey: vi.fn(async () => undefined),
    hasUnconfirmedSend: vi.fn(async () => false),
    findHolder: vi.fn(async () => undefined),
    insert: vi.fn(async () => undefined),
  }
  state.deposit = {
    usdcDecimals: 6,
    supportsMemo: false,
    isAccount: (a: string) => /^0x[0-9a-f]{64}$/.test(a),
    isDepositAddress: (a: string) => /^0x[0-9a-f]{64}$/.test(a),
  }
  vi.stubEnv('WEAVE_CASHOUT_CURRENCIES', 'NGN,KES')
})

describe('linqBank and sameHolder', () => {
  it("finds Linq's bank by the name Weave lists", () => {
    expect(linqBank('OPay')).toEqual({ code: '100004', name: 'OPay' })
    expect(linqBank('opay')?.code).toBe('100004')
    expect(linqBank('Not A Bank')).toBeUndefined()
  })

  it('takes two lookups of a name as one holder, ignoring case, spacing and word order', () => {
    expect(sameHolder('Jane  Adeyemi', HOLDER)).toBe(true)
    expect(sameHolder('ADEYEMI, JANE', HOLDER)).toBe(true)
    expect(sameHolder('JANE ADEYEMI OKAFOR', HOLDER)).toBe(false)
    expect(sameHolder('JANE ADEYEMIOKAFOR', HOLDER)).toBe(false)
    expect(sameHolder('', '')).toBe(false)
  })
})

describe('nextLinqStatus', () => {
  it('reads a deposit as processing only once one has been sent', () => {
    expect(nextLinqStatus('waiting', 'pending', false)).toBe('waiting')
    expect(nextLinqStatus('waiting', 'pending', true)).toBe('processing')
    expect(nextLinqStatus('waiting', 'initiated', false)).toBe('waiting')
  })

  it('moves to paid, failed or expired, and never back', () => {
    expect(nextLinqStatus('processing', 'disbursed', true)).toBe('paid')
    expect(nextLinqStatus('waiting', 'timeout', false)).toBe('expired')
    expect(nextLinqStatus('processing', 'failed: bank', true)).toBe('failed')
    expect(nextLinqStatus('paid', 'initiated', true)).toBe('paid')
    expect(nextLinqStatus('processing', 'initiated', true)).toBe('processing')
  })
})

describe('placeWithLinq', () => {
  const input = (over: Record<string, unknown> = {}) => ({
    linq: state.linq as never,
    chain: 'sui' as const,
    currency: 'NGN',
    amount: '1',
    weaveNaira: 1329.29,
    institutionName: 'OPay',
    accountIdentifier: DIGITS,
    accountName: HOLDER,
    refundAddress: WALLET,
    customerRef: `wallet:${WALLET}`,
    idempotencyKey: KEY,
    ...over,
  })

  it('places a Sui USDC order with the bank Linq knows, refunding to the wallet', async () => {
    expect(await placeWithLinq(input())).toEqual({ placed: linqOrder })
    expect(called(state.linq['createOrder'])).toHaveBeenCalledWith({
      chain: 'sui',
      coin: 'usdc',
      amountStableCoin: 1,
      bankCode: '100004',
      bankName: 'OPay',
      bankAccount: DIGITS,
      accountName: 'Jane  Adeyemi',
      refundAddress: WALLET,
      customerRef: `wallet:${WALLET}`,
      idempotencyKey: KEY,
    })
  })

  it('places it when Weave has no usable quote', async () => {
    expect(await placeWithLinq(input({ weaveNaira: undefined }))).toEqual({ placed: linqOrder })
  })

  it.each([
    ['another currency', { currency: 'KES' }, 'not_offered'],
    ['another chain', { chain: 'avalanche' }, 'not_offered'],
  ])('asks Linq nothing for %s', async (_name, over, reason) => {
    expect(await placeWithLinq(input(over))).toEqual({ skipped: reason })
    expect(called(state.linq['getRate'])).not.toHaveBeenCalled()
  })

  it('places a Solana USDC order on Solana, refunding to the Solana wallet', async () => {
    const placed = await placeWithLinq(
      input({ chain: 'solana', refundAddress: SOLANA_WALLET, customerRef: 'wallet:sol' })
    )
    expect(placed).toEqual({ placed: linqOrder })
    expect(called(state.linq['createOrder'])).toHaveBeenCalledWith(
      expect.objectContaining({ chain: 'solana', coin: 'usdc', refundAddress: SOLANA_WALLET })
    )
  })

  it('asks Linq nothing when it is not configured', async () => {
    state.linq = linq({ configured: false })
    expect(await placeWithLinq(input())).toEqual({ skipped: 'not_offered' })
  })

  it('places it with Linq even when Weave would pay more, because Linq locks its amount', async () => {
    expect(await placeWithLinq(input({ weaveNaira: 1400 }))).toEqual({ placed: linqOrder })
  })

  it('needs no rate from Linq to place the order, which locks its own', async () => {
    state.linq = linq({ getRate: vi.fn(async () => ({ ok: false, code: 'unavailable' })) })
    expect(await placeWithLinq(input())).toEqual({ placed: linqOrder })
  })

  it('makes no order for a bank Linq does not know, or a holder it names differently', async () => {
    expect(await placeWithLinq(input({ institutionName: 'Somewhere Else' }))).toEqual({
      skipped: 'no_bank',
    })
    expect(await placeWithLinq(input({ accountName: 'JOHN DOE' }))).toEqual({
      skipped: 'other_holder',
    })
    state.linq = linq({ verifyBank: vi.fn(async () => ({ ok: false, code: 'rejected' })) })
    expect(await placeWithLinq(input())).toEqual({ skipped: 'not_verified' })
    expect(called(state.linq['createOrder'])).not.toHaveBeenCalled()
  })

  it.each([
    ['rejected', 'order_refused'],
    ['unknown', 'order_unknown'],
    ['unexpected_order', 'order_unexpected'],
  ])('hands back to Weave when the order is %s', async (code, reason) => {
    state.linq = linq({ createOrder: vi.fn(async () => ({ ok: false, code, message: 'x' })) })
    expect(await placeWithLinq(input())).toEqual({ skipped: reason })
  })

  it('keeps what Linq locked even below Weave, and hands back only an order of nothing', async () => {
    state.linq = linq({
      createOrder: vi.fn(async () => ({ ok: true, value: { ...linqOrder, amountNGN: 1300 } })),
    })
    expect(await placeWithLinq(input())).toEqual({ placed: { ...linqOrder, amountNGN: 1300 } })
    state.linq = linq({
      createOrder: vi.fn(async () => ({ ok: true, value: { ...linqOrder, amountNGN: 0 } })),
    })
    expect(await placeWithLinq(input())).toEqual({ skipped: 'locked_nothing' })
  })
})

describe('POST order, naira from Sui', () => {
  it('places it with Linq when Linq pays more, and stores the naira Linq locked', async () => {
    const res = await POST(post())
    expect(res.status).toBe(200)
    const { order } = await res.json()
    expect(order).toMatchObject({
      depositAddress: LINQ_DEPOSIT,
      amount: '1',
      estimatedDest: '1368.39',
      status: 'waiting',
      accountMask: '••••3682',
    })
    expect(called(state.repo['insert']).mock.calls[0]?.[0]).toMatchObject({
      provider: 'linq',
      providerOrder: 'lq_1',
      institutionCode: 'OPAYNGPC',
      depositMemo: undefined,
      expiresAt: undefined,
    })
    expect(called(state.weave['createOrder'])).not.toHaveBeenCalled()
  })

  it('places it with Linq even when Weave would pay more', async () => {
    state.weave = weave({
      quote: vi.fn(async () => ({
        ok: true,
        value: { destAmount: 1400, netUsd: 0.99, seconds: 90 },
      })),
    })
    expect((await POST(post())).status).toBe(200)
    expect(called(state.weave['createOrder'])).not.toHaveBeenCalled()
    expect(called(state.repo['insert']).mock.calls[0]?.[0]).toMatchObject({ provider: 'linq' })
  })

  it.each([
    [
      'a bank Linq does not know',
      { institutions: [{ name: 'Somewhere MFB', code: 'OPAYNGPC', type: 'bank' }] },
      {},
      'linq_no_bank',
    ],
    [
      'a refused order',
      {},
      { createOrder: vi.fn(async () => ({ ok: false, code: 'rejected', message: 'x' })) },
      'linq_order_refused',
    ],
    [
      'a failed bank lookup',
      {},
      { verifyBank: vi.fn(async () => ({ ok: false, code: 'unavailable' })) },
      'linq_not_verified',
    ],
  ])('falls back to Weave on %s, and reports why', async (_name, weaveOver, linqOver, reason) => {
    const institutions = (weaveOver as { institutions?: unknown }).institutions
    if (institutions !== undefined) {
      state.weave = weave({ institutions: vi.fn(async () => ({ ok: true, value: institutions })) })
    }
    state.linq = linq(linqOver)
    expect((await POST(post())).status).toBe(200)
    expect(called(state.repo['insert']).mock.calls[0]?.[0]).toMatchObject({ provider: 'weave' })
    expect(state.report.map((r) => String(r[1]))).toContain(`Error: ${reason}`)
  })

  it('falls back to Weave, and reports it, when Linq answers with a different order', async () => {
    state.linq = linq({
      createOrder: vi.fn(async () => ({ ok: false, code: 'unexpected_order', message: 'x' })),
    })
    expect((await POST(post())).status).toBe(200)
    expect(called(state.repo['insert']).mock.calls[0]?.[0]).toMatchObject({ provider: 'weave' })
    expect(state.report.map((r) => String(r[1]))).toContain('Error: linq_order_unexpected')
  })

  it('places it with Linq when Weave cannot quote, or would cost too much', async () => {
    state.weave = weave({
      quote: vi.fn(async () => ({ ok: false, code: 'unavailable', message: 'x' })),
    })
    expect((await POST(post())).status).toBe(200)
    expect(called(state.repo['insert']).mock.calls[0]?.[0]).toMatchObject({ provider: 'linq' })

    state.repo['insert'] = vi.fn(async () => undefined)
    state.weave = weave({
      quote: vi.fn(async () => ({
        ok: true,
        value: { destAmount: 1500, netUsd: 0.5, seconds: 90 },
      })),
    })
    expect((await POST(post())).status).toBe(200)
    expect(called(state.repo['insert']).mock.calls[0]?.[0]).toMatchObject({ provider: 'linq' })
  })

  it('still refuses when neither can pay', async () => {
    state.weave = weave({
      quote: vi.fn(async () => ({ ok: false, code: 'unavailable', message: 'x' })),
    })
    state.linq = linq({
      createOrder: vi.fn(async () => ({ ok: false, code: 'unavailable', message: 'x' })),
    })
    expect((await POST(post())).status).toBe(503)
    expect(called(state.repo['insert'])).not.toHaveBeenCalled()
  })

  it('keeps every other chain and currency with Weave, asking Linq nothing', async () => {
    expect((await POST(post({ currency: 'KES', institution: 'OPAYNGPC' }))).status).not.toBe(500)
    expect(called(state.linq['getRate'])).not.toHaveBeenCalled()
    expect(called(state.linq['createOrder'])).not.toHaveBeenCalled()
  })
})

describe('POST order, naira from Solana', () => {
  const postFromSolana = (): Request =>
    new Request('http://localhost/api/cashout/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [WALLET_HEADER]: SOLANA_WALLET },
      body: JSON.stringify({
        chain: 'solana',
        account: SOLANA_WALLET,
        amount: '1',
        currency: 'NGN',
        institution: 'OPAYNGPC',
        accountIdentifier: DIGITS,
        idempotencyKey: KEY,
      }),
    })

  const weaveOnSolana = (over: Record<string, unknown> = {}) =>
    weave({
      createOrder: vi.fn(async () => ({
        ok: true,
        value: {
          ...weaveOrder,
          sourceAssetKey: 'crypto:SOLANA:USDC',
          deposit: { ...weaveOrder.deposit, chain: 'SOLANA' },
        },
      })),
      ...over,
    })

  beforeEach(() => {
    state.deposit = { ...state.deposit, isAccount: () => true, isDepositAddress: () => true }
    state.weave = weaveOnSolana()
    state.linq = linq({
      createOrder: vi.fn(async () => ({
        ok: true,
        value: { ...linqOrder, depositAddress: SOLANA_LINQ_DEPOSIT },
      })),
    })
  })

  it('places it with Linq on Solana when Linq pays more', async () => {
    expect((await POST(postFromSolana())).status).toBe(200)
    expect(called(state.linq['createOrder'])).toHaveBeenCalledWith(
      expect.objectContaining({ chain: 'solana', refundAddress: SOLANA_WALLET })
    )
    expect(called(state.repo['insert']).mock.calls[0]?.[0]).toMatchObject({
      chain: 'solana',
      provider: 'linq',
      depositAddress: SOLANA_LINQ_DEPOSIT,
    })
    expect(called(state.weave['createOrder'])).not.toHaveBeenCalled()
  })

  it('places it with Linq even when Weave would pay more', async () => {
    state.weave = weaveOnSolana({
      quote: vi.fn(async () => ({
        ok: true,
        value: { destAmount: 1400, netUsd: 0.99, seconds: 90 },
      })),
    })
    expect((await POST(postFromSolana())).status).toBe(200)
    expect(called(state.weave['createOrder'])).not.toHaveBeenCalled()
    expect(called(state.repo['insert']).mock.calls[0]?.[0]).toMatchObject({ provider: 'linq' })
  })

  it('falls back to Weave, and reports it, when Linq answers with a different order', async () => {
    state.linq = linq({
      createOrder: vi.fn(async () => ({ ok: false, code: 'unexpected_order', message: 'x' })),
    })
    expect((await POST(postFromSolana())).status).toBe(200)
    expect(called(state.repo['insert']).mock.calls[0]?.[0]).toMatchObject({ provider: 'weave' })
    expect(state.report.map((r) => String(r[1]))).toContain('Error: linq_order_unexpected')
  })
})

describe('GET quote, naira from Solana', () => {
  it("shows Linq's naira when Linq pays more, and leaves Avalanche with Weave", async () => {
    const ask = (chain: string) =>
      quote(
        new Request(`http://localhost/api/cashout/quote?chain=${chain}&currency=NGN&amount=1`, {
          headers: { [WALLET_HEADER]: SOLANA_WALLET },
        })
      )
    expect(await (await ask('solana')).json()).toEqual({
      destAmount: 1368.39,
      costPercent: 0,
      seconds: 90,
    })
    expect((await (await ask('avalanche')).json()).destAmount).not.toBe(1368.39)
  })
})

describe('GET quote, naira from Sui', () => {
  const ask = (chain = 'sui', currency = 'NGN') =>
    quote(
      new Request(
        `http://localhost/api/cashout/quote?chain=${chain}&currency=${currency}&amount=1`,
        {
          headers: { [WALLET_HEADER]: WALLET },
        }
      )
    )

  it("shows Linq's naira when Linq pays more", async () => {
    expect(await (await ask()).json()).toEqual({ destAmount: 1368.39, costPercent: 0, seconds: 90 })
  })

  it("shows Linq's naira even when Weave's estimate is higher", async () => {
    state.weave = weave({
      quote: vi.fn(async () => ({
        ok: true,
        value: { destAmount: 1400, netUsd: 0.99, seconds: 90 },
      })),
    })
    expect((await (await ask()).json()).destAmount).toBe(1368.39)
  })

  it("shows Weave's quote when Linq has no rate, or for another currency", async () => {
    state.weave = weave({
      quote: vi.fn(async () => ({
        ok: true,
        value: { destAmount: 1400, netUsd: 0.99, seconds: 90 },
      })),
    })
    expect((await (await ask('sui', 'KES')).json()).destAmount).toBe(1400)
    expect(called(state.linq['getRate'])).not.toHaveBeenCalled()
    state.linq = linq({ getRate: vi.fn(async () => ({ ok: false, code: 'unavailable' })) })
    expect((await (await ask()).json()).destAmount).toBe(1400)
  })
})

describe('syncOrder for an order Linq holds', () => {
  const row = (over: Partial<WeaveOrderRow> = {}): WeaveOrderRow => ({
    id: KEY,
    chain: 'sui',
    email: `wallet:${WALLET}`,
    account: WALLET,
    providerOrder: 'lq_1',
    provider: 'linq',
    idempotencyKey: KEY,
    currency: 'NGN',
    institutionCode: 'OPAYNGPC',
    institutionName: 'OPay',
    accountIdentifier: DIGITS,
    accountName: HOLDER,
    depositAddress: LINQ_DEPOSIT,
    depositMemo: undefined,
    amount: '1',
    estimatedDest: '1368.39',
    expiresAt: undefined,
    status: 'waiting',
    providerStatus: 'initiated',
    depositHash: undefined,
    sendStarted: false,
    createdAt: '2026-11-06T12:00:00.000Z',
    ...over,
  })
  const repo = () => ({
    setStatus: vi.fn(async () => undefined),
    setPaid: vi.fn(async () => undefined),
  })
  const neverWeave = { getOrder: vi.fn() }

  it('asks Linq, not Weave, and keeps what it paid', async () => {
    const r = repo()
    const getStatus = vi.fn(async () => ({
      ok: true as const,
      value: { id: 'lq_1', status: 'disbursed', amountCoin: 1, amountNGN: 1368.39 },
    }))
    const synced = await syncOrder(
      r,
      row({ status: 'processing', depositHash: '0xhash' }),
      neverWeave,
      {
        getStatus,
      }
    )
    expect(getStatus).toHaveBeenCalledWith('lq_1')
    expect(neverWeave.getOrder).not.toHaveBeenCalled()
    expect(synced.row).toMatchObject({ status: 'paid', paidDest: '1368.39' })
    expect(r.setPaid).toHaveBeenCalledWith('lq_1', '1368.39')
  })

  it('keeps an order with no deposit sent waiting, whatever Linq calls it', async () => {
    const synced = await syncOrder(repo(), row(), neverWeave, {
      getStatus: async () => ({
        ok: true,
        value: { id: 'lq_1', status: 'pending', amountCoin: 1, amountNGN: 1368.39 },
      }),
    })
    expect(synced.row.status).toBe('waiting')
  })

  it('says Linq could not be asked when there is no Linq client', async () => {
    expect((await syncOrder(repo(), row(), neverWeave)).reached).toBe(false)
  })
})
