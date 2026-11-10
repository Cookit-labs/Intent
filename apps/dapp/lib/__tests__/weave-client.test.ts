import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createWeaveClient,
  quoteCostPercent,
  type WeaveFailure,
  type WeaveOrderInput,
} from '../weave/client'

const KEY = 'sk_test_never_shown'
const PAYCREST =
  'Paycrest 400: {"status":"error","message":"Fiat currency BRL is not supported","data":null}'

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

function client(answer: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) =>
    answer(String(url), init ?? {})
  )
  return {
    fetchImpl,
    weave: createWeaveClient({ apiKey: KEY, fetchImpl: fetchImpl as unknown as typeof fetch }),
  }
}

const order: WeaveOrderInput = {
  chain: 'near',
  currency: 'KES',
  amount: '25.5',
  account: 'alice.near',
  institutionCode: 'MPESA',
  accountIdentifier: '254700000000',
  accountName: 'JANE ADEYEMI',
  reference: '3f7c1b2a-84e9-4c11-b3d2-0a9f7e123456',
  customer: { externalId: 'wallet:alice.near' },
}

const deposit = {
  type: 'crypto_transfer',
  depositAddress: 'weave.near',
  depositMemo: null,
  amount: '25.5',
  token: 'USDC',
  chain: 'NEAR',
  expiresAt: '2026-11-04T12:00:00.000Z',
}

const placed = {
  order: {
    id: 'ord_1',
    status: 'awaiting_deposit',
    sourceAssetKey: 'crypto:NEAR:USDC',
    destAssetKey: 'fiat:KES',
  },
  depositInstruction: deposit,
  nextAction: { screen: 'collect_crypto', ...deposit },
}

function detailOf(result: WeaveFailure): string | undefined {
  return 'detail' in result ? result.detail : undefined
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('configuration', () => {
  it('is configured by WEAVE_SECRET_KEY and by no public variable', () => {
    vi.stubEnv('NEXT_PUBLIC_WEAVE_SECRET_KEY', 'public')
    vi.stubEnv('WEAVE_SECRET_KEY', '')
    expect(createWeaveClient().configured).toBe(false)
    vi.stubEnv('WEAVE_SECRET_KEY', KEY)
    expect(createWeaveClient().configured).toBe(true)
  })

  it('makes no call without a key', async () => {
    const fetchImpl = vi.fn()
    const weave = createWeaveClient({ apiKey: '', fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(await weave.createOrder(order)).toMatchObject({ ok: false, code: 'unavailable' })
    expect(await weave.institutions('KES')).toMatchObject({ ok: false, code: 'unavailable' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('sends the key in its header to the production base by default', async () => {
    const { weave, fetchImpl } = client(() => json(200, { success: true, data: [] }))
    await weave.institutions('KES')
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.paywithweave.com/api/v1/institutions?currency=KES')
    expect((init.headers as Record<string, string>)['x-secret-key']).toBe(KEY)
  })
})

describe('institutions', () => {
  it('returns the list', async () => {
    const list = [{ name: 'M-Pesa', code: 'MPESA', type: 'mobile_money' }]
    const { weave } = client(() => json(200, { success: true, data: list }))
    expect(await weave.institutions('KES')).toEqual({ ok: true, value: list })
  })

  it('fails closed on a shape it does not recognise', async () => {
    const { weave } = client(() => json(200, { success: true, data: [{ code: 'X' }] }))
    expect(await weave.institutions('KES')).toMatchObject({ ok: false, code: 'unexpected' })
  })

  it('fails closed on a body with no success flag', async () => {
    const { weave } = client(() => json(200, { data: [] }))
    expect(await weave.institutions('KES')).toMatchObject({ ok: false, code: 'unexpected' })
  })
})

describe('verifyAccount', () => {
  it('posts the details and returns the name', async () => {
    const { weave, fetchImpl } = client(() => json(200, { success: true, data: 'JANE ADEYEMI' }))
    const result = await weave.verifyAccount({
      institution: 'MPESA',
      accountIdentifier: '254700000000',
      currency: 'KES',
    })
    expect(result).toEqual({ ok: true, value: { accountName: 'JANE ADEYEMI' } })
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toMatch(/\/institutions\/verify$/)
    expect(JSON.parse(init.body as string)).toEqual({
      institution: 'MPESA',
      accountIdentifier: '254700000000',
      currency: 'KES',
    })
  })

  it('refuses an empty name', async () => {
    const { weave } = client(() => json(200, { success: true, data: '  ' }))
    expect(
      await weave.verifyAccount({ institution: 'A', accountIdentifier: '1', currency: 'KES' })
    ).toMatchObject({ ok: false, code: 'unexpected' })
  })

  it('says it could not be verified without echoing the provider', async () => {
    const { weave } = client(() => json(400, { success: false, error: PAYCREST }))
    const result = await weave.verifyAccount({
      institution: 'A',
      accountIdentifier: '1',
      currency: 'KES',
    })
    expect(result).toMatchObject({ ok: false, code: 'rejected' })
    expect(JSON.stringify(result)).not.toContain('Paycrest')
  })
})

describe('quote', () => {
  const body = {
    success: true,
    data: {
      estimatedDest: 3200.5,
      breakdown: { netUsd: 24.75, appFeeUsd: 0.1, bridgeFeeUsd: 0.15 },
      route: {
        steps: [{ provider: 'paycrest' }],
        totalExpectedFeeBps: 12,
        totalExpectedSecs: 90,
      },
    },
  }

  it('asks for the chain and currency as asset keys', async () => {
    const { weave, fetchImpl } = client(() => json(200, body))
    const result = await weave.quote({ chain: 'near', currency: 'KES', amount: '25' })
    const url = new URL(String(fetchImpl.mock.calls[0]?.[0]))
    expect(url.pathname).toBe('/api/v1/quotes')
    expect(url.searchParams.get('from')).toBe('crypto:NEAR:USDC')
    expect(url.searchParams.get('to')).toBe('fiat:KES')
    expect(url.searchParams.get('amount')).toBe('25')
    expect(result).toEqual({ ok: true, value: { destAmount: 3200.5, netUsd: 24.75, seconds: 90 } })
  })

  it('needs none of the fields that are only in the docs', async () => {
    const { weave } = client(() => json(200, body))
    expect((await weave.quote({ chain: 'near', currency: 'KES', amount: '25' })).ok).toBe(true)
  })

  it('fails closed when netUsd is missing, since the cost cannot be worked out', async () => {
    const { weave } = client(() =>
      json(200, {
        success: true,
        data: { estimatedDest: 1, breakdown: {}, route: { totalExpectedSecs: 1 } },
      })
    )
    expect(await weave.quote({ chain: 'near', currency: 'KES', amount: '25' })).toMatchObject({
      ok: false,
      code: 'unexpected',
    })
  })

  it('never shows the raw failure text', async () => {
    const { weave } = client(() => json(400, { success: false, error: PAYCREST }))
    const result = await weave.quote({ chain: 'near', currency: 'KES', amount: '25' })
    expect(result).toMatchObject({ ok: false, code: 'rejected' })
    expect(JSON.stringify(result)).not.toMatch(/Paycrest|BRL/)
  })

  it('treats a success flag of false on a 200 as refused', async () => {
    const { weave } = client(() => json(200, { success: false, error: PAYCREST }))
    expect(await weave.quote({ chain: 'near', currency: 'KES', amount: '25' })).toMatchObject({
      ok: false,
      code: 'rejected',
    })
  })
})

describe('quoteCostPercent', () => {
  it('is what the amount lost on the way to netUsd', () => {
    expect(quoteCostPercent('100', 96)).toBeCloseTo(4)
    expect(quoteCostPercent('25', 24.75)).toBeCloseTo(1)
  })

  it('is above any limit for an amount that cannot be read', () => {
    expect(quoteCostPercent('0', 1)).toBe(Number.POSITIVE_INFINITY)
    expect(quoteCostPercent('nope', 1)).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('createOrder', () => {
  it('sends the documented body', async () => {
    const { weave, fetchImpl } = client(() => json(200, placed))
    await weave.createOrder(order)
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toMatch(/\/orders$/)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({
      source: {
        inline: {
          kind: 'crypto_wallet',
          assetKey: 'crypto:NEAR:USDC',
          walletAddress: 'alice.near',
        },
      },
      dest: {
        inline: {
          kind: 'bank_account',
          assetKey: 'fiat:KES',
          bankInstitution: 'MPESA',
          bankAccountIdentifier: '254700000000',
          bankAccountName: 'JANE ADEYEMI',
          label: 'Cash-out',
        },
      },
      amount: '25.5',
      amountIn: 'source',
      flow: 'external',
      refundAddress: 'alice.near',
      reference: order.reference,
      customer: { externalId: 'wallet:alice.near' },
    })
  })

  const expected = {
    ok: true,
    value: {
      id: 'ord_1',
      status: 'awaiting_deposit',
      sourceAssetKey: 'crypto:NEAR:USDC',
      destAssetKey: 'fiat:KES',
      deposit: {
        address: 'weave.near',
        memo: undefined,
        amount: '25.5',
        token: 'USDC',
        chain: 'NEAR',
        expiresAt: '2026-11-04T12:00:00.000Z',
      },
    },
  }

  it('accepts the answer unwrapped', async () => {
    const { weave } = client(() => json(200, placed))
    expect(await weave.createOrder(order)).toEqual(expected)
  })

  it('accepts the answer wrapped in data', async () => {
    const { weave } = client(() => json(201, { success: true, data: placed }))
    expect(await weave.createOrder(order)).toEqual(expected)
  })

  it('accepts nextAction alone, where the expiry is not given', async () => {
    const { weave } = client(() =>
      json(200, {
        order: placed.order,
        nextAction: {
          screen: 'collect_crypto',
          depositAddress: 'weave.near',
          amount: 25.5,
          token: 'USDC',
          chain: 'NEAR',
          depositMemo: 'M1',
        },
      })
    )
    const result = await weave.createOrder(order)
    expect(result).toMatchObject({
      ok: true,
      value: { deposit: { address: 'weave.near', amount: '25.5', memo: 'M1' } },
    })
    if (result.ok) expect(result.value.deposit.expiresAt).toBeUndefined()
  })

  it('reads an empty memo as no memo', async () => {
    const { weave } = client(() =>
      json(200, { ...placed, depositInstruction: { ...deposit, depositMemo: '' } })
    )
    const result = await weave.createOrder(order)
    if (!result.ok) throw new Error('expected an order')
    expect(result.value.deposit.memo).toBeUndefined()
  })

  it.each([
    ['no deposit details', { order: placed.order }],
    ['no order', { depositInstruction: deposit }],
    ['no address', { ...placed, depositInstruction: { ...deposit, depositAddress: '' } }],
    [
      'an expiry that is not a date',
      { ...placed, depositInstruction: { ...deposit, expiresAt: 'soon' } },
    ],
  ])('fails closed on %s', async (_name, body) => {
    const { weave } = client(() => json(200, body))
    expect(await weave.createOrder(order)).toMatchObject({ ok: false, code: 'unexpected' })
  })

  it('says a duplicate reference apart from any other refusal', async () => {
    const { weave } = client(() => json(409, { success: false, error: 'duplicate reference' }))
    expect(await weave.createOrder(order)).toMatchObject({ ok: false, code: 'duplicate' })
  })

  it('keeps the provider text out of the message, and in the detail for the log', async () => {
    const { weave } = client(() => json(400, { success: false, error: PAYCREST }))
    const result = await weave.createOrder(order)
    expect(result).toMatchObject({ ok: false, code: 'rejected' })
    if (result.ok) throw new Error('expected a refusal')
    expect(result.message).not.toContain('Paycrest')
    expect(detailOf(result)).toContain('Fiat currency BRL is not supported')
  })

  it('masks long digit runs in the detail, so an account number is never logged', async () => {
    const { weave } = client(() =>
      json(422, { success: false, message: 'Account 0123456789 could not be verified' })
    )
    const result = await weave.createOrder(order)
    if (result.ok) throw new Error('expected a refusal')
    expect(detailOf(result)).toContain('could not be verified')
    expect(detailOf(result)).not.toContain('0123456789')
  })

  it('caps the detail', async () => {
    const { weave } = client(() => json(400, { success: false, error: 'x'.repeat(5000) }))
    const result = await weave.createOrder(order)
    if (result.ok) throw new Error('expected a refusal')
    expect(detailOf(result)?.length).toBeLessThanOrEqual(300)
  })

  it('names the order and its status when an accepted order has no deposit', async () => {
    const { weave } = client(() => json(200, { success: true, data: { order: placed.order } }))
    const result = await weave.createOrder(order)
    expect(result).toMatchObject({ ok: false, code: 'unexpected' })
    if (result.ok) throw new Error('expected a failure')
    expect(detailOf(result)).toContain('ord_1')
    expect(detailOf(result)).toContain('awaiting_deposit')
  })

  it('reports no answer as unknown, because the order may exist', async () => {
    const { weave } = client(() => {
      throw new Error('socket hang up')
    })
    expect(await weave.createOrder(order)).toMatchObject({ ok: false, code: 'unknown' })
  })

  it('reports a server error as unknown, because the order may exist', async () => {
    const { weave } = client(() => json(502, {}))
    expect(await weave.createOrder(order)).toMatchObject({ ok: false, code: 'unknown' })
  })

  it('reports a throttle as unavailable, because nothing was accepted', async () => {
    const { weave } = client(() => json(429, {}))
    expect(await weave.createOrder(order)).toMatchObject({ ok: false, code: 'unavailable' })
  })

  it('gives up at its timeout and calls that unknown', async () => {
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })) as unknown as typeof fetch
    const weave = createWeaveClient({ apiKey: KEY, fetchImpl, timeoutMs: 5 })
    expect(await weave.createOrder(order)).toMatchObject({ ok: false, code: 'unknown' })
  })
})

describe('getOrder', () => {
  it('returns the status', async () => {
    const { weave, fetchImpl } = client(() =>
      json(200, { success: true, data: { id: 'ord/1', status: 'processing', steps: [] } })
    )
    expect(await weave.getOrder('ord/1')).toEqual({
      ok: true,
      value: { id: 'ord/1', status: 'processing' },
    })
    expect(String(fetchImpl.mock.calls[0]?.[0])).toMatch(/\/orders\/ord%2F1$/)
  })

  it('fails closed when the answer is about another order', async () => {
    const { weave } = client(() =>
      json(200, { success: true, data: { id: 'ord_2', status: 'completed' } })
    )
    expect(await weave.getOrder('ord_1')).toMatchObject({ ok: false, code: 'unexpected' })
  })

  it('fails closed with no status', async () => {
    const { weave } = client(() => json(200, { success: true, data: { id: 'ord_1' } }))
    expect(await weave.getOrder('ord_1')).toMatchObject({ ok: false, code: 'unexpected' })
  })

  it('calls no answer unavailable, since a read changes nothing', async () => {
    const { weave } = client(() => {
      throw new Error('down')
    })
    expect(await weave.getOrder('ord_1')).toMatchObject({ ok: false, code: 'unavailable' })
  })
})
