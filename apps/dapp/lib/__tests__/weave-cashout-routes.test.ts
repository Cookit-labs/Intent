import { createHmac } from 'node:crypto'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  mainnet: true,
  db: true,
  weave: {} as Record<string, unknown>,
  repo: {} as Record<string, unknown>,
  deposit: {} as Record<string, unknown>,
  report: [] as unknown[][],
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
vi.mock('../server/rate-limit', () => ({ enforceRateLimit: async () => undefined }))
vi.mock('../server/db', async (original) => ({
  ...(await original<typeof import('../server/db')>()),
  databaseConfigured: () => state.db,
}))
vi.mock('../server/report', () => ({
  reportError: (...args: unknown[]) => state.report.push(args),
}))

import { GET as institutions } from '../../app/api/cashout/institutions/route'
import { GET as options } from '../../app/api/cashout/options/route'
import { GET as one } from '../../app/api/cashout/orders/[id]/route'
import { GET as list } from '../../app/api/cashout/orders/route'
import { GET as quote } from '../../app/api/cashout/quote/route'
import { POST as verify } from '../../app/api/cashout/verify/route'
import { POST as webhook } from '../../app/api/cashout/webhook/route'
import { WALLET_HEADER } from '../wallet-header'

const ID = '3f7c1b2a-84e9-4c11-b3d2-0a9f7e123456'
const DIGITS = '254700001234'
const fn = (value: unknown): ReturnType<typeof vi.fn> => value as ReturnType<typeof vi.fn>

function get(path: string): Request {
  return new Request(`http://localhost/api/cashout/${path}`, {
    headers: { [WALLET_HEADER]: 'alice.near' },
  })
}

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ID,
    chain: 'near',
    email: 'wallet:alice.near',
    account: 'alice.near',
    providerOrder: 'ord_1',
    idempotencyKey: 'key',
    currency: 'KES',
    institutionCode: 'MPESA',
    institutionName: 'M-Pesa',
    accountIdentifier: DIGITS,
    accountName: 'JANE ADEYEMI',
    depositAddress: 'weave.near',
    depositMemo: undefined,
    amount: '25.5',
    estimatedDest: '3200.5',
    expiresAt: undefined,
    status: 'waiting',
    providerStatus: 'awaiting_deposit',
    depositHash: undefined,
    createdAt: '2026-11-04T11:00:00.000Z',
    ...over,
  }
}

beforeEach(() => {
  state.mainnet = true
  state.db = true
  state.report = []
  state.deposit = { usdcDecimals: 6 }
  state.weave = {
    configured: true,
    institutions: vi.fn(async () => ({
      ok: true,
      value: [{ name: 'M-Pesa', code: 'MPESA', type: 'mobile_money' }],
    })),
    verifyAccount: vi.fn(async () => ({ ok: true, value: { accountName: 'JANE ADEYEMI' } })),
    quote: vi.fn(async () => ({
      ok: true,
      value: { destAmount: 3200.5, netUsd: 24.5, seconds: 90 },
    })),
    getOrder: vi.fn(async () => ({ ok: true, value: { id: 'ord_1', status: 'awaiting_deposit' } })),
  }
  state.repo = {
    findHolder: vi.fn(async () => undefined),
    getForEmail: vi.fn(async () => row()),
    getByProviderOrder: vi.fn(async () => row()),
    listForEmail: vi.fn(async () => [row()]),
    setStatus: vi.fn(async () => undefined),
    setPaid: vi.fn(async () => undefined),
  }
  vi.stubEnv('WEAVE_CASHOUT_CURRENCIES', 'NGN,KES')
  vi.stubEnv('WEAVE_WEBHOOK_SECRET', 'whsec')
})

describe('GET options', () => {
  it('lists what this chain can cash out to, with names', async () => {
    const body = await (await options(get('options?chain=near'))).json()
    expect(body.currencies.map((c: { code: string }) => c.code)).toEqual(['NGN', 'KES'])
    expect(body.currencies[1]).toMatchObject({ country: 'Kenya', symbol: 'KSh' })
  })

  it('leaves naira off Stellar', async () => {
    const body = await (await options(get('options?chain=stellar'))).json()
    expect(body.currencies.map((c: { code: string }) => c.code)).toEqual(['KES'])
  })

  it('refuses a chain it does not know', async () => {
    expect((await options(get('options?chain=ethereum'))).status).toBe(400)
    expect((await options(get('options'))).status).toBe(400)
  })

  it('refuses Stellar off mainnet', async () => {
    state.mainnet = false
    expect((await options(get('options?chain=stellar'))).status).toBe(403)
  })

  it('needs a requester', async () => {
    expect(
      (await options(new Request('http://localhost/api/cashout/options?chain=near'))).status
    ).toBe(401)
  })
})

describe('GET institutions', () => {
  it('lists a live currency', async () => {
    const body = await (await institutions(get('institutions?currency=KES'))).json()
    expect(body.institutions).toEqual([{ name: 'M-Pesa', code: 'MPESA', type: 'mobile_money' }])
  })

  it('refuses a currency that is not live, asking Weave nothing', async () => {
    expect((await institutions(get('institutions?currency=UGX'))).status).toBe(400)
    expect((await institutions(get('institutions'))).status).toBe(400)
    expect(fn(state.weave['institutions'])).not.toHaveBeenCalled()
  })

  it('passes on a failure in our words', async () => {
    fn(state.weave['institutions']).mockResolvedValue({
      ok: false,
      code: 'unavailable',
      message: 'Busy.',
    })
    const res = await institutions(get('institutions?currency=KES'))
    expect(res.status).toBe(503)
    expect((await res.json()).message).toBe('Busy.')
  })
})

describe('POST verify', () => {
  const post = (body: unknown): Request =>
    new Request('http://localhost/api/cashout/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [WALLET_HEADER]: 'alice.near' },
      body: JSON.stringify(body),
    })
  const good = { currency: 'KES', institution: 'MPESA', accountIdentifier: DIGITS }

  it('returns the name Weave gives', async () => {
    const res = await verify(post(good))
    expect(await res.json()).toEqual({ accountName: 'JANE ADEYEMI' })
    expect(fn(state.weave['verifyAccount'])).toHaveBeenCalledWith({
      institution: 'MPESA',
      accountIdentifier: DIGITS,
      currency: 'KES',
    })
  })

  it("uses this requester's earlier order to the same account", async () => {
    fn(state.repo['findHolder']).mockResolvedValue('JANE BEFORE')
    const res = await verify(post(good))
    expect(await res.json()).toEqual({ accountName: 'JANE BEFORE' })
    expect(fn(state.repo['findHolder'])).toHaveBeenCalledWith(
      'wallet:alice.near',
      'KES',
      'MPESA',
      DIGITS
    )
    expect(fn(state.weave['verifyAccount'])).not.toHaveBeenCalled()
  })

  it('refuses bad input, asking Weave nothing', async () => {
    expect((await verify(post({ ...good, currency: 'UGX' }))).status).toBe(400)
    expect((await verify(post({ ...good, accountIdentifier: '1;2' }))).status).toBe(400)
    expect(fn(state.weave['verifyAccount'])).not.toHaveBeenCalled()
  })

  it('answers a refusal as a refusal', async () => {
    fn(state.weave['verifyAccount']).mockResolvedValue({
      ok: false,
      code: 'rejected',
      message: 'That account could not be verified.',
    })
    expect((await verify(post(good))).status).toBe(422)
  })
})

describe('GET quote', () => {
  it('gives the dest amount, the cost from netUsd and the time', async () => {
    const res = await quote(get('quote?chain=near&currency=KES&amount=25'))
    expect(await res.json()).toEqual({
      destAmount: 3200.5,
      costPercent: 2,
      seconds: 90,
    })
  })

  it('shows no negative cost', async () => {
    fn(state.weave['quote']).mockResolvedValue({
      ok: true,
      value: { destAmount: 1, netUsd: 26, seconds: 1 },
    })
    const res = await quote(get('quote?chain=near&currency=KES&amount=25'))
    expect((await res.json()).costPercent).toBe(0)
  })

  it.each([
    ['chain=ethereum&currency=KES&amount=25'],
    ['chain=near&currency=UGX&amount=25'],
    ['chain=stellar&currency=NGN&amount=25'],
    ['chain=near&currency=KES&amount=1.1234567'],
    ['chain=near&currency=KES&amount=0'],
    ['chain=near&currency=KES'],
  ])('refuses %s', async (query) => {
    expect((await quote(get(`quote?${query}`))).status).toBe(400)
    expect(fn(state.weave['quote'])).not.toHaveBeenCalled()
  })
})

describe('GET orders', () => {
  it("lists only this requester's orders, masked", async () => {
    const res = await list(get('orders'))
    const text = JSON.stringify(await res.json())
    expect(fn(state.repo['listForEmail'])).toHaveBeenCalledWith('wallet:alice.near', 50)
    expect(text).not.toContain(DIGITS)
    expect(text).toContain('••••1234')
  })

  it('needs a requester', async () => {
    expect((await list(new Request('http://localhost/api/cashout/orders'))).status).toBe(401)
  })

  it('answers an empty list with no database', async () => {
    state.db = false
    expect(await (await list(get('orders'))).json()).toEqual({ orders: [] })
  })

  it('answers an empty list when the read fails', async () => {
    fn(state.repo['listForEmail']).mockRejectedValue(new Error('down'))
    expect(await (await list(get('orders'))).json()).toEqual({ orders: [] })
  })
})

describe('GET one order', () => {
  const context = { params: Promise.resolve({ id: ID }) }

  it('syncs from Weave and answers the moved status', async () => {
    fn(state.weave['getOrder']).mockResolvedValue({
      ok: true,
      value: { id: 'ord_1', status: 'processing' },
    })
    const res = await one(get(`orders/${ID}`), context)
    expect((await res.json()).order.status).toBe('processing')
    expect(fn(state.repo['setStatus'])).toHaveBeenCalledWith('ord_1', 'processing', 'processing')
  })

  it('does not ask Weave about a final order whose paid amount is known', async () => {
    fn(state.repo['getForEmail']).mockResolvedValue(
      row({ status: 'paid', providerStatus: 'completed', paidDest: '877.08' })
    )
    const res = await one(get(`orders/${ID}`), context)
    expect((await res.json()).order).toMatchObject({ status: 'paid', paidDest: '877.08' })
    expect(fn(state.weave['getOrder'])).not.toHaveBeenCalled()
  })

  it('asks Weave once for what a paid order paid, and shows that', async () => {
    fn(state.repo['getForEmail']).mockResolvedValue(
      row({ status: 'paid', providerStatus: 'completed' })
    )
    fn(state.weave['getOrder']).mockResolvedValue({
      ok: true,
      value: { id: ID, status: 'completed', destAmount: 877.08 },
    })
    const res = await one(get(`orders/${ID}`), context)
    expect((await res.json()).order).toMatchObject({ status: 'paid', paidDest: '877.08' })
  })

  it('falls back to the stored row when Weave cannot be reached', async () => {
    fn(state.weave['getOrder']).mockResolvedValue({ ok: false, code: 'unavailable', message: 'x' })
    const res = await one(get(`orders/${ID}`), context)
    expect(res.status).toBe(200)
    expect((await res.json()).order.status).toBe('waiting')
  })

  it("answers not found for somebody else's order", async () => {
    fn(state.repo['getForEmail']).mockResolvedValue(undefined)
    expect((await one(get(`orders/${ID}`), context)).status).toBe(404)
    expect(fn(state.repo['getForEmail'])).toHaveBeenCalledWith(ID, 'wallet:alice.near')
  })

  it('never returns the digits', async () => {
    const text = JSON.stringify(await (await one(get(`orders/${ID}`), context)).json())
    expect(text).not.toContain(DIGITS)
  })
})

describe('POST webhook', () => {
  const event = (over: Record<string, unknown> = {}, data: Record<string, unknown> = {}): string =>
    JSON.stringify({
      event: 'order.completed',
      data: { id: 'ord_1', reference: 'key', status: 'completed', ...data },
      ...over,
    })

  function signed(body: string, secret = 'whsec', ts = Math.floor(Date.now() / 1000)): Request {
    const signature = createHmac('sha256', secret).update(`${ts}.`).update(body).digest('hex')
    return new Request('http://localhost/api/cashout/webhook', {
      method: 'POST',
      headers: { 'X-Weave-Signature': `sha256=${signature}`, 'X-Weave-Timestamp': String(ts) },
      body,
    })
  }

  it('moves the order', async () => {
    const res = await webhook(signed(event()))
    expect(res.status).toBe(200)
    expect(fn(state.repo['setStatus'])).toHaveBeenCalledWith('ord_1', 'paid', 'completed')
  })

  it('falls back to the event name when the body has no status', async () => {
    await webhook(signed(event({ event: 'order.failed' }, { status: undefined })))
    expect(fn(state.repo['setStatus'])).toHaveBeenCalledWith('ord_1', 'failed', 'failed')
  })

  it('verifies the bytes as they arrived', async () => {
    const spaced = `{ "event": "order.completed", "data": { "id": "ord_1", "status": "completed" } }`
    expect((await webhook(signed(spaced))).status).toBe(200)
    expect(fn(state.repo['setStatus'])).toHaveBeenCalled()
  })

  it('refuses a bad signature before reading anything', async () => {
    const res = await webhook(signed(event(), 'other'))
    expect(res.status).toBe(401)
    expect(fn(state.repo['getByProviderOrder'])).not.toHaveBeenCalled()
  })

  it('refuses a stale timestamp', async () => {
    const res = await webhook(signed(event(), 'whsec', Math.floor(Date.now() / 1000) - 301))
    expect(res.status).toBe(401)
  })

  it('fails closed when the secret is unset', async () => {
    vi.stubEnv('WEAVE_WEBHOOK_SECRET', '')
    expect((await webhook(signed(event(), ''))).status).toBe(401)
    expect(fn(state.repo['getByProviderOrder'])).not.toHaveBeenCalled()
  })

  it('answers 200 for an order it does not know', async () => {
    fn(state.repo['getByProviderOrder']).mockResolvedValue(undefined)
    expect((await webhook(signed(event()))).status).toBe(200)
    expect(fn(state.repo['setStatus'])).not.toHaveBeenCalled()
  })

  it('ignores a replay', async () => {
    fn(state.repo['getByProviderOrder']).mockResolvedValue(
      row({ status: 'paid', providerStatus: 'completed' })
    )
    expect((await webhook(signed(event()))).status).toBe(200)
    expect(fn(state.repo['setStatus'])).not.toHaveBeenCalled()
  })

  it('does not let a late event move a final order', async () => {
    fn(state.repo['getByProviderOrder']).mockResolvedValue(
      row({ status: 'paid', providerStatus: 'completed' })
    )
    await webhook(signed(event({ event: 'order.failed' }, { status: 'failed' })))
    expect(fn(state.repo['setStatus'])).not.toHaveBeenCalled()
  })

  it('answers 200 for a signed event with no order id', async () => {
    expect((await webhook(signed(JSON.stringify({ event: 'ping' })))).status).toBe(200)
  })

  it('answers 400 for a signed body that is not JSON', async () => {
    expect((await webhook(signed('nope'))).status).toBe(400)
  })

  it('answers non-2xx when the record cannot be written, so Weave retries', async () => {
    fn(state.repo['setStatus']).mockRejectedValue(new Error('down'))
    expect((await webhook(signed(event()))).status).toBe(500)
    expect(state.report).toHaveLength(1)
  })
})
