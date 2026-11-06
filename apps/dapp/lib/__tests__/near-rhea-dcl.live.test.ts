import { describe, expect, it } from 'vitest'

import { rheaBook, rheaVenue } from '../chains/near/rhea-dcl'
import {
  DCL_CONTRACT,
  DCL_POOL,
  DCL_STORAGE_CAP,
  pointForPrice,
  priceAtPoint,
} from '../chains/near/rhea-dcl-rules'
import { viewCall } from '../chains/near/rpc'
import { USDC_NEAR, WRAP_NEAR } from '../chains/near/tokens'
import type { ChainActionRequest, NearTransaction, SigningPayload } from '../chains/types'

/**
 * Against mainnet, reading only: NEAR has no simulation for a contract call that changes state, so
 * nothing here runs a transaction. Each account named is public, and its key isn't held here. Run by
 * this exact file name.
 */

/** A Ref operator, with an order resting far from the market since February 2026. */
const OWNER = 'doublerose.near'
const ORDER = `${DCL_POOL}#8665`
const ORDER_POINT = 415439
const STRANGER = 'nobody-has-this-account-at-all.near'
const SLOW_MS = 60_000

interface PoolRow {
  token_x: string
  token_y: string
  fee: number
  point_delta: number
  current_point: number
  state: string
  tax: unknown
}

interface OrderRow {
  order_id: string
  owner_id: string
  pool_id: string
  point: number
  sell_token: string
  buy_token: string
  original_amount: string
  remain_amount: string
  bought_amount: string
  unclaimed_amount: string | null
}

const view = <T>(method: string, args: Record<string, unknown>): Promise<T> =>
  viewCall<T>(DCL_CONTRACT, method, args)
const readPool = (): Promise<PoolRow> => view<PoolRow>('get_pool', { pool_id: DCL_POOL })

const txs = (signing: SigningPayload): NearTransaction[] =>
  (signing as Extract<SigningPayload, { family: 'near' }>).transactions

describe.skipIf(process.env['SKIP_LIVE'] === '1')('Rhea DCL on mainnet', () => {
  it(
    'has the pool the rules are pinned to',
    async () => {
      const pool = await readPool()
      console.log('pool', pool)
      expect(pool.token_x).toBe(USDC_NEAR)
      expect(pool.token_y).toBe(WRAP_NEAR)
      expect(pool.fee).toBe(100)
      expect(pool.point_delta).toBe(1)
      expect(pool.state).toBe('Running')
      expect(pool.tax).toBeNull()
      const metadata = await view<{ state: string; version: string }>('get_metadata', {})
      console.log('metadata', metadata)
      expect(metadata.state).toBe('Running')
    },
    SLOW_MS
  )

  it(
    'reads a real order through get_order, with every field the venue relies on',
    async () => {
      const order = await view<OrderRow>('get_order', { order_id: ORDER })
      console.log('order', order)
      expect(order.order_id).toBe(ORDER)
      expect(order.owner_id).toBe(OWNER)
      expect(order.pool_id).toBe(DCL_POOL)
      expect(order.point).toBe(ORDER_POINT)
      expect(order.sell_token).toBe(USDC_NEAR)
      expect(order.buy_token).toBe(WRAP_NEAR)
      for (const field of ['original_amount', 'remain_amount', 'bought_amount']) {
        expect(order[field as keyof OrderRow]).toMatch(/^\d+$/)
      }
      expect(order.unclaimed_amount).toMatch(/^\d+$/)
      expect(await view('get_order', { order_id: `${DCL_POOL}#1` })).toBeNull()
      expect(
        await view('find_order', {
          account_id: OWNER,
          pool_id: DCL_POOL,
          point: ORDER_POINT,
        })
      ).toMatchObject({ order_id: ORDER })
      expect(
        await view('find_order', {
          account_id: OWNER,
          pool_id: DCL_POOL,
          point: ORDER_POINT + 1,
        })
      ).toBeNull()
    },
    SLOW_MS
  )

  it(
    'finds no sign flip: on this pool a buy of NEAR rests above the market and a sale below it',
    async () => {
      const pool = await readPool()
      const market = priceAtPoint(pool.current_point)
      console.log('market', { point: pool.current_point, usdcPerNear: market })
      expect(ORDER_POINT).toBeGreaterThan(pool.current_point)
      const price = priceAtPoint(ORDER_POINT)
      console.log('order price', price)
      expect(Math.abs(pointForPrice(price * 1.000001, false, 1) - ORDER_POINT)).toBeLessThan(10)

      const book = await view<Record<string, { amount_x: string; amount_y: string }>>(
        'get_pointorder_range',
        {
          pool_id: DCL_POOL,
          left_point: pool.current_point - 2000,
          right_point: pool.current_point + 2000,
        }
      )
      const entries = Object.entries(book).map(([point, side]) => ({
        point: Number(point),
        sellsUsdc: BigInt(side.amount_x) > BigInt(0),
        sellsNear: BigInt(side.amount_y) > BigInt(0),
      }))
      console.log('book', entries)
      expect(entries.length).toBeGreaterThan(0)
      // Read at one finality and the pool at another, so the market point itself proves nothing.
      for (const { point, sellsUsdc, sellsNear } of entries) {
        if (point === pool.current_point) continue
        if (sellsNear) expect(point).toBeLessThan(pool.current_point + 50)
        if (sellsUsdc) expect(point).toBeGreaterThan(pool.current_point - 50)
      }
    },
    SLOW_MS
  )

  it(
    'reads storage: a record for a real user, nothing for a stranger, and a bound under the cap',
    async () => {
      const detail = await view<Record<string, unknown>>('get_user_storage_detail', {
        user_id: OWNER,
      })
      console.log('storage', detail)
      for (const field of ['max_slots', 'cur_order_slots', 'cur_liquidity_slots']) {
        expect(typeof detail[field]).toBe('number')
      }
      expect(await view('get_user_storage_detail', { user_id: STRANGER })).toBeNull()
      const bounds = await view<{ min: string }>('storage_balance_bounds', {})
      console.log('bounds', bounds)
      expect(BigInt(bounds.min) <= DCL_STORAGE_CAP).toBe(true)
    },
    SLOW_MS
  )

  const away = async (above: boolean): Promise<string> => {
    const { current_point: point } = await readPool()
    const price = priceAtPoint(point) * (above ? 1.05 : 0.95)
    return price.toFixed(4)
  }

  it(
    'builds an order for an account with its record, which passes its own check',
    async () => {
      const requests: ChainActionRequest[] = [
        {
          kind: 'limit',
          amount: '1',
          tokenIn: 'NEAR',
          tokenOut: 'USDC',
          limitPrice: await away(true),
        },
        {
          kind: 'limit',
          amount: '2',
          tokenIn: 'USDC',
          tokenOut: 'NEAR',
          limitPrice: await away(false),
        },
      ]
      for (const request of requests) {
        const prepared = await rheaVenue.prepare(request, OWNER)
        console.log(prepared.summary, prepared.context)
        console.log(JSON.stringify(txs(prepared.signing)))
        rheaVenue.assertSafe(prepared.signing, OWNER, prepared.context)
        expect(prepared.thenPrepareAgain).toBeUndefined()
        expect(txs(prepared.signing)).toHaveLength(1)
      }
    },
    SLOW_MS
  )

  it(
    'asks a stranger to set up first, and nothing else',
    async () => {
      const prepared = await rheaVenue.prepare(
        {
          kind: 'limit',
          amount: '2',
          tokenIn: 'USDC',
          tokenOut: 'NEAR',
          limitPrice: await away(false),
        },
        STRANGER
      )
      console.log(prepared.summary, JSON.stringify(txs(prepared.signing)))
      expect(prepared.thenPrepareAgain).toBe(true)
      expect(txs(prepared.signing).map((t) => t.receiverId)).toEqual([DCL_CONTRACT, WRAP_NEAR])
      rheaVenue.assertSafe(prepared.signing, STRANGER, prepared.context)
    },
    SLOW_MS
  )

  it(
    'refuses a price past the pool, whichever side',
    async () => {
      const refusal = (request: ChainActionRequest) =>
        rheaVenue.prepare(request, OWNER).then(
          () => undefined,
          (e: unknown) => (e instanceof Error ? e.message : String(e))
        )
      const sale = await refusal({
        kind: 'limit',
        amount: '1',
        tokenIn: 'NEAR',
        tokenOut: 'USDC',
        limitPrice: await away(false),
      })
      const purchase = await refusal({
        kind: 'limit',
        amount: '2',
        tokenIn: 'USDC',
        tokenOut: 'NEAR',
        limitPrice: await away(true),
      })
      console.log(sale, purchase)
      expect(sale).toMatch(/fill at once.*Nothing was signed or sent\.$/)
      expect(purchase).toMatch(/fill at once.*Nothing was signed or sent\.$/)
    },
    SLOW_MS
  )

  it(
    'lists a real order, builds its cancel, and refuses it to anyone else',
    async () => {
      const rows = await rheaBook().openOrders(OWNER)
      console.log('rows', rows)
      expect(rows.map((r) => r.id)).toContain(ORDER)
      const prepared = await rheaBook().prepareExit(OWNER, ORDER, 'cancel')
      console.log(prepared.summary, JSON.stringify(txs(prepared.signing)))
      rheaVenue.assertSafe(prepared.signing, OWNER, prepared.context)
      await expect(rheaBook().prepareExit(STRANGER, ORDER, 'cancel')).rejects.toThrow(
        /belongs to another wallet/
      )
      expect(await rheaBook().openOrders(STRANGER)).toEqual([])
    },
    SLOW_MS
  )
})
