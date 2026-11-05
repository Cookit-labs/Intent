import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { nearCapabilities } from '../chains/near/capabilities'
import { nearModule } from '../chains/near/module'
import { rheaBook, rheaVenue } from '../chains/near/rhea-dcl'
import { assertRestingPoint, pointForPrice } from '../chains/near/rhea-dcl-rules'
import {
  assertDclExitSafe,
  assertDclOrderSafe,
  assertMetapoolSafe,
  assertOneClickSafe,
  assertRnearSafe,
  assertTokenTransferSafe,
  STORAGE_DEPOSIT_YOCTO,
} from '../chains/near/safety'
import { nearVenues } from '../chains/near/venues'
import { assertLimitCanRun, assertNativeReserve, prepareChainAction } from '../chains/prepare'
import {
  ChainActionRefused,
  type ChainActionRequest,
  type ChainModule,
  type NearTransaction,
  type PreparedAction,
  type SigningPayload,
} from '../chains/types'

const ME = 'alice.near'
const THIEF = 'mallory.near'
const HASH = 'G6RQqbkHNF1JVMwmq9BiLnZ3vvUeYoNm7z4dYVEKgScA'
const HASH_2 = 'H6RQqbkHNF1JVMwmq9BiLnZ3vvUeYoNm7z4dYVEKgScA'
const DCL = 'dclv2.ref-labs.near'
const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'
const USDT = 'usdt.tether-token.near'
const WRAP = 'wrap.near'
const POOL = `${USDC}|${WRAP}|100`
const ORDER = `${POOL}#8665`
const ONE_NEAR = '1000000000000000000000000'
const HALF_NEAR = '500000000000000000000000'
const TG30 = '30000000000000'
const TG180 = '180000000000000'
const TG250 = '250000000000000'
const SALE_POINT = 400134
const BUY_POINT = 400876

const NOTES = [
  'When it fills, press Collect to receive it. That needs a second signature.',
  'First use sets aside up to 0.5 NEAR for storage on Rhea. I could not confirm it comes back.',
  'A purchase pays out in NEAR.',
  'This stays open until it fills or you cancel it.',
]

type Action = NearTransaction['actions'][number]

function call(
  methodName: string,
  args: Record<string, unknown>,
  deposit: string,
  gas = TG30
): Action {
  return { type: 'FunctionCall', params: { methodName, args, gas, deposit } }
}

const storage = (deposit = STORAGE_DEPOSIT_YOCTO, account = ME): Action =>
  call('storage_deposit', { account_id: account, registration_only: true }, deposit)

const msg = (buyToken: string, point: number): string =>
  JSON.stringify({
    LimitOrderWithSwap: { client_id: '', pool_id: POOL, buy_token: buyToken, point },
  })

const place = (amount: string, buyToken: string, point: number): Action =>
  call('ft_transfer_call', { receiver_id: DCL, amount, msg: msg(buyToken, point) }, '1', TG250)

const payload = (...transactions: NearTransaction[]): SigningPayload => ({
  family: 'near',
  transactions,
})

/** The two token transactions the app builds, each as `expected` describes it. */
const SALE = { sellToken: WRAP, amount: ONE_NEAR, point: SALE_POINT }
const BUY = { sellToken: USDC, amount: '10000000', point: BUY_POINT }
const sale = (actions?: Action[]): NearTransaction => ({
  receiverId: WRAP,
  actions: actions ?? [call('near_deposit', {}, ONE_NEAR), place(ONE_NEAR, USDC, SALE_POINT)],
})
const buy = (actions?: Action[]): NearTransaction => ({
  receiverId: USDC,
  actions: actions ?? [place('10000000', WRAP, BUY_POINT)],
})

const STORAGE_DETAIL = {
  sponsor_id: ME,
  locked_near: HALF_NEAR,
  storage_for_asset: '100000000000000000000000',
  slot_price: '10000000000000000000000',
  max_slots: 40,
  cur_order_slots: 1,
  cur_liquidity_slots: 0,
}

const OPEN_ORDER = {
  client_id: '',
  order_id: ORDER,
  owner_id: ME,
  pool_id: POOL,
  point: BUY_POINT,
  sell_token: USDC,
  buy_token: WRAP,
  original_deposit_amount: '10000000',
  swap_earn_amount: '0',
  original_amount: '10000000',
  cancel_amount: '0',
  created_at: '1770886735876414598',
  remain_amount: '10000000',
  bought_amount: '0',
  unclaimed_amount: '0',
}

interface Rpc {
  views: Record<string, unknown>
  down: boolean
  /** Views that throw, by `contract.method`. */
  downViews: string[]
  tx: Record<string, unknown>
}

let rpc: Rpc

function poolRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pool_id: POOL,
    token_x: USDC,
    token_y: WRAP,
    fee: 100,
    point_delta: 1,
    current_point: 400630,
    state: 'Running',
    whitelist: null,
    tax: null,
    ...over,
  }
}

function install(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const json = (data: unknown): Response => new Response(JSON.stringify(data))
      if (rpc.down) throw new Error('down')
      const body = JSON.parse(init?.body as string) as {
        method: string
        params: {
          tx_hash?: string
          account_id?: string
          method_name?: string
          args_base64?: string
        }
      }
      if (body.method === 'tx') {
        const result = rpc.tx[body.params.tx_hash ?? '']
        return json(
          result === undefined ? { error: { cause: { name: 'UNKNOWN_TRANSACTION' } } } : { result }
        )
      }
      const key = `${body.params.account_id}.${body.params.method_name}`
      if (rpc.downViews.includes(key)) return json({ result: { error: `no ${key}` } })
      if (!(key in rpc.views)) return json({ result: { error: `no ${key}` } })
      return json({ result: { result: [...Buffer.from(JSON.stringify(rpc.views[key]))] } })
    })
  )
}

/** An account that has done all of the setup. */
function settled(): Rpc['views'] {
  return {
    [`${DCL}.get_pool`]: poolRow(),
    [`${DCL}.get_metadata`]: { state: 'Running' },
    [`${DCL}.get_user_storage_detail`]: STORAGE_DETAIL,
    [`${DCL}.storage_balance_bounds`]: { min: HALF_NEAR, max: null },
    [`${DCL}.find_order`]: null,
    [`${DCL}.get_order`]: OPEN_ORDER,
    [`${DCL}.list_active_orders`]: [OPEN_ORDER],
    [`${USDC}.storage_balance_of`]: { total: STORAGE_DEPOSIT_YOCTO, available: '0' },
    [`${WRAP}.storage_balance_of`]: { total: STORAGE_DEPOSIT_YOCTO, available: '0' },
  }
}

beforeEach(() => {
  rpc = { views: settled(), down: false, downViews: [], tx: {} }
  install()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const selling = (over: Partial<ChainActionRequest> = {}): ChainActionRequest => ({
  kind: 'limit',
  amount: '1',
  tokenIn: 'NEAR',
  tokenOut: 'USDC',
  limitPrice: '4.2',
  ...over,
})
const buying = (over: Partial<ChainActionRequest> = {}): ChainActionRequest => ({
  kind: 'limit',
  amount: '10',
  tokenIn: 'USDC',
  tokenOut: 'NEAR',
  limitPrice: '3.9',
  ...over,
})

function refused(fn: () => void): void {
  expect(fn).toThrow(ChainActionRefused)
  expect(fn).toThrow(/Nothing was signed or sent\.$/)
}

function txs(prepared: PreparedAction): NearTransaction[] {
  return (prepared.signing as Extract<SigningPayload, { family: 'near' }>).transactions
}

function firstUse(): void {
  rpc.views[`${DCL}.get_user_storage_detail`] = null
  rpc.views[`${USDC}.storage_balance_of`] = null
  rpc.views[`${WRAP}.storage_balance_of`] = null
}

describe('pointForPrice', () => {
  // USDC per NEAR = 1e18 / 1.0001^point, read from orders resting on this pool on 2026-11-05.
  it('sells NEAR at a point below the market, and no cheaper than asked', () => {
    const point = pointForPrice(4.29, true, 1)
    expect(Math.abs(point - 399922)).toBeLessThan(10)
    expect(1e18 / 1.0001 ** point).toBeGreaterThanOrEqual(4.29)
  })
  it('buys NEAR at a point above the market, and no dearer than asked', () => {
    const point = pointForPrice(0.909, false, 1)
    expect(Math.abs(point - 415439)).toBeLessThan(10)
    expect(1e18 / 1.0001 ** point).toBeLessThanOrEqual(0.909)
  })
  it('keeps to the pool step', () => {
    expect(pointForPrice(4.29, true, 40) % 40).toBe(0)
  })
  it('stays on the right side of the price on a wide step', () => {
    const sale = pointForPrice(4.29, true, 40)
    const purchase = pointForPrice(4.29, false, 40)
    expect(1e18 / 1.0001 ** sale).toBeGreaterThanOrEqual(4.29)
    expect(1e18 / 1.0001 ** purchase).toBeLessThanOrEqual(4.29)
    expect(purchase - sale).toBe(40)
  })
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('refuses a price of %s', (price) => {
    refused(() => pointForPrice(price, true, 1))
  })
})

describe('an order must never be marketable', () => {
  it('passes a sale below the current point and a purchase above it', () => {
    expect(() => assertRestingPoint(400629, 400630, true)).not.toThrow()
    expect(() => assertRestingPoint(400631, 400630, false)).not.toThrow()
  })
  it('refuses a sale at or above the current point', () => {
    refused(() => assertRestingPoint(400630, 400630, true))
    refused(() => assertRestingPoint(400631, 400630, true))
  })
  it('refuses a purchase at or below the current point', () => {
    refused(() => assertRestingPoint(400630, 400630, false))
    refused(() => assertRestingPoint(400629, 400630, false))
  })
  it('stops a price that has crossed the pool, whatever the other market said', async () => {
    rpc.views[`${DCL}.get_pool`] = poolRow({ current_point: SALE_POINT - 1 })
    await expect(rheaVenue.prepare(selling(), ME)).rejects.toThrow(/Nothing was signed or sent\.$/)
    rpc.views[`${DCL}.get_pool`] = poolRow({ current_point: BUY_POINT + 1 })
    await expect(rheaVenue.prepare(buying(), ME)).rejects.toThrow(/Nothing was signed or sent\.$/)
  })
  it('asks for no storage on an order it would refuse anyway', async () => {
    firstUse()
    rpc.views[`${DCL}.get_pool`] = poolRow({ current_point: SALE_POINT })
    await expect(rheaVenue.prepare(selling(), ME)).rejects.toThrow(/Nothing was signed or sent\.$/)
  })
})

describe('first use', () => {
  it('pays for storage first, on its own, in order, then asks to be prepared again', async () => {
    firstUse()
    const prepared = await rheaVenue.prepare(selling(), ME)
    expect(prepared.thenPrepareAgain).toBe(true)
    expect(txs(prepared).map((t) => t.receiverId)).toEqual([DCL, USDC, WRAP])
    expect(txs(prepared)[0]?.actions).toEqual([
      call('storage_deposit', { account_id: ME, registration_only: true }, HALF_NEAR),
    ])
    expect(txs(prepared)[1]?.actions).toEqual([storage()])
    expect(txs(prepared)[2]?.actions).toEqual([storage()])
    expect(prepared.pay).toEqual({ amount: '0.5025', symbol: 'NEAR' })
    expect(() => rheaVenue.assertSafe(prepared.signing, ME, prepared.context)).not.toThrow()
  })

  it('walks by what the chain says, until only the order is left', async () => {
    firstUse()
    expect(txs(await rheaVenue.prepare(buying(), ME)).map((t) => t.receiverId)).toEqual([DCL, WRAP])

    rpc.views[`${DCL}.get_user_storage_detail`] = STORAGE_DETAIL
    const buyToken = await rheaVenue.prepare(buying(), ME)
    expect(txs(buyToken).map((t) => t.receiverId)).toEqual([WRAP])
    expect(buyToken.thenPrepareAgain).toBe(true)

    rpc.views[`${WRAP}.storage_balance_of`] = { total: STORAGE_DEPOSIT_YOCTO, available: '0' }
    const order = await rheaVenue.prepare(buying(), ME)
    expect(order.thenPrepareAgain).toBeUndefined()
    expect(txs(order).map((t) => t.receiverId)).toEqual([USDC])
  })

  it('wraps native NEAR before selling it, in the one token transaction', async () => {
    const prepared = await rheaVenue.prepare(selling(), ME)
    expect(prepared.thenPrepareAgain).toBeUndefined()
    expect(txs(prepared)).toEqual([sale()])
    expect(() => rheaVenue.assertSafe(prepared.signing, ME, prepared.context)).not.toThrow()
  })

  it('never carries storage and the order in one signature', async () => {
    firstUse()
    const prepared = await rheaVenue.prepare(selling(), ME)
    const methods = txs(prepared).flatMap((t) => t.actions.map((a) => a.params.methodName))
    expect(methods).not.toContain('ft_transfer_call')
    expect(methods).not.toContain('near_deposit')
  })

  it('refuses when Rhea asks for more storage than the cap', async () => {
    firstUse()
    rpc.views[`${DCL}.storage_balance_bounds`] = { min: '500000000000000000000001', max: null }
    await expect(rheaVenue.prepare(selling(), ME)).rejects.toThrow(/Nothing was signed or sent\.$/)
  })
})

describe('the order', () => {
  it('builds a purchase from exactly what was asked', async () => {
    const prepared = await rheaVenue.prepare(buying(), ME)
    expect(txs(prepared)).toEqual([buy()])
    expect(prepared.venueId).toBe('rhea-limit')
    expect(prepared.venueName).toBe('Rhea')
    expect(prepared.kind).toBe('limit')
    expect(prepared.pay).toEqual({ amount: '10', symbol: 'USDC' })
    expect(prepared.receive).toEqual({ amount: '2.564102', symbol: 'NEAR', approximate: true })
    expect(prepared.notes).toEqual(NOTES)
    expect(() => rheaVenue.assertSafe(prepared.signing, ME, prepared.context)).not.toThrow()
  })

  it('pays a sale out in USDC', async () => {
    const prepared = await rheaVenue.prepare(selling(), ME)
    expect(prepared.pay).toEqual({ amount: '1', symbol: 'NEAR' })
    expect(prepared.receive).toEqual({ amount: '4.2', symbol: 'USDC', approximate: true })
    expect(prepared.notes).toEqual(NOTES)
  })

  it.each([
    ['USDT', { tokenOut: 'USDT' }],
    ['SOL', { tokenIn: 'SOL' }],
  ])('only trades USDC and NEAR, not %s', async (_name, over) => {
    await expect(rheaVenue.prepare(selling(over), ME)).rejects.toThrow(
      /only trades NEAR against USDC\. Nothing was signed or sent\.$/
    )
  })

  it('refuses another kind of action', async () => {
    await expect(rheaVenue.prepare(selling({ kind: 'swap' }), ME)).rejects.toThrow(
      /Nothing was signed or sent\.$/
    )
  })

  it('refuses an account that is not a NEAR account', async () => {
    await expect(rheaVenue.prepare(selling(), 'NOT A NEAR ACCOUNT!')).rejects.toThrow(
      /Nothing was signed or sent\.$/
    )
  })

  it('refuses more decimals than the token has, in the same words', async () => {
    await expect(rheaVenue.prepare(buying({ amount: '1.1234567' }), ME)).rejects.toThrow(
      /decimal places at most\. Nothing was signed or sent\.$/
    )
  })

  it.each([
    ['paused', { state: 'Paused' }],
    ['with a tax', { tax: { rate: 1 } }],
    ['with another step', { point_delta: 40 }],
    ['with other tokens', { token_x: USDT }],
  ])('refuses a pool that is %s', async (_name, over) => {
    rpc.views[`${DCL}.get_pool`] = poolRow(over)
    await expect(rheaVenue.prepare(selling(), ME)).rejects.toThrow(/Nothing was signed or sent\.$/)
  })

  it('refuses while the contract is not running', async () => {
    rpc.views[`${DCL}.get_metadata`] = { state: 'Paused' }
    await expect(rheaVenue.prepare(selling(), ME)).rejects.toThrow(/Nothing was signed or sent\.$/)
  })

  it('refuses in words when NEAR cannot be read', async () => {
    rpc.down = true
    await expect(rheaVenue.prepare(selling(), ME)).rejects.toThrow(
      /I couldn’t read Rhea just now, so try again in a moment\. Nothing was signed or sent\.$/
    )
  })

  it('refuses when the account has no slot left', async () => {
    rpc.views[`${DCL}.get_user_storage_detail`] = {
      ...STORAGE_DETAIL,
      cur_order_slots: 30,
      cur_liquidity_slots: 10,
    }
    await expect(rheaVenue.prepare(selling(), ME)).rejects.toThrow(/Nothing was signed or sent\.$/)
  })

  it('refuses a second order at the same price', async () => {
    rpc.views[`${DCL}.find_order`] = OPEN_ORDER
    await expect(rheaVenue.prepare(buying(), ME)).rejects.toThrow(/Nothing was signed or sent\.$/)
  })
})

describe('assertDclOrderSafe', () => {
  it('passes each step the app builds', () => {
    expect(() => assertDclOrderSafe(payload(sale()), ME, SALE)).not.toThrow()
    expect(() => assertDclOrderSafe(payload(buy()), ME, BUY)).not.toThrow()
    expect(() =>
      assertDclOrderSafe(
        payload(
          { receiverId: DCL, actions: [storage(HALF_NEAR)] },
          { receiverId: USDC, actions: [storage()] },
          { receiverId: WRAP, actions: [storage()] }
        ),
        ME,
        SALE
      )
    ).not.toThrow()
    expect(() =>
      assertDclOrderSafe(payload({ receiverId: DCL, actions: [storage(HALF_NEAR)] }), ME, BUY)
    ).not.toThrow()
  })

  const withTransfer = (over: Record<string, unknown>, deposit = '1', gas = TG250): Action =>
    call(
      'ft_transfer_call',
      { receiver_id: DCL, amount: '10000000', msg: msg(WRAP, BUY_POINT), ...over },
      deposit,
      gas
    )
  const withMsg = (inner: Record<string, unknown>): Action =>
    withTransfer({
      msg: JSON.stringify({
        LimitOrderWithSwap: {
          client_id: '',
          pool_id: POOL,
          buy_token: WRAP,
          point: BUY_POINT,
          ...inner,
        },
      }),
    })

  it.each<[string, NearTransaction]>([
    ['another contract', buy([withTransfer({ receiver_id: 'evil.near' })])],
    ['another pool', buy([withMsg({ pool_id: `${USDC}|${WRAP}|2000` })])],
    ['another buy token', buy([withMsg({ buy_token: USDT })])],
    ['a changed amount', buy([withTransfer({ amount: '10000001' })])],
    ['a changed point', buy([withMsg({ point: BUY_POINT + 1 })])],
    ['an extra key in msg', buy([withMsg({ extra: 1 })])],
    ['a client id', buy([withMsg({ client_id: 'x' })])],
    [
      'a different kind of msg',
      buy([
        withTransfer({
          msg: JSON.stringify({ Deposit: {} }),
        }),
      ]),
    ],
    ['a msg that is not JSON', buy([withTransfer({ msg: 'not json' })])],
    ['a deposit of nothing', buy([withTransfer({}, '0')])],
    ['a deposit of more than 1 yocto', buy([withTransfer({}, '2')])],
    ['gas above 250 TGas', buy([withTransfer({}, '1', '250000000000001')])],
    ['an extra argument', buy([withTransfer({ memo: 'x' })])],
    ['a call on another token', { receiverId: USDT, actions: [withTransfer({})] }],
    ['a call on an unknown contract', { receiverId: 'evil.near', actions: [withTransfer({})] }],
    ['a wrap beside a USDC order', buy([call('near_deposit', {}, ONE_NEAR), withTransfer({})])],
    ['a second transfer', buy([withTransfer({}), withTransfer({})])],
    ['a plain transfer out', buy([call('ft_transfer', { receiver_id: THIEF, amount: '1' }, '1')])],
  ])('refuses %s', (_name, transaction) => {
    refused(() => assertDclOrderSafe(payload(transaction), ME, BUY))
  })

  it('refuses a sale that does not wrap what it sells', () => {
    refused(() => assertDclOrderSafe(payload(sale([place(ONE_NEAR, USDC, SALE_POINT)])), ME, SALE))
    refused(() =>
      assertDclOrderSafe(
        payload(sale([call('near_deposit', {}, HALF_NEAR), place(ONE_NEAR, USDC, SALE_POINT)])),
        ME,
        SALE
      )
    )
  })

  it('refuses storage above 0.5 NEAR', () => {
    refused(() =>
      assertDclOrderSafe(
        payload({ receiverId: DCL, actions: [storage('500000000000000000000001')] }),
        ME,
        BUY
      )
    )
  })

  it.each<[string, NearTransaction]>([
    ['for someone else', { receiverId: DCL, actions: [storage(HALF_NEAR, THIEF)] }],
    ['of nothing', { receiverId: DCL, actions: [storage('0')] }],
    ['on another contract', { receiverId: 'evil.near', actions: [storage()] }],
    ['on a token the order does not touch', { receiverId: USDT, actions: [storage()] }],
    [
      'beside something else',
      { receiverId: DCL, actions: [storage(HALF_NEAR), call('cancel_order', {}, '0')] },
    ],
    [
      'that is not registration only',
      {
        receiverId: DCL,
        actions: [call('storage_deposit', { account_id: ME }, HALF_NEAR)],
      },
    ],
    [
      'with too much gas',
      {
        receiverId: DCL,
        actions: [
          call(
            'storage_deposit',
            { account_id: ME, registration_only: true },
            HALF_NEAR,
            '30000000000001'
          ),
        ],
      },
    ],
    ['above the token amount', { receiverId: WRAP, actions: [storage(HALF_NEAR)] }],
  ])('refuses a storage payment %s', (_name, transaction) => {
    refused(() => assertDclOrderSafe(payload(transaction), ME, BUY))
  })

  it('refuses storage beside the order, in any order', () => {
    const paid: NearTransaction = { receiverId: DCL, actions: [storage(HALF_NEAR)] }
    refused(() => assertDclOrderSafe(payload(paid, buy()), ME, BUY))
    refused(() => assertDclOrderSafe(payload(buy(), paid), ME, BUY))
    refused(() => assertDclOrderSafe(payload(buy(), buy()), ME, BUY))
  })

  it('refuses storage out of order, or twice', () => {
    const on = (receiverId: string, deposit = STORAGE_DEPOSIT_YOCTO): NearTransaction => ({
      receiverId,
      actions: [storage(deposit)],
    })
    refused(() => assertDclOrderSafe(payload(on(USDC), on(DCL, HALF_NEAR)), ME, SALE))
    refused(() => assertDclOrderSafe(payload(on(USDC), on(USDC)), ME, SALE))
  })

  it('refuses a token this order does not sell, and a point that is not one', () => {
    refused(() => assertDclOrderSafe(payload(buy()), ME, { ...BUY, sellToken: USDT }))
    refused(() => assertDclOrderSafe(payload(buy()), ME, { ...BUY, point: BUY_POINT + 0.5 }))
  })

  it('refuses another family, a bad account, and no transactions', () => {
    refused(() =>
      assertDclOrderSafe({ family: 'solana', transaction: 'AAAA' } as SigningPayload, ME, BUY)
    )
    refused(() => assertDclOrderSafe(payload(buy()), 'NOT A NEAR ACCOUNT!', BUY))
    refused(() => assertDclOrderSafe(payload(), ME, BUY))
  })

  it('refuses a transaction with another shape', () => {
    const odd = { ...buy(), signerId: THIEF } as NearTransaction
    refused(() => assertDclOrderSafe(payload(odd), ME, BUY))
  })
})

describe('ft_transfer_call stays refused everywhere else', () => {
  it.each<[string, (p: SigningPayload) => void]>([
    ['1Click', (p) => assertOneClickSafe(p, ME)],
    ['a token transfer', (p) => assertTokenTransferSafe(p, ME, /^.*$/)],
    ['rNEAR', (p) => assertRnearSafe(p, ME)],
    ['Meta Pool', (p) => assertMetapoolSafe(p, ME)],
  ])('%s refuses a Rhea order', (_name, check) => {
    expect(() => check(payload(buy()))).toThrow(ChainActionRefused)
    expect(() => check(payload(sale()))).toThrow(ChainActionRefused)
  })
})

describe('assertDclExitSafe', () => {
  const exit = (actions: Action[], receiverId = DCL): SigningPayload =>
    payload({ receiverId, actions })
  const cancel = (
    args: Record<string, unknown> = { order_id: ORDER, amount: '10000000' },
    deposit = '0',
    gas = TG180
  ): Action => call('cancel_order', args, deposit, gas)

  it('passes a cancel and a collect', () => {
    expect(() => assertDclExitSafe(exit([cancel()]), ME, ORDER)).not.toThrow()
    expect(() =>
      assertDclExitSafe(exit([cancel({ order_id: ORDER, amount: '0' })]), ME, ORDER)
    ).not.toThrow()
  })

  it.each<[string, SigningPayload]>([
    ['another contract', exit([cancel()], 'evil.near')],
    ['another order', exit([cancel({ order_id: `${POOL}#1`, amount: '0' })])],
    ['a deposit', exit([cancel(undefined, '1')])],
    ['gas above 180 TGas', exit([cancel(undefined, '0', '180000000000001')])],
    ['an extra argument', exit([cancel({ order_id: ORDER, amount: '0', skip_unwrap_near: true })])],
    ['no amount', exit([cancel({ order_id: ORDER })])],
    ['an amount that is not one', exit([cancel({ order_id: ORDER, amount: '-1' })])],
    ['another method', exit([call('storage_withdraw', {}, '1', TG180)])],
    ['a second call', exit([cancel(), cancel()])],
    [
      'a second transaction',
      payload({ receiverId: DCL, actions: [cancel()] }, { receiverId: DCL, actions: [cancel()] }),
    ],
  ])('refuses %s', (_name, signing) => {
    refused(() => assertDclExitSafe(signing, ME, ORDER))
  })

  it('refuses an order on another pool, even when it is the one named', () => {
    const other = `${USDC}|${WRAP}|2000#1`
    refused(() => assertDclExitSafe(exit([cancel({ order_id: other, amount: '0' })]), ME, other))
  })
})

describe('openOrders', () => {
  it('reads what rests, and only on this pool', async () => {
    rpc.views[`${DCL}.list_active_orders`] = [
      OPEN_ORDER,
      { ...OPEN_ORDER, order_id: `${USDT}|${WRAP}|100#1`, pool_id: `${USDT}|${WRAP}|100` },
    ]
    const rows = await rheaBook().openOrders(ME)
    expect(rows).toEqual([
      {
        id: ORDER,
        venueId: 'rhea-limit',
        tokenIn: 'USDC',
        tokenOut: 'NEAR',
        amountIn: '10',
        remainingIn: '10',
        receivedOut: '0',
        limitPrice: '3.89984',
        status: 'open',
      },
    ])
  })

  it('marks what waits to be collected', async () => {
    rpc.views[`${DCL}.list_active_orders`] = [
      {
        ...OPEN_ORDER,
        remain_amount: '4000000',
        bought_amount: ONE_NEAR,
        unclaimed_amount: ONE_NEAR,
      },
    ]
    const [row] = await rheaBook().openOrders(ME)
    expect(row?.status).toBe('partly')
    expect(row?.remainingIn).toBe('4')
    expect(row?.receivedOut).toBe('1')
    expect(row?.collectable).toEqual([{ amount: '1', symbol: 'NEAR' }])
    expect(row?.note).toMatch(/Collect/)
  })

  it('shows a filled order as filled, with its money still to collect', async () => {
    rpc.views[`${DCL}.list_active_orders`] = [
      {
        ...OPEN_ORDER,
        sell_token: WRAP,
        buy_token: USDC,
        original_amount: ONE_NEAR,
        remain_amount: '0',
        bought_amount: '4200000',
        unclaimed_amount: '4200000',
      },
    ]
    const [row] = await rheaBook().openOrders(ME)
    expect(row?.status).toBe('filled')
    expect(row?.tokenIn).toBe('NEAR')
    expect(row?.tokenOut).toBe('USDC')
    expect(row?.collectable).toEqual([{ amount: '4.2', symbol: 'USDC' }])
  })

  it('collects nothing where the chain says null', async () => {
    rpc.views[`${DCL}.list_active_orders`] = [{ ...OPEN_ORDER, unclaimed_amount: null }]
    const [row] = await rheaBook().openOrders(ME)
    expect(row?.collectable).toBeUndefined()
  })

  it('answers an account with nothing as nothing', async () => {
    rpc.views[`${DCL}.list_active_orders`] = []
    expect(await rheaBook().openOrders(ME)).toEqual([])
  })

  it('refuses an account that is not a NEAR account', async () => {
    await expect(rheaBook().openOrders('NOT A NEAR ACCOUNT!')).rejects.toThrow(ChainActionRefused)
  })
})

describe('prepareExit', () => {
  it('cancels with the remaining amount, no deposit, and 180 TGas', async () => {
    const prepared = await rheaBook().prepareExit(ME, ORDER, 'cancel')
    expect(txs(prepared)).toEqual([
      {
        receiverId: DCL,
        actions: [call('cancel_order', { order_id: ORDER, amount: '10000000' }, '0', TG180)],
      },
    ])
    expect(prepared.venueId).toBe('rhea-limit')
    expect(prepared.pay).toEqual({ amount: '0', symbol: 'USDC' })
    expect(prepared.receive).toEqual({ amount: '10', symbol: 'USDC', approximate: true })
    expect(() => rheaVenue.assertSafe(prepared.signing, ME, prepared.context)).not.toThrow()
  })

  it('collects with an amount of zero', async () => {
    rpc.views[`${DCL}.get_order`] = {
      ...OPEN_ORDER,
      remain_amount: '4000000',
      bought_amount: ONE_NEAR,
      unclaimed_amount: ONE_NEAR,
    }
    const prepared = await rheaBook().prepareExit(ME, ORDER, 'collect')
    expect(txs(prepared)).toEqual([
      {
        receiverId: DCL,
        actions: [call('cancel_order', { order_id: ORDER, amount: '0' }, '0', TG180)],
      },
    ])
    expect(prepared.receive).toEqual({ amount: '1', symbol: 'NEAR', approximate: true })
    expect(() => rheaVenue.assertSafe(prepared.signing, ME, prepared.context)).not.toThrow()
  })

  it('refuses an order that belongs to another wallet', async () => {
    await expect(rheaBook().prepareExit(THIEF, ORDER, 'cancel')).rejects.toThrow(
      /belongs to another wallet\. Nothing was signed or sent\.$/
    )
    await expect(rheaBook().prepareExit(THIEF, ORDER, 'collect')).rejects.toThrow(
      /belongs to another wallet\. Nothing was signed or sent\.$/
    )
  })

  it.each([
    'not-an-order',
    `${USDT}|${WRAP}|100#1`,
    `${USDC}|${WRAP}|2000#1`,
    `${POOL}#`,
    `${POOL}#1#2`,
    `${POOL}#abc`,
  ])('refuses %s', async (orderId) => {
    await expect(rheaBook().prepareExit(ME, orderId, 'cancel')).rejects.toThrow(
      /Nothing was signed or sent\.$/
    )
  })

  it('refuses an order the chain no longer has', async () => {
    rpc.views[`${DCL}.get_order`] = null
    await expect(rheaBook().prepareExit(ME, ORDER, 'cancel')).rejects.toThrow(
      /no longer open\. Nothing was signed or sent\.$/
    )
  })

  it('refuses a cancel of a filled order, and says to collect', async () => {
    rpc.views[`${DCL}.get_order`] = {
      ...OPEN_ORDER,
      remain_amount: '0',
      bought_amount: ONE_NEAR,
      unclaimed_amount: ONE_NEAR,
    }
    await expect(rheaBook().prepareExit(ME, ORDER, 'cancel')).rejects.toThrow(/Collect/)
  })

  it('refuses a collect with nothing to collect', async () => {
    await expect(rheaBook().prepareExit(ME, ORDER, 'collect')).rejects.toThrow(
      /nothing to collect yet\. Nothing was signed or sent\.$/
    )
  })

  it('refuses in words when the order cannot be read', async () => {
    rpc.down = true
    await expect(rheaBook().prepareExit(ME, ORDER, 'cancel')).rejects.toThrow(
      /Nothing was signed or sent\.$/
    )
  })
})

describe('assertSafe', () => {
  it('fails closed without what prepare issued', async () => {
    const prepared = await rheaVenue.prepare(buying(), ME)
    refused(() => rheaVenue.assertSafe(prepared.signing, ME))
    refused(() => rheaVenue.assertSafe(prepared.signing, ME, {}))
    refused(() =>
      rheaVenue.assertSafe(prepared.signing, ME, { ...prepared.context, point: 'twelve' })
    )
  })

  it('holds a cancel to its own order', async () => {
    const prepared = await rheaBook().prepareExit(ME, ORDER, 'cancel')
    refused(() => rheaVenue.assertSafe(prepared.signing, ME, { orderId: `${POOL}#1` }))
    refused(() => rheaVenue.assertSafe(prepared.signing, ME, { ...prepared.context, orderId: '' }))
  })

  it('does not let a cancel pass as an order, or an order as a cancel', async () => {
    const order = await rheaVenue.prepare(buying(), ME)
    const exit = await rheaBook().prepareExit(ME, ORDER, 'cancel')
    refused(() => rheaVenue.assertSafe(exit.signing, ME, order.context))
    refused(() => rheaVenue.assertSafe(order.signing, ME, exit.context))
  })
})

describe('the reserve', () => {
  const holding = (amount: string): ChainModule => ({
    ...nearModule,
    priceUsd: async () => 4,
    balances: async () => ({
      tokens: [{ symbol: 'NEAR', id: 'near', amount, decimals: 24, native: true, listed: true }],
      complete: true,
    }),
  })

  it('keeps back first-use storage for an account with no record', async () => {
    firstUse()
    await expect(assertNativeReserve(holding('0.3'), buying(), ME)).rejects.toThrow(
      /Keep about 0\.55125 NEAR for network fees and the 0\.50125 NEAR this order costs to set up/
    )
  })

  it('keeps it back on top of what a sale spends', async () => {
    firstUse()
    await expect(assertNativeReserve(holding('1.3'), selling(), ME)).rejects.toThrow(
      /You can spend up to 0\.7475 NEAR here\. Nothing was signed or sent\.$/
    )
  })

  it('counts only the storage still owed', async () => {
    rpc.views[`${USDC}.storage_balance_of`] = null
    await expect(
      assertNativeReserve(holding('0.05'), selling({ amount: '0.001' }), ME)
    ).rejects.toThrow(/0\.00125 NEAR this order costs to set up/)
  })

  it('keeps nothing back once the account has its record', async () => {
    await expect(assertNativeReserve(holding('0.3'), buying(), ME)).resolves.toBeUndefined()
    await expect(assertNativeReserve(holding('1.3'), selling(), ME)).resolves.toBeUndefined()
  })

  it('still keeps the fee reserve on a sale', async () => {
    await expect(assertNativeReserve(holding('1.01'), selling(), ME)).rejects.toThrow(
      /Keep about 0\.05 NEAR for network fees/
    )
  })

  it('leaves a failed read to prepare, which refuses', async () => {
    rpc.downViews = [`${DCL}.get_user_storage_detail`]
    await expect(assertNativeReserve(holding('0.3'), buying(), ME)).resolves.toBeUndefined()
    await expect(rheaVenue.prepare(buying(), ME)).rejects.toThrow(/Nothing was signed or sent\.$/)
  })

  it('does not wait on a slow read of what is owed, and leaves it to prepare', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => undefined))
    )
    const answer = assertNativeReserve(holding('0.3'), buying(), ME)
    await vi.advanceTimersByTimeAsync(3_000)
    await expect(answer).resolves.toBeUndefined()
  })

  it('names the most first use can cost, for anyone showing it before an account is known', () => {
    expect(rheaVenue.limitCost).toEqual({ amount: '0.5', symbol: 'NEAR' })
  })
})

describe('what the wallet holds', () => {
  const row = (symbol: string, id: string, amount: string, decimals: number, native = false) => ({
    symbol,
    id,
    amount,
    decimals,
    native,
    listed: true,
  })
  const near = (amount: string) => row('NEAR', 'near', amount, 24, true)
  const wnear = (amount: string) => row('wNEAR', WRAP, amount, 24)
  const usdc = (amount: string) => row('USDC', USDC, amount, 6)
  const spy = vi.fn()
  const holding = (...tokens: ReturnType<typeof row>[]): ChainModule => ({
    ...nearModule,
    venues: nearModule.venues.map((v) => (v.id === 'rhea-limit' ? { ...v, prepare: spy } : v)),
    priceUsd: async () => 4,
    balances: async () => ({ tokens, complete: true }),
  })

  beforeEach(() => {
    spy.mockReset()
    firstUse()
  })

  it('stops a purchase with no USDC before it can pay for storage', async () => {
    await expect(
      prepareChainAction(holding(near('1'), wnear('0'), usdc('0')), buying(), ME)
    ).rejects.toThrow('You hold 0 USDC, and this order needs 10. Nothing was signed or sent.')
    expect(spy).not.toHaveBeenCalled()
  })

  it('counts NEAR and wNEAR together on a sale', async () => {
    await expect(
      assertLimitCanRun(holding(near('0.3'), wnear('0.3'), usdc('0')), selling(), ME)
    ).rejects.toThrow('You hold 0.6 NEAR, and this order needs 1. Nothing was signed or sent.')
    await expect(
      assertLimitCanRun(holding(near('0.6'), wnear('0.6'), usdc('0')), selling(), ME)
    ).resolves.toBeUndefined()
  })

  it('does not count wNEAR or NEAR toward USDC', async () => {
    await expect(
      assertLimitCanRun(holding(near('100'), wnear('100'), usdc('9')), buying(), ME)
    ).rejects.toThrow('You hold 9 USDC, and this order needs 10. Nothing was signed or sent.')
  })
})

describe('submit', () => {
  const encoded = (args: Record<string, unknown>): string =>
    Buffer.from(JSON.stringify(args)).toString('base64')

  function executed(
    receiver: string,
    calls: { method: string; args: Record<string, unknown>; deposit?: string }[],
    over: { signer?: string; status?: Record<string, unknown> } = {}
  ): unknown {
    return {
      status: over.status ?? { SuccessValue: '' },
      transaction: {
        signer_id: over.signer ?? ME,
        receiver_id: receiver,
        actions: calls.map((c) => ({
          FunctionCall: {
            method_name: c.method,
            args: encoded(c.args),
            deposit: c.deposit ?? '0',
          },
        })),
      },
    }
  }

  const placed = (point = BUY_POINT): unknown =>
    executed(USDC, [
      {
        method: 'ft_transfer_call',
        args: { receiver_id: DCL, amount: '10000000', msg: msg(WRAP, point) },
        deposit: '1',
      },
    ])
  const stored = (receiver = DCL): unknown =>
    executed(receiver, [
      { method: 'storage_deposit', args: { account_id: ME, registration_only: true } },
    ])
  const send = (hashes: string[]) =>
    rheaVenue.submit?.({
      account: ME,
      venueId: 'rhea-limit',
      signed: { family: 'near', hashes },
    })

  const FAILURE = { Failure: { ActionError: {} } }

  it('confirms storage, on every hash, and hands back the last', async () => {
    rpc.tx = { [HASH]: stored(), [HASH_2]: stored(WRAP) }
    expect(await send([HASH, HASH_2])).toEqual({
      ok: true,
      hash: HASH_2,
      explorerUrl: `https://nearblocks.io/txns/${HASH_2}`,
    })
  })

  it('confirms an order once it can be seen resting', async () => {
    rpc.tx = { [HASH]: placed() }
    rpc.views[`${DCL}.find_order`] = OPEN_ORDER
    expect(await send([HASH])).toMatchObject({ ok: true, hash: HASH })
  })

  it('does not call a transaction a resting order until the order is there', async () => {
    vi.useFakeTimers()
    rpc.tx = { [HASH]: placed() }
    const answer = send([HASH])
    await vi.advanceTimersByTimeAsync(60_000)
    const result = await answer
    expect(result).toMatchObject({ ok: false, pending: true })
    expect(result && 'error' in result ? result.error : '').toMatch(/can.t see/)
  })

  it('confirms a cancel', async () => {
    rpc.tx = {
      [HASH]: executed(DCL, [
        { method: 'cancel_order', args: { order_id: ORDER, amount: '10000000' } },
      ]),
    }
    expect(await send([HASH])).toMatchObject({ ok: true, hash: HASH })
  })

  it('says a failed setup step cost only gas, and lets it be tried again', async () => {
    rpc.tx = {
      [HASH]: executed(
        DCL,
        [{ method: 'storage_deposit', args: { account_id: ME, registration_only: true } }],
        { status: FAILURE }
      ),
    }
    const result = await send([HASH])
    expect(result).toMatchObject({ ok: false })
    expect(result).not.toHaveProperty('pending')
  })

  it('reads a failed order as something to check, not as nothing moved', async () => {
    rpc.tx = {
      [HASH]: executed(
        USDC,
        [
          {
            method: 'ft_transfer_call',
            args: { receiver_id: DCL, amount: '10000000', msg: msg(WRAP, BUY_POINT) },
          },
        ],
        { status: FAILURE }
      ),
    }
    expect(await send([HASH])).toMatchObject({ ok: false, pending: true })
  })

  it.each<[string, () => unknown]>([
    [
      'another signer',
      () =>
        executed(DCL, [{ method: 'cancel_order', args: { order_id: ORDER } }], { signer: THIEF }),
    ],
    ['another contract', () => executed('evil.near', [{ method: 'storage_deposit', args: {} }])],
    ['another method', () => executed(DCL, [{ method: 'storage_withdraw', args: {} }])],
    [
      'another pool',
      () =>
        executed(DCL, [{ method: 'cancel_order', args: { order_id: `${USDT}|${WRAP}|100#1` } }]),
    ],
    [
      'a transfer to someone else',
      () =>
        executed(USDC, [
          {
            method: 'ft_transfer_call',
            args: { receiver_id: 'evil.near', msg: msg(WRAP, BUY_POINT) },
          },
        ]),
    ],
    [
      'an order on another pool',
      () =>
        executed(USDC, [
          {
            method: 'ft_transfer_call',
            args: {
              receiver_id: DCL,
              msg: JSON.stringify({
                LimitOrderWithSwap: { pool_id: `${USDT}|${WRAP}|100`, point: 1 },
              }),
            },
          },
        ]),
    ],
    [
      'a msg that is not JSON',
      () =>
        executed(USDC, [{ method: 'ft_transfer_call', args: { receiver_id: DCL, msg: 'nope' } }]),
    ],
  ])('will not report %s as this order', async (_name, outcome) => {
    rpc.tx = { [HASH]: outcome() }
    expect(await send([HASH])).toMatchObject({ ok: false, pending: true })
  })

  it('waits, then says not to send again, when NEAR has not seen it', async () => {
    vi.useFakeTimers()
    const answer = send([HASH])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await answer).toMatchObject({ ok: false, pending: true })
  })

  it('reads a malformed hash, or none, as pending', async () => {
    expect(await send(['bad'])).toMatchObject({ ok: false, pending: true })
    expect(await send([])).toMatchObject({ ok: false, pending: true })
  })

  it('refuses another family', async () => {
    expect(
      await rheaVenue.submit?.({
        account: ME,
        venueId: 'rhea-limit',
        signed: { family: 'evm', hash: '0x1' },
      })
    ).toEqual({ ok: false, error: 'That is not a NEAR transaction.' })
  })
})

describe('wiring', () => {
  it('is the limit venue on NEAR, and carries the book', () => {
    expect(nearModule.defaultVenue.limit).toBe('rhea-limit')
    expect(nearModule.limitBook).toBeDefined()
    const venue = nearModule.venues.find((v) => v.id === 'rhea-limit')
    expect(venue?.name).toBe('Rhea')
    expect(venue?.kinds).toEqual(['limit'])
  })

  it('claims what it does on the Apps list, and for help', () => {
    const row = nearVenues.find((v) => v.id === 'rhea-limit')
    expect(row?.integration).toBe('executes')
    expect(row?.category).toBe('orderbook')
    expect(nearCapabilities).toContainEqual({ kind: 'limit', venue: 'Rhea', symbol: 'NEAR' })
  })

  it('changes nothing about who answers for the other kinds', () => {
    expect(nearModule.defaultVenue.swap).toBe('1click')
    expect(nearModule.defaultVenue.stake).toBe('metapool')
    expect(nearModule.defaultVenue.supply).toBe('1click-earn')
  })
})
