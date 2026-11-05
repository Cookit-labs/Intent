import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { nearModule } from '../chains/near/module'
import { confirmRheaLend, rheaLendVenue } from '../chains/near/rhea-lend'
import { rheaDexListing, rheaLendListing } from '../chains/near/rhea-listing'
import {
  assertRheaDexSafe,
  assertRheaLendSafe,
  RHEA_DEX,
  RHEA_LEND,
  RHEA_LEND_STORAGE_YOCTO,
} from '../chains/near/rhea-safety'
import { confirmRheaDex, rheaDexVenue } from '../chains/near/rhea-swap'
import { USDC_NEAR, USDT_NEAR, WRAP_NEAR } from '../chains/near/tokens'
import { prepareChainAction } from '../chains/prepare'
import {
  ChainActionRefused,
  type ChainActionRequest,
  type ChainModule,
  type NearTransaction,
  type PreparedAction,
  type SigningPayload,
} from '../chains/types'

const ME = 'alice.near'
const THEM = 'mallory.near'
const HASH = 'G6RQqbkHNF1JVMwmq9BiLnZ3vvUeYoNm7z4dYVEKgScA'
const HASH2 = 'H6RQqbkHNF1JVMwmq9BiLnZ3vvUeYoNm7z4dYVEKgScB'
const STORAGE = '1250000000000000000000'
const ONE_NEAR = BigInt('1000000000000000000000000')
const NEAR_ID = 'c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750'
const USDC_ID = 'eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a'
const USDT_ID = '2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b'

const dollars = (n: number): string => `${n}000000`
const inner18 = (n: number): string => (BigInt(n) * BigInt(10) ** BigInt(18)).toString()
const yocto = (n: number): string => (BigInt(n) * ONE_NEAR).toString()

type View = (args: Record<string, unknown>) => unknown

interface Rpc {
  views: Record<string, View>
  down: boolean
  tx: ((hash: string) => unknown) | undefined
}

let rpc: Rpc
let quotes: Record<number, string | undefined>
let account: unknown
let assets: Record<string, Record<string, unknown>>

function asset(token: string, ratio: number, extra: number): Record<string, unknown> {
  const unit = token === WRAP_NEAR ? ONE_NEAR : BigInt(10) ** BigInt(18)
  return {
    token_id: token,
    supplied: { balance: (BigInt(1_000_000) * unit).toString() },
    borrowed: { balance: (BigInt(800_000) * unit).toString() },
    margin_debt: { balance: '0' },
    margin_pending_debt: '0',
    reserved: '0',
    prot_fee: '0',
    supply_apr: '0.0985',
    borrow_apr: '0.1524',
    config: {
      extra_decimals: extra,
      volatility_ratio: ratio,
      can_deposit: true,
      can_withdraw: true,
      can_use_as_collateral: true,
      can_borrow: true,
      supplied_limit: null,
      borrowed_limit: null,
      min_borrowed_amount: '1000',
    },
  }
}

function pool(tokens: string[], fee = 30): Record<string, unknown> {
  return { token_account_ids: tokens, amounts: ['1', '1'], total_fee: fee }
}

const POOLS: Record<number, Record<string, unknown>> = {
  4512: pool([USDC_NEAR, WRAP_NEAR]),
  5515: pool([WRAP_NEAR, USDC_NEAR]),
  6063: pool([WRAP_NEAR, USDT_NEAR]),
  6416: pool([USDT_NEAR, USDC_NEAR], 1),
  4179: pool([USDT_NEAR, USDC_NEAR, 'dac.factory.bridge.near', 'a0b.factory.bridge.near'], 2),
}

function baseViews(): Record<string, View> {
  const balance = (): string => dollars(1000)
  const registered = (): unknown => ({ total: STORAGE, available: '0' })
  return {
    [`${RHEA_DEX}.metadata`]: () => ({ state: 'Running' }),
    [`${RHEA_DEX}.get_frozenlist_tokens`]: () => [],
    [`${RHEA_DEX}.get_pool_by_ids`]: ({ pool_ids }) =>
      (pool_ids as number[]).map((id) => POOLS[id]),
    [`${RHEA_DEX}.get_return`]: ({ pool_id }) => {
      const out = quotes[pool_id as number]
      if (out === undefined) throw new Error('no quote')
      return out
    },
    [`${RHEA_DEX}.get_deposits`]: () => ({}),
    [`${RHEA_DEX}.list_lostfound_tokens`]: () => ({}),
    [`${RHEA_LEND}.get_config`]: () => ({
      contract_mode: 'Running',
      enable_pyth_oracle: true,
      pyth_oracle_account_id: 'aggregate-oracle.near',
    }),
    [`${RHEA_LEND}.get_account_all_positions`]: () => account,
    [`${RHEA_LEND}.get_asset`]: ({ token_id }) => assets[token_id as string],
    [`${RHEA_LEND}.storage_balance_of`]: registered,
    [`${RHEA_LEND}.get_all_token_pyth_infos`]: () => ({
      [WRAP_NEAR]: {
        decimals: 24,
        fraction_digits: 4,
        price_identifier: NEAR_ID,
        extra_call: null,
        default_price: null,
      },
      [USDC_NEAR]: {
        decimals: 6,
        fraction_digits: 4,
        price_identifier: USDC_ID,
        extra_call: null,
        default_price: null,
      },
      [USDT_NEAR]: {
        decimals: 6,
        fraction_digits: 4,
        price_identifier: USDT_ID,
        extra_call: null,
        default_price: null,
      },
    }),
    'aggregate-oracle.near.get_price_no_older_than': ({ price_id }) => ({
      price: price_id === NEAR_ID ? '400000000' : '100000000',
      expo: -8,
    }),
    [`${WRAP_NEAR}.storage_balance_of`]: registered,
    [`${USDC_NEAR}.storage_balance_of`]: registered,
    [`${USDT_NEAR}.storage_balance_of`]: registered,
    [`${WRAP_NEAR}.ft_balance_of`]: () => '0',
    [`${USDC_NEAR}.ft_balance_of`]: balance,
    [`${USDT_NEAR}.ft_balance_of`]: balance,
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
          account_id?: string
          method_name?: string
          args_base64?: string
          tx_hash?: string
        }
      }
      if (body.method === 'tx') {
        const result = rpc.tx?.(body.params.tx_hash as string)
        return json(
          result === undefined ? { error: { cause: { name: 'UNKNOWN_TRANSACTION' } } } : { result }
        )
      }
      const view = rpc.views[`${body.params.account_id}.${body.params.method_name}`]
      if (view === undefined) return json({ result: { error: 'no such view' } })
      const args = JSON.parse(
        Buffer.from(body.params.args_base64 as string, 'base64').toString('utf8')
      ) as Record<string, unknown>
      try {
        return json({ result: { result: [...Buffer.from(JSON.stringify(view(args)))] } })
      } catch {
        return json({ result: { error: 'wasm execution failed' } })
      }
    })
  )
}

beforeEach(() => {
  account = null
  assets = {
    [WRAP_NEAR]: asset(WRAP_NEAR, 7500, 0),
    [USDC_NEAR]: asset(USDC_NEAR, 9500, 12),
    [USDT_NEAR]: asset(USDT_NEAR, 9500, 12),
  }
  quotes = {
    4512: dollars(4),
    5515: dollars(3),
    6063: dollars(4),
    6416: dollars(1),
    4179: '990000',
  }
  rpc = { views: baseViews(), down: false, tx: undefined }
  install()
})

afterEach(() => vi.unstubAllGlobals())

const txs = (prepared: { signing: SigningPayload }): NearTransaction[] =>
  (prepared.signing as { transactions: NearTransaction[] }).transactions

const methods = (tx: NearTransaction | undefined): string[] =>
  (tx?.actions ?? []).map((a) => a.params.methodName)

const lastCall = (tx: NearTransaction | undefined): NearTransaction['actions'][number]['params'] =>
  (tx?.actions.at(-1) as NearTransaction['actions'][number]).params

const swap = (over: Partial<ChainActionRequest> = {}): ChainActionRequest => ({
  kind: 'swap',
  amount: '1',
  tokenIn: 'NEAR',
  tokenOut: 'USDC',
  ...over,
})

interface SwapMessage {
  actions: Record<string, unknown>[]
  skip_unwrap_near?: boolean
}

function messageOf(prepared: PreparedAction): SwapMessage {
  return JSON.parse(lastCall(txs(prepared).at(-1)).args['msg'] as string) as SwapMessage
}

describe('swapping on Rhea DEX', () => {
  it('wraps NEAR and sends it to the pinned exchange, with a real minimum', async () => {
    const prepared = await rheaDexVenue.prepare(swap(), ME)
    expect(() => rheaDexVenue.assertSafe(prepared.signing, ME)).not.toThrow()
    const [tx] = txs(prepared)
    expect(txs(prepared)).toHaveLength(1)
    expect(tx?.receiverId).toBe(WRAP_NEAR)
    expect(methods(tx)).toEqual(['near_deposit', 'ft_transfer_call'])
    expect(tx?.actions[0]?.params.deposit).toBe(yocto(1))
    expect(lastCall(tx).deposit).toBe('1')
    expect(lastCall(tx).args['receiver_id']).toBe(RHEA_DEX)
    expect(lastCall(tx).args['amount']).toBe(yocto(1))

    const message = messageOf(prepared)
    expect(Object.keys(message)).toEqual(['actions'])
    expect(message.actions).toEqual([
      {
        pool_id: 4512,
        token_in: WRAP_NEAR,
        token_out: USDC_NEAR,
        amount_in: yocto(1),
        min_amount_out: '3960000',
      },
    ])
    expect(prepared.receive).toEqual({ amount: '4', symbol: 'USDC', approximate: true })
  })

  it('takes the route that pays most, read from the chain', async () => {
    quotes = { 4512: dollars(3), 5515: '3950000', 6063: '3900000', 6416: '3890000' }
    const prepared = await rheaDexVenue.prepare(swap(), ME)
    expect(messageOf(prepared).actions[0]?.['pool_id']).toBe(5515)
  })

  it('crosses two pools with one minimum at the end, when that pays most', async () => {
    quotes = { 4512: dollars(3), 5515: dollars(3), 6063: dollars(4), 6416: '3990000' }
    const prepared = await rheaDexVenue.prepare(swap(), ME)
    expect(() => rheaDexVenue.assertSafe(prepared.signing, ME)).not.toThrow()
    const { actions } = messageOf(prepared)
    expect(actions.map((a) => a['pool_id'])).toEqual([6063, 6416])
    expect(actions[0]?.['min_amount_out']).toBe('0')
    expect(actions[1]).not.toHaveProperty('amount_in')
    expect(actions[1]?.['min_amount_out']).toBe('3950100')
  })

  it('leaves out a pool that will not quote, as one with a stale price will not', async () => {
    quotes = { 4512: undefined, 5515: dollars(4), 6063: undefined }
    const prepared = await rheaDexVenue.prepare(swap(), ME)
    expect(messageOf(prepared).actions[0]?.['pool_id']).toBe(5515)
  })

  it('refuses when no pool will quote', async () => {
    quotes = {}
    await expect(rheaDexVenue.prepare(swap(), ME)).rejects.toThrow(/no pool that will quote/)
  })

  it('asks for NEAR back as NEAR, so it needs no registration and can not bounce', async () => {
    quotes = { 4512: yocto(1), 5515: yocto(1), 6063: yocto(1), 6416: dollars(4) }
    const prepared = await rheaDexVenue.prepare(
      swap({ amount: '4', tokenIn: 'USDC', tokenOut: 'NEAR' }),
      ME
    )
    expect(() => rheaDexVenue.assertSafe(prepared.signing, ME)).not.toThrow()
    expect(txs(prepared)).toHaveLength(1)
    expect(txs(prepared)[0]?.receiverId).toBe(USDC_NEAR)
    expect(messageOf(prepared).skip_unwrap_near).toBe(false)
  })

  it('registers you on the token coming out first, so it can reach you', async () => {
    rpc.views[`${USDC_NEAR}.storage_balance_of`] = () => null
    const prepared = await rheaDexVenue.prepare(swap(), ME)
    expect(() => rheaDexVenue.assertSafe(prepared.signing, ME)).not.toThrow()
    const [first, second] = txs(prepared)
    expect(first?.receiverId).toBe(USDC_NEAR)
    expect(methods(first)).toEqual(['storage_deposit'])
    expect(first?.actions[0]?.params.args).toEqual({ account_id: ME, registration_only: true })
    expect(first?.actions[0]?.params.deposit).toBe(STORAGE)
    expect(methods(second)).toEqual(['near_deposit', 'ft_transfer_call'])
    expect(prepared.notes.join(' ')).toMatch(/two transactions/)
  })

  it('pays for wNEAR storage in the same transaction as a first wrap', async () => {
    rpc.views[`${WRAP_NEAR}.storage_balance_of`] = () => null
    const prepared = await rheaDexVenue.prepare(swap(), ME)
    expect(() => rheaDexVenue.assertSafe(prepared.signing, ME)).not.toThrow()
    expect(methods(txs(prepared)[0])).toEqual([
      'storage_deposit',
      'near_deposit',
      'ft_transfer_call',
    ])
  })

  it('refuses more than the wallet holds', async () => {
    quotes = { 6416: dollars(5000), 4179: dollars(4990) }
    await expect(
      rheaDexVenue.prepare(swap({ amount: '5000', tokenIn: 'USDC', tokenOut: 'USDT' }), ME)
    ).rejects.toThrow(/You hold 1000 USDC/)
  })

  it('refuses a swap that loses too much against Pyth', async () => {
    quotes = { 4512: dollars(3), 5515: dollars(3), 6063: dollars(3), 6416: dollars(3) }
    await expect(rheaDexVenue.prepare(swap(), ME)).rejects.toThrow(/about 25.0% less/)
  })

  it('refuses a swap with no price to check it against', async () => {
    rpc.views['aggregate-oracle.near.get_price_no_older_than'] = () => null
    await expect(rheaDexVenue.prepare(swap(), ME)).rejects.toThrow(/checked against live prices/)
  })

  it('refuses while the exchange is paused or a token is frozen', async () => {
    rpc.views[`${RHEA_DEX}.get_frozenlist_tokens`] = () => [USDC_NEAR]
    await expect(rheaDexVenue.prepare(swap(), ME)).rejects.toThrow(/frozen/)
    rpc.views[`${RHEA_DEX}.metadata`] = () => ({ state: 'Paused' })
    await expect(rheaDexVenue.prepare(swap(), ME)).rejects.toThrow(/paused/)
  })

  it('says the network could not be read when it can not, and quotes without building', async () => {
    const quoted = await rheaDexVenue.quote?.(swap(), ME)
    expect(quoted).toEqual({ receive: { amount: '4', symbol: 'USDC' } })
    rpc.down = true
    await expect(rheaDexVenue.prepare(swap(), ME)).rejects.toThrow(/could not be read/)
  })

  it('refuses another account shape', async () => {
    await expect(rheaDexVenue.prepare(swap(), 'NOT AN ACCOUNT')).rejects.toThrow(ChainActionRefused)
  })
})

describe('the swap policy', () => {
  function tampered(
    change: (message: Record<string, unknown>, args: Record<string, unknown>) => void
  ) {
    return async (): Promise<void> => {
      const prepared = await rheaDexVenue.prepare(swap(), ME)
      const copy = JSON.parse(JSON.stringify(prepared.signing)) as {
        family: 'near'
        transactions: NearTransaction[]
      }
      const args = lastCall(copy.transactions.at(-1)).args
      const message = JSON.parse(args['msg'] as string) as Record<string, unknown>
      change(message, args)
      args['msg'] = args['rawMsg'] ?? JSON.stringify(message)
      delete args['rawMsg']
      expect(() => assertRheaDexSafe(copy, ME)).toThrow(ChainActionRefused)
    }
  }
  const step = (m: Record<string, unknown>): Record<string, unknown> =>
    (m['actions'] as Record<string, unknown>[])[0] as Record<string, unknown>

  it('passes what prepare builds, once untouched', async () => {
    const prepared = await rheaDexVenue.prepare(swap(), ME)
    expect(() => assertRheaDexSafe(prepared.signing, ME)).not.toThrow()
  })

  it.each<[string, (m: Record<string, unknown>, a: Record<string, unknown>) => void]>([
    ['proceeds sent to someone else', (m) => (m['swap_out_recipient'] = THEM)],
    ['proceeds sent with a callback', (m) => (m['client_echo'] = 'x')],
    ['a referral taking a cut', (m) => (m['referral_id'] = THEM)],
    ['the price sync switched off', (m) => (m['skip_degen_price_sync'] = true)],
    ['extra gas for a callback', (m) => (m['extra_tgas_for_client_echo'] = 1)],
    ['a liquidity zap', (m) => (m['hot_zap_actions'] = [])],
    ['a pool nobody checked', (m) => (step(m)['pool_id'] = 9999)],
    ['no minimum', (m) => (step(m)['min_amount_out'] = '0')],
    ['a token its pool does not trade', (m) => (step(m)['token_out'] = USDT_NEAR)],
    ['an unlisted token', (m) => (step(m)['token_out'] = 'evil.near')],
    ['less swapped than sent', (m) => (step(m)['amount_in'] = '1')],
    ['a step starting elsewhere', (m) => (step(m)['token_in'] = USDC_NEAR)],
    ['an extra field on a step', (m) => (step(m)['extra'] = 1)],
    ['swap by output', (m) => (step(m)['amount_out'] = '1')],
    ['no steps', (m) => (m['actions'] = [])],
    ['three steps', (m) => (m['actions'] = [step(m), step(m), step(m)])],
    ['the same pool twice', (m) => (m['actions'] = [step(m), step(m)])],
    ['another receiver', (_m, a) => (a['receiver_id'] = THEM)],
    ['another amount', (_m, a) => (a['amount'] = '1')],
    ['an extra argument', (_m, a) => (a['memo'] = 'x')],
    ['an empty message, which would strand it', (_m, a) => (a['rawMsg'] = '')],
    ['a message written another way', (m, a) => (a['rawMsg'] = ` ${JSON.stringify(m)}`)],
    ['a null message', (_m, a) => (a['rawMsg'] = 'null')],
    ['a broken message', (_m, a) => (a['rawMsg'] = '{')],
  ])('refuses %s', async (_name, change) => {
    await tampered(change)()
  })

  async function nearOut(): Promise<{ family: 'near'; transactions: NearTransaction[] }> {
    quotes = { 4512: yocto(1), 5515: yocto(1), 6063: yocto(1), 6416: dollars(4) }
    const prepared = await rheaDexVenue.prepare(
      swap({ amount: '4', tokenIn: 'USDC', tokenOut: 'NEAR' }),
      ME
    )
    return JSON.parse(JSON.stringify(prepared.signing)) as {
      family: 'near'
      transactions: NearTransaction[]
    }
  }

  it.each([
    ['left wrapped', { skip_unwrap_near: true }],
    ['with the flag missing', { skip_unwrap_near: undefined }],
  ])('refuses NEAR handed back %s', async (_name, flag) => {
    const copy = await nearOut()
    const args = lastCall(copy.transactions[0]).args
    args['msg'] = JSON.stringify({ ...(JSON.parse(args['msg'] as string) as object), ...flag })
    expect(() => assertRheaDexSafe(copy, ME)).toThrow(/hand back NEAR|unexpected fields/)
  })

  it('refuses a minimum far under a stablecoin swap', async () => {
    quotes = { 6416: dollars(10), 4179: dollars(9) }
    const prepared = await rheaDexVenue.prepare(
      swap({ amount: '10', tokenIn: 'USDC', tokenOut: 'USDT' }),
      ME
    )
    expect(() => assertRheaDexSafe(prepared.signing, ME)).not.toThrow()
    const copy = JSON.parse(JSON.stringify(prepared.signing)) as {
      family: 'near'
      transactions: NearTransaction[]
    }
    const args = lastCall(copy.transactions[0]).args
    const message = JSON.parse(args['msg'] as string) as { actions: Record<string, unknown>[] }
    ;(message.actions[0] as Record<string, unknown>)['min_amount_out'] = '1'
    args['msg'] = JSON.stringify(message)
    expect(() => assertRheaDexSafe(copy, ME)).toThrow(/far too little/)
  })

  it('refuses the wrap not matching, more wraps, a registration for someone else, a bad order', async () => {
    const fresh = async (): Promise<{ family: 'near'; transactions: NearTransaction[] }> => {
      rpc.views[`${USDC_NEAR}.storage_balance_of`] = () => null
      const prepared = await rheaDexVenue.prepare(swap(), ME)
      return JSON.parse(JSON.stringify(prepared.signing)) as {
        family: 'near'
        transactions: NearTransaction[]
      }
    }
    const a = await fresh()
    ;(a.transactions[1]?.actions[0]?.params as { deposit: string }).deposit = yocto(2)
    expect(() => assertRheaDexSafe(a, ME)).toThrow(/amount wrapped/)

    const b = await fresh()
    ;(b.transactions[0]?.actions[0]?.params.args as Record<string, unknown>)['account_id'] = THEM
    expect(() => assertRheaDexSafe(b, ME)).toThrow(/another account/)

    const c = await fresh()
    c.transactions.reverse()
    expect(() => assertRheaDexSafe(c, ME)).toThrow(/last transaction/)

    const d = await fresh()
    ;(d.transactions[0] as NearTransaction).receiverId = USDT_NEAR
    expect(() => assertRheaDexSafe(d, ME)).toThrow(/wrong token/)

    const e = await fresh()
    ;(e.transactions[1] as NearTransaction).receiverId = THEM
    expect(() => assertRheaDexSafe(e, ME)).toThrow(/not a listed token/)

    const f = await fresh()
    ;(lastCall(f.transactions[1]) as { deposit: string }).deposit = '2'
    expect(() => assertRheaDexSafe(f, ME)).toThrow(/exactly 1 yoctoNEAR/)

    const g = await fresh()
    ;(lastCall(g.transactions[1]) as { gas: string }).gas = (
      BigInt(301) *
      BigInt(10) ** BigInt(12)
    ).toString()
    expect(() => assertRheaDexSafe(g, ME)).toThrow(/more gas/)
  })

  it('refuses a plain transfer and another chain', () => {
    expect(() =>
      assertRheaDexSafe(
        {
          family: 'near',
          transactions: [
            {
              receiverId: USDC_NEAR,
              actions: [
                {
                  type: 'FunctionCall',
                  params: {
                    methodName: 'ft_transfer',
                    args: { receiver_id: THEM, amount: '1' },
                    gas: '1',
                    deposit: '1',
                  },
                },
              ],
            },
          ],
        },
        ME
      )
    ).toThrow(ChainActionRefused)
    expect(() => assertRheaDexSafe({ family: 'sui', transaction: 'x' }, ME)).toThrow(
      /not a NEAR transaction/
    )
  })
})

describe('getting tokens back out of Rhea DEX', () => {
  const withdraw = (over: Partial<ChainActionRequest> = {}): ChainActionRequest => ({
    kind: 'withdraw',
    amount: '5',
    tokenIn: 'USDC',
    ...over,
  })

  it('shows what is held there, what is waiting and wNEAR in the wallet', async () => {
    rpc.views[`${RHEA_DEX}.get_deposits`] = () => ({ [USDC_NEAR]: dollars(5), [THEM]: '9' })
    rpc.views[`${RHEA_DEX}.list_lostfound_tokens`] = () => ({ [USDT_NEAR]: dollars(2) })
    rpc.views[`${WRAP_NEAR}.ft_balance_of`] = () => yocto(3)
    await expect(rheaDexVenue.positions?.(ME)).resolves.toEqual([
      { slot: 'supplied', symbol: 'NEAR', amount: '3' },
      { slot: 'supplied', symbol: 'USDC', amount: '5' },
      { slot: 'claimable', symbol: 'USDT', amount: '2' },
    ])
  })

  it('throws, rather than reading as empty, when it can not read', async () => {
    rpc.down = true
    await expect(rheaDexVenue.positions?.(ME)).rejects.toThrow()
  })

  it('takes a set amount, or all of it with the contract zero', async () => {
    rpc.views[`${RHEA_DEX}.get_deposits`] = () => ({ [USDC_NEAR]: dollars(5) })
    const some = await rheaDexVenue.prepare(withdraw({ amount: '2' }), ME)
    expect(() => rheaDexVenue.assertSafe(some.signing, ME)).not.toThrow()
    expect(lastCall(txs(some)[0]).methodName).toBe('withdraw')
    expect(lastCall(txs(some)[0]).args).toEqual({ token_id: USDC_NEAR, amount: dollars(2) })
    expect(lastCall(txs(some)[0]).deposit).toBe('1')

    const all = await rheaDexVenue.prepare(withdraw({ wholePosition: true }), ME)
    expect(lastCall(txs(all)[0]).args).toEqual({ token_id: USDC_NEAR, amount: '0' })
  })

  it('registers you first if the token could not reach you', async () => {
    rpc.views[`${RHEA_DEX}.get_deposits`] = () => ({ [USDC_NEAR]: dollars(5) })
    rpc.views[`${USDC_NEAR}.storage_balance_of`] = () => null
    const out = await rheaDexVenue.prepare(withdraw(), ME)
    expect(() => rheaDexVenue.assertSafe(out.signing, ME)).not.toThrow()
    expect(txs(out).map((t) => methods(t)[0])).toEqual(['storage_deposit', 'withdraw'])
  })

  it('hands NEAR back as NEAR, from Rhea first and then wNEAR in the wallet', async () => {
    rpc.views[`${RHEA_DEX}.get_deposits`] = () => ({ [WRAP_NEAR]: yocto(1) })
    rpc.views[`${WRAP_NEAR}.ft_balance_of`] = () => yocto(2)
    const out = await rheaDexVenue.prepare(withdraw({ tokenIn: 'NEAR', amount: '2.5' }), ME)
    expect(() => rheaDexVenue.assertSafe(out.signing, ME)).not.toThrow()
    const [atRhea, inWallet] = txs(out)
    expect(lastCall(atRhea).args).toEqual({
      token_id: WRAP_NEAR,
      amount: yocto(1),
      skip_unwrap_near: false,
    })
    expect(inWallet?.receiverId).toBe(WRAP_NEAR)
    expect(lastCall(inWallet).methodName).toBe('near_withdraw')
    expect(lastCall(inWallet).args).toEqual({
      amount: (ONE_NEAR + ONE_NEAR / BigInt(2)).toString(),
    })
  })

  it('unwraps what a stopped swap handed back', async () => {
    rpc.views[`${WRAP_NEAR}.ft_balance_of`] = () => yocto(2)
    const out = await rheaDexVenue.prepare(
      withdraw({ tokenIn: 'NEAR', amount: '2', wholePosition: true }),
      ME
    )
    expect(txs(out)).toHaveLength(1)
    expect(lastCall(txs(out)[0]).args).toEqual({ amount: yocto(2) })
    expect(out.summary).toMatch(/wNEAR in your wallet back into NEAR/)
  })

  it('refuses more than there is, and nothing at all', async () => {
    await expect(rheaDexVenue.prepare(withdraw(), ME)).rejects.toThrow(/no USDC to take back/)
    rpc.views[`${RHEA_DEX}.get_deposits`] = () => ({ [USDC_NEAR]: dollars(1) })
    await expect(rheaDexVenue.prepare(withdraw(), ME)).rejects.toThrow(/less than 5/)
  })

  it('claims what waits under your name, and says so when nothing does', async () => {
    const claim: ChainActionRequest = { kind: 'claim', amount: 'all', tokenIn: 'NEAR' }
    await expect(rheaDexVenue.prepare(claim, ME)).rejects.toThrow(/Nothing in NEAR is waiting/)
    rpc.views[`${RHEA_DEX}.list_lostfound_tokens`] = () => ({ [WRAP_NEAR]: yocto(1) })
    const out = await rheaDexVenue.prepare(claim, ME)
    expect(() => rheaDexVenue.assertSafe(out.signing, ME)).not.toThrow()
    expect(txs(out).map((t) => methods(t)[0])).toEqual(['claim_lostfound', 'near_withdraw'])
  })

  it.each<[string, string, Record<string, unknown>, string]>([
    ['another method', 'storage_withdraw', { token_id: USDC_NEAR, amount: '1' }, '1'],
    ['an unlisted token', 'withdraw', { token_id: 'evil.near', amount: '1' }, '1'],
    ['an extra argument', 'withdraw', { token_id: USDC_NEAR, amount: '1', to: THEM }, '1'],
    ['no yocto', 'withdraw', { token_id: USDC_NEAR, amount: '1' }, '0'],
    [
      'wNEAR left wrapped',
      'withdraw',
      { token_id: WRAP_NEAR, amount: '1', skip_unwrap_near: true },
      '1',
    ],
  ])('refuses %s on the way out', (_name, methodName, args, deposit) => {
    expect(() =>
      assertRheaDexSafe(
        {
          family: 'near',
          transactions: [
            {
              receiverId: RHEA_DEX,
              actions: [
                { type: 'FunctionCall', params: { methodName, args, gas: '100', deposit } },
              ],
            },
          ],
        },
        ME
      )
    ).toThrow(ChainActionRefused)
  })
})

interface FakeTx {
  signer?: string
  receiver?: string
  method?: string
  args?: Record<string, unknown>
  returned?: string
  failed?: boolean
  receipts?: { executor: string; failed?: boolean; logs?: string[] }[]
}

function fakeTx(tx: FakeTx): unknown {
  const args = Buffer.from(JSON.stringify(tx.args ?? {})).toString('base64')
  return {
    status: tx.failed
      ? { Failure: { ActionError: {} } }
      : { SuccessValue: Buffer.from(tx.returned ?? '').toString('base64') },
    transaction: {
      signer_id: tx.signer ?? ME,
      receiver_id: tx.receiver ?? RHEA_LEND,
      actions: [{ FunctionCall: { method_name: tx.method ?? 'execute', args, deposit: '1' } }],
    },
    receipts_outcome: (tx.receipts ?? []).map((r) => ({
      outcome: {
        executor_id: r.executor,
        logs: r.logs ?? [],
        status: r.failed ? { Failure: {} } : { SuccessValue: '' },
      },
    })),
  }
}

const signedNear = (hashes: string[] = [HASH]) => ({
  account: ME,
  venueId: 'x',
  signed: { family: 'near' as const, hashes },
})

describe('confirming a Rhea DEX swap', () => {
  const swapTx = (over: FakeTx = {}): FakeTx => ({
    receiver: WRAP_NEAR,
    method: 'ft_transfer_call',
    args: {
      receiver_id: RHEA_DEX,
      amount: yocto(1),
      msg: JSON.stringify({ actions: [{ token_out: USDC_NEAR }] }),
    },
    returned: JSON.stringify(yocto(1)),
    ...over,
  })

  it('reports a swap that ran and delivered', async () => {
    rpc.tx = () => fakeTx(swapTx())
    await expect(confirmRheaDex(signedNear())).resolves.toMatchObject({ ok: true, hash: HASH })
  })

  it('never calls a refunded swap done, though the transaction succeeded', async () => {
    rpc.tx = () => fakeTx(swapTx({ returned: '"0"' }))
    const out = await confirmRheaDex(signedNear())
    expect(out.ok).toBe(false)
    expect(out).not.toHaveProperty('pending')
    expect((out as { error: string }).error).toMatch(/came back as wNEAR/)
  })

  it('says where the money is when delivery failed', async () => {
    rpc.tx = () => fakeTx(swapTx({ receipts: [{ executor: USDC_NEAR, failed: true }] }))
    const out = await confirmRheaDex(signedNear())
    expect(out).toMatchObject({ ok: false, pending: true })
    expect((out as { error: string }).error).toMatch(/withdraw USDC on Rhea DEX/)
  })

  it('ignores a failed price refresh, which does not touch the swap', async () => {
    rpc.tx = () =>
      fakeTx(swapTx({ receipts: [{ executor: 'aggregate-oracle.near', failed: true }] }))
    await expect(confirmRheaDex(signedNear())).resolves.toMatchObject({ ok: true })
  })

  it('says nothing moved when the transaction itself failed', async () => {
    rpc.tx = () => fakeTx(swapTx({ failed: true }))
    const out = await confirmRheaDex(signedNear())
    expect(out.ok).toBe(false)
    expect(out).not.toHaveProperty('pending')
  })

  it('stays pending on a swap whose result can not be read', async () => {
    rpc.tx = () => fakeTx(swapTx({ returned: '' }))
    await expect(confirmRheaDex(signedNear())).resolves.toMatchObject({ ok: false, pending: true })
  })

  it.each<[string, FakeTx]>([
    ['someone else signed', swapTx({ signer: THEM })],
    ['it ran on another contract', swapTx({ receiver: 'evil.near' })],
    ['it paid someone else', swapTx({ args: { receiver_id: THEM, amount: '1', msg: '{}' } })],
    ['it is some other call', { receiver: WRAP_NEAR, method: 'ft_transfer', args: {} }],
  ])('will not report a hash where %s', async (_name, tx) => {
    rpc.tx = () => fakeTx(tx)
    await expect(confirmRheaDex(signedNear())).resolves.toMatchObject({ ok: false, pending: true })
  })

  it('does not call a registration alone a swap', async () => {
    rpc.tx = () => fakeTx({ receiver: USDC_NEAR, method: 'storage_deposit', args: {} })
    await expect(confirmRheaDex(signedNear())).resolves.toMatchObject({ ok: false, pending: true })
  })

  it('carries on past a registration to the swap', async () => {
    rpc.tx = (hash) =>
      fakeTx(
        hash === HASH
          ? { receiver: USDC_NEAR, method: 'storage_deposit', args: {}, returned: '{}' }
          : swapTx()
      )
    await expect(confirmRheaDex(signedNear([HASH, HASH2]))).resolves.toMatchObject({
      ok: true,
      hash: HASH2,
    })
  })

  it('reports a withdrawal that could not reach the wallet', async () => {
    rpc.tx = () => fakeTx({ receiver: RHEA_DEX, method: 'withdraw', returned: '"0"' })
    const out = await confirmRheaDex(signedNear())
    expect(out.ok).toBe(false)
    expect((out as { error: string }).error).toMatch(/still held under your name/)
  })

  it('refuses a malformed hash, keeping the money latched', async () => {
    await expect(confirmRheaDex(signedNear(['not a hash']))).resolves.toMatchObject({
      ok: false,
      pending: true,
    })
  })
}, 30_000)

function lendAccount(over: {
  plain?: [string, string][]
  collateral?: [string, string][]
  borrowed?: [string, string][]
  locked?: boolean
}): unknown {
  const lines = (entries: [string, string][] = []) =>
    entries.map(([token_id, balance]) => ({ token_id, balance, shares: balance, apr: '0' }))
  return {
    account_id: ME,
    supplied: lines(over.plain),
    positions: {
      REGULAR: { collateral: lines(over.collateral), borrowed: lines(over.borrowed) },
    },
    is_locked: over.locked ?? false,
  }
}

const lend = (kind: ChainActionRequest['kind'], amount: string, tokenIn = 'USDC', more = {}) =>
  ({ kind, amount, tokenIn, ...more }) as ChainActionRequest

function actionsOf(tx: NearTransaction | undefined): unknown {
  return lastCall(tx).args['actions']
}

describe('supplying to Rhea Lend', () => {
  it('sends the token with an empty message, to the pinned contract', async () => {
    const prepared = await rheaLendVenue.prepare(lend('supply', '10'), ME)
    expect(() => rheaLendVenue.assertSafe(prepared.signing, ME)).not.toThrow()
    const [tx] = txs(prepared)
    expect(txs(prepared)).toHaveLength(1)
    expect(tx?.receiverId).toBe(USDC_NEAR)
    expect(lastCall(tx).args).toEqual({ receiver_id: RHEA_LEND, amount: dollars(10), msg: '' })
    expect(prepared.apy?.basePercent).toBeCloseTo(9.85)
    expect(prepared.notes.join(' ')).toMatch(/80% of this market is lent out/)
  })

  it('pays for the record first on a first use', async () => {
    rpc.views[`${RHEA_LEND}.storage_balance_of`] = () => null
    const prepared = await rheaLendVenue.prepare(lend('supply', '10'), ME)
    expect(() => rheaLendVenue.assertSafe(prepared.signing, ME)).not.toThrow()
    const [first] = txs(prepared)
    expect(first?.receiverId).toBe(RHEA_LEND)
    expect(first?.actions[0]?.params.deposit).toBe(RHEA_LEND_STORAGE_YOCTO)
    expect(prepared.notes.join(' ')).toMatch(/0.1 NEAR/)
  })

  it('wraps NEAR in the same transaction', async () => {
    const prepared = await rheaLendVenue.prepare(lend('supply', '2', 'NEAR'), ME)
    expect(() => rheaLendVenue.assertSafe(prepared.signing, ME)).not.toThrow()
    expect(methods(txs(prepared)[0])).toEqual(['near_deposit', 'ft_transfer_call'])
    expect(txs(prepared)[0]?.actions[0]?.params.deposit).toBe(yocto(2))
  })

  it('refuses more than the wallet holds, and a market that is closed or full', async () => {
    await expect(rheaLendVenue.prepare(lend('supply', '5000'), ME)).rejects.toThrow(/You hold 1000/)
    const usdc = assets[USDC_NEAR] as { config: Record<string, unknown> }
    usdc.config['supplied_limit'] = '1'
    await expect(rheaLendVenue.prepare(lend('supply', '10'), ME)).rejects.toThrow(/full/)
    usdc.config['can_deposit'] = false
    await expect(rheaLendVenue.prepare(lend('supply', '10'), ME)).rejects.toThrow(/isn't taking/)
  })

  it('refuses while the contract is paused, and a token it does not take', async () => {
    await expect(rheaLendVenue.prepare(lend('supply', '1', 'DOGE'), ME)).rejects.toThrow(
      /takes NEAR, USDC or USDT/
    )
    rpc.views[`${RHEA_LEND}.get_config`] = () => ({ contract_mode: 'Paused' })
    await expect(rheaLendVenue.prepare(lend('supply', '10'), ME)).rejects.toThrow(/paused/)
  })

  it('gives its rate as a quote, and nothing else', async () => {
    const quoted = await rheaLendVenue.quote?.(lend('supply', '10'), ME)
    expect(quoted?.apyPercent).toBeCloseTo(9.85)
    await expect(rheaLendVenue.quote?.(lend('borrow', '10'), ME)).resolves.toEqual({})
  })
})

describe('borrowing on Rhea Lend', () => {
  const backed = (usdc = 100): unknown => lendAccount({ collateral: [[USDC_NEAR, inner18(usdc)]] })

  it('borrows within what the collateral backs, and takes it out to the signer', async () => {
    account = backed()
    const prepared = await rheaLendVenue.prepare(lend('borrow', '70', 'USDT'), ME)
    expect(() => rheaLendVenue.assertSafe(prepared.signing, ME)).not.toThrow()
    const [tx] = txs(prepared)
    expect(txs(prepared)).toHaveLength(1)
    expect(tx?.receiverId).toBe(RHEA_LEND)
    expect(lastCall(tx).methodName).toBe('execute_with_pyth')
    expect(lastCall(tx).deposit).toBe('1')
    expect(actionsOf(tx)).toEqual([
      { Borrow: { token_id: USDT_NEAR, amount: inner18(70) } },
      { Withdraw: { token_id: USDT_NEAR, max_amount: inner18(70) } },
    ])
    expect(prepared.receive).toEqual({ amount: '70', symbol: 'USDT', approximate: false })
  })

  it('states liquidation plainly, with the real margin', async () => {
    account = backed()
    const prepared = await rheaLendVenue.prepare(lend('borrow', '70', 'USDT'), ME)
    const notes = prepared.notes.join(' ')
    expect(notes).toMatch(/You can lose your collateral/)
    expect(notes).toMatch(/129% of the level/)
    expect(notes).toMatch(/falls about 22\.\d% against what you owe/)
    expect(notes).toMatch(/anyone can liquidate you/)
    expect(notes).toMatch(/about 15.24% a year/)
  })

  it('refuses a borrow the position can not safely support, and says what it could', async () => {
    account = backed()
    await expect(rheaLendVenue.prepare(lend('borrow', '80', 'USDT'), ME)).rejects.toThrow(
      /can't safely back 80 USDT. You could borrow about 75\.2/
    )
  })

  it('refuses at the contract limit too, where liquidation could already begin', async () => {
    account = backed()
    await expect(rheaLendVenue.prepare(lend('borrow', '90', 'USDT'), ME)).rejects.toThrow(
      /can't safely back/
    )
  })

  it('counts what is already owed', async () => {
    account = lendAccount({
      collateral: [[USDC_NEAR, inner18(100)]],
      borrowed: [[USDT_NEAR, inner18(70)]],
    })
    await expect(rheaLendVenue.prepare(lend('borrow', '10', 'USDT'), ME)).rejects.toThrow(
      /about 5\.2/
    )
  })

  it('refuses with nothing supplied', async () => {
    await expect(rheaLendVenue.prepare(lend('borrow', '1', 'USDT'), ME)).rejects.toThrow(
      /Nothing of yours backs a loan/
    )
  })

  it('moves what is supplied to back the loan, before the borrow and in its own transaction', async () => {
    account = lendAccount({
      plain: [
        [USDC_NEAR, inner18(100)],
        ['dai.near', inner18(5000)],
      ],
    })
    const prepared = await rheaLendVenue.prepare(lend('borrow', '50', 'USDT'), ME)
    expect(() => rheaLendVenue.assertSafe(prepared.signing, ME)).not.toThrow()
    const [move, borrow] = txs(prepared)
    expect(actionsOf(move)).toEqual([{ IncreaseCollateral: { token_id: USDC_NEAR } }])
    expect(lastCall(borrow).methodName).toBe('execute_with_pyth')
    expect(prepared.notes.join(' ')).toMatch(/All your supplied USDC now backs this loan/)
  })

  it('does not count a supply that can not back a loan', async () => {
    account = lendAccount({ plain: [[USDC_NEAR, inner18(100)]] })
    const usdc = assets[USDC_NEAR] as { config: Record<string, unknown> }
    usdc.config['can_use_as_collateral'] = false
    await expect(rheaLendVenue.prepare(lend('borrow', '50', 'USDT'), ME)).rejects.toThrow(
      /Nothing of yours backs a loan/
    )
  })

  it('values NEAR collateral by its own price and ratio', async () => {
    account = lendAccount({ collateral: [[WRAP_NEAR, yocto(100)]] })
    await expect(rheaLendVenue.prepare(lend('borrow', '230', 'USDC'), ME)).resolves.toBeDefined()
    await expect(rheaLendVenue.prepare(lend('borrow', '260', 'USDC'), ME)).rejects.toThrow(
      /You could borrow about 237\.5/
    )
  })

  it('borrows NEAR as NEAR: registers, takes wNEAR, then unwraps', async () => {
    account = backed()
    rpc.views[`${WRAP_NEAR}.storage_balance_of`] = () => null
    const prepared = await rheaLendVenue.prepare(lend('borrow', '5', 'NEAR'), ME)
    expect(() => rheaLendVenue.assertSafe(prepared.signing, ME)).not.toThrow()
    expect(txs(prepared).map((t) => methods(t)[0])).toEqual([
      'storage_deposit',
      'execute_with_pyth',
      'near_withdraw',
    ])
    expect(lastCall(txs(prepared)[2]).args).toEqual({
      amount: (BigInt(5) * ONE_NEAR - BigInt(10)).toString(),
    })
  })

  it('refuses without prices, or more than is free to lend, or under the minimum', async () => {
    account = backed()
    await expect(rheaLendVenue.prepare(lend('borrow', '0.000000001', 'USDT'), ME)).rejects.toThrow()
    const usdt = assets[USDT_NEAR] as { config: Record<string, unknown>; supplied: unknown }
    usdt.config['min_borrowed_amount'] = inner18(5)
    await expect(rheaLendVenue.prepare(lend('borrow', '1', 'USDT'), ME)).rejects.toThrow(
      /lends at least 5 USDT/
    )
    usdt.config['min_borrowed_amount'] = '1'
    usdt.config['borrowed_limit'] = '1'
    await expect(rheaLendVenue.prepare(lend('borrow', '1', 'USDT'), ME)).rejects.toThrow(/limit/)
    usdt.config['borrowed_limit'] = null
    usdt.supplied = { balance: inner18(800_001) }
    await expect(rheaLendVenue.prepare(lend('borrow', '2', 'USDT'), ME)).rejects.toThrow(
      /only about 1 USDT free/
    )
    usdt.supplied = { balance: inner18(1_000_000) }
    rpc.views['aggregate-oracle.near.get_price_no_older_than'] = () => null
    await expect(rheaLendVenue.prepare(lend('borrow', '1', 'USDT'), ME)).rejects.toThrow(
      /prices couldn't be read/
    )
  })

  it('refuses when lending is off, the account is locked, or prices come from elsewhere', async () => {
    account = lendAccount({ collateral: [[USDC_NEAR, inner18(100)]], locked: true })
    await expect(rheaLendVenue.prepare(lend('borrow', '1', 'USDT'), ME)).rejects.toThrow(/locked/)
    account = backed()
    const usdt = assets[USDT_NEAR] as { config: Record<string, unknown> }
    usdt.config['can_borrow'] = false
    await expect(rheaLendVenue.prepare(lend('borrow', '1', 'USDT'), ME)).rejects.toThrow(
      /isn't lending/
    )
    rpc.views[`${RHEA_LEND}.get_config`] = () => ({
      contract_mode: 'Running',
      enable_pyth_oracle: true,
      pyth_oracle_account_id: 'evil-oracle.near',
    })
    await expect(rheaLendVenue.prepare(lend('borrow', '1', 'USDT'), ME)).rejects.toThrow(
      /source this app checks/
    )
  })

  it('stops if the contract changes how it counts a token', async () => {
    account = backed()
    const usdt = assets[USDT_NEAR] as { config: Record<string, unknown> }
    usdt.config['extra_decimals'] = 0
    await expect(rheaLendVenue.prepare(lend('borrow', '1', 'USDT'), ME)).rejects.toThrow(
      /could not be read/
    )
  })
})

describe('withdrawing from Rhea Lend', () => {
  it('takes plain supply with no prices', async () => {
    account = lendAccount({ plain: [[USDC_NEAR, inner18(50)]] })
    const prepared = await rheaLendVenue.prepare(lend('withdraw', '20'), ME)
    expect(() => rheaLendVenue.assertSafe(prepared.signing, ME)).not.toThrow()
    expect(lastCall(txs(prepared)[0]).methodName).toBe('execute')
    expect(actionsOf(txs(prepared)[0])).toEqual([
      { Withdraw: { token_id: USDC_NEAR, max_amount: inner18(20) } },
    ])
    expect(prepared.receive?.amount).toBe('20')
  })

  it('empties plain supply exactly, naming no amount', async () => {
    account = lendAccount({ plain: [[USDC_NEAR, inner18(50)]] })
    const prepared = await rheaLendVenue.prepare(
      lend('withdraw', '50', 'USDC', { wholePosition: true }),
      ME
    )
    expect(lastCall(txs(prepared)[0]).methodName).toBe('execute')
    expect(actionsOf(txs(prepared)[0])).toEqual([{ Withdraw: { token_id: USDC_NEAR } }])
  })

  it('empties supply and collateral exactly, with prices', async () => {
    account = lendAccount({
      plain: [[USDC_NEAR, inner18(10)]],
      collateral: [[USDC_NEAR, inner18(40)]],
    })
    const prepared = await rheaLendVenue.prepare(
      lend('withdraw', '50', 'USDC', { wholePosition: true }),
      ME
    )
    expect(() => rheaLendVenue.assertSafe(prepared.signing, ME)).not.toThrow()
    expect(lastCall(txs(prepared)[0]).methodName).toBe('execute_with_pyth')
    expect(actionsOf(txs(prepared)[0])).toEqual([
      { DecreaseCollateral: { token_id: USDC_NEAR } },
      { Withdraw: { token_id: USDC_NEAR } },
    ])
  })

  it('releases only the collateral it needs beyond plain supply', async () => {
    account = lendAccount({
      plain: [[USDC_NEAR, inner18(10)]],
      collateral: [[USDC_NEAR, inner18(40)]],
    })
    const prepared = await rheaLendVenue.prepare(lend('withdraw', '25'), ME)
    expect(actionsOf(txs(prepared)[0])).toEqual([
      { DecreaseCollateral: { token_id: USDC_NEAR, amount: inner18(15) } },
      { Withdraw: { token_id: USDC_NEAR, max_amount: inner18(25) } },
    ])
  })

  it('refuses what would leave a loan without enough behind it, and says what could go', async () => {
    account = lendAccount({
      collateral: [[USDC_NEAR, inner18(100)]],
      borrowed: [[USDT_NEAR, inner18(50)]],
    })
    await expect(rheaLendVenue.prepare(lend('withdraw', '40'), ME)).rejects.toThrow(
      /without enough behind it. You could take out about 33\.5/
    )
    await expect(
      rheaLendVenue.prepare(lend('withdraw', '100', 'USDC', { wholePosition: true }), ME)
    ).rejects.toThrow(/without enough behind it/)
  })

  it('allows what leaves a loan safe, and states the risk that remains', async () => {
    account = lendAccount({
      collateral: [[USDC_NEAR, inner18(100)]],
      borrowed: [[USDT_NEAR, inner18(50)]],
    })
    const prepared = await rheaLendVenue.prepare(lend('withdraw', '30'), ME)
    expect(prepared.notes.join(' ')).toMatch(/You can lose your collateral/)
  })

  it('says to repay first when everything is backing the loan', async () => {
    account = lendAccount({
      collateral: [[USDC_NEAR, inner18(100)]],
      borrowed: [[USDT_NEAR, inner18(75)]],
    })
    await expect(rheaLendVenue.prepare(lend('withdraw', '10'), ME)).rejects.toThrow(/repay first/)
  })

  it('takes plain supply past a loan, which it does not back', async () => {
    account = lendAccount({
      plain: [[USDC_NEAR, inner18(10)]],
      collateral: [[USDT_NEAR, inner18(100)]],
      borrowed: [[USDT_NEAR, inner18(75)]],
    })
    const prepared = await rheaLendVenue.prepare(lend('withdraw', '10'), ME)
    expect(lastCall(txs(prepared)[0]).methodName).toBe('execute')
  })

  it('refuses more than is free to leave, and says how much is', async () => {
    account = lendAccount({ plain: [[USDC_NEAR, inner18(50)]] })
    const usdc = assets[USDC_NEAR] as { supplied: unknown }
    usdc.supplied = { balance: inner18(800_020) }
    await expect(rheaLendVenue.prepare(lend('withdraw', '30'), ME)).rejects.toThrow(
      /Only about 20 USDC can leave Rhea Lend right now, because borrowers hold the rest/
    )
  })

  it('refuses more than you have, nothing, a stopped market and a locked account', async () => {
    await expect(rheaLendVenue.prepare(lend('withdraw', '1'), ME)).rejects.toThrow(/no USDC/)
    account = lendAccount({ plain: [[USDC_NEAR, inner18(1)]] })
    await expect(rheaLendVenue.prepare(lend('withdraw', '5'), ME)).rejects.toThrow(/less than 5/)
    const usdc = assets[USDC_NEAR] as { config: Record<string, unknown> }
    usdc.config['can_withdraw'] = false
    await expect(rheaLendVenue.prepare(lend('withdraw', '1'), ME)).rejects.toThrow(/stopped/)
    account = lendAccount({ plain: [[USDC_NEAR, inner18(1)]], locked: true })
    await expect(rheaLendVenue.prepare(lend('withdraw', '1'), ME)).rejects.toThrow(/locked/)
  })

  it('hands NEAR back as NEAR, and registers first if it could not reach you', async () => {
    account = lendAccount({ plain: [[WRAP_NEAR, yocto(3)]] })
    rpc.views[`${WRAP_NEAR}.storage_balance_of`] = () => null
    const prepared = await rheaLendVenue.prepare(lend('withdraw', '3', 'NEAR'), ME)
    expect(() => rheaLendVenue.assertSafe(prepared.signing, ME)).not.toThrow()
    expect(txs(prepared).map((t) => methods(t)[0])).toEqual([
      'storage_deposit',
      'execute',
      'near_withdraw',
    ])
  })
})

describe('repaying on Rhea Lend', () => {
  const owing = (): unknown =>
    lendAccount({
      collateral: [[USDC_NEAR, inner18(100)]],
      borrowed: [[USDT_NEAR, inner18(50)]],
    })
  const repayment = (amount: string): string =>
    JSON.stringify({
      Execute: {
        actions: [{ Repay: { token_id: USDT_NEAR, max_amount: `${amount}000000000000` } }],
      },
    })

  it('repays exactly what is sent, and nothing else held there', async () => {
    account = owing()
    const prepared = await rheaLendVenue.prepare(lend('repay', '20', 'USDT'), ME)
    expect(() => rheaLendVenue.assertSafe(prepared.signing, ME)).not.toThrow()
    const [tx] = txs(prepared)
    expect(tx?.receiverId).toBe(USDT_NEAR)
    expect(lastCall(tx).args).toEqual({
      receiver_id: RHEA_LEND,
      amount: dollars(20),
      msg: repayment(dollars(20)),
    })
  })

  it('clears a whole loan by sending a little over, and says where the rest goes', async () => {
    account = owing()
    const prepared = await rheaLendVenue.prepare(
      lend('repay', '50', 'USDT', { wholePosition: true }),
      ME
    )
    expect(() => rheaLendVenue.assertSafe(prepared.signing, ME)).not.toThrow()
    expect(lastCall(txs(prepared)[0]).args['amount']).toBe('50050001')
    expect(lastCall(txs(prepared)[0]).args['msg']).toBe(repayment('50050001'))
    expect(prepared.pay).toEqual({ amount: '50.050001', symbol: 'USDT' })
    expect(prepared.notes.join(' ')).toMatch(/stays as your supply/)
  })

  it('rounds what is owed up, so no fraction of a unit stays owed', async () => {
    account = lendAccount({ borrowed: [[USDT_NEAR, '50000000000000000001']] })
    const prepared = await rheaLendVenue.prepare(
      lend('repay', '50', 'USDT', { wholePosition: true }),
      ME
    )
    expect(lastCall(txs(prepared)[0]).args['amount']).toBe('50050002')
  })

  it('sends what the wallet holds if that covers the debt but not the margin', async () => {
    account = owing()
    rpc.views[`${USDT_NEAR}.ft_balance_of`] = () => dollars(50)
    const prepared = await rheaLendVenue.prepare(
      lend('repay', '50', 'USDT', { wholePosition: true }),
      ME
    )
    expect(lastCall(txs(prepared)[0]).args['amount']).toBe(dollars(50))
  })

  it('refuses paying more than is owed, less than is held, and a loan that is not there', async () => {
    await expect(rheaLendVenue.prepare(lend('repay', '1', 'USDT'), ME)).rejects.toThrow(
      /don't owe any USDT/
    )
    account = owing()
    await expect(rheaLendVenue.prepare(lend('repay', '60', 'USDT'), ME)).rejects.toThrow(
      /repay all USDT/
    )
    rpc.views[`${USDT_NEAR}.ft_balance_of`] = () => dollars(5)
    await expect(rheaLendVenue.prepare(lend('repay', '20', 'USDT'), ME)).rejects.toThrow(
      /You hold 5 USDT/
    )
    await expect(
      rheaLendVenue.prepare(lend('repay', '50', 'USDT', { wholePosition: true }), ME)
    ).rejects.toThrow(/You hold 5 USDT/)
  })

  it('wraps NEAR for a NEAR loan in the same transaction', async () => {
    account = lendAccount({ borrowed: [[WRAP_NEAR, yocto(2)]] })
    const prepared = await rheaLendVenue.prepare(lend('repay', '1', 'NEAR'), ME)
    expect(() => rheaLendVenue.assertSafe(prepared.signing, ME)).not.toThrow()
    expect(methods(txs(prepared)[0])).toEqual(['near_deposit', 'ft_transfer_call'])
  })
})

describe('reading a Rhea Lend position', () => {
  it('adds plain supply and collateral, shows debt, and leaves out unlisted tokens', async () => {
    account = lendAccount({
      plain: [
        [USDC_NEAR, inner18(10)],
        ['dai.near', inner18(5)],
      ],
      collateral: [
        [USDC_NEAR, inner18(40)],
        [WRAP_NEAR, yocto(2)],
      ],
      borrowed: [[USDT_NEAR, '12345678000000000000']],
    })
    await expect(rheaLendVenue.positions?.(ME)).resolves.toEqual([
      { slot: 'supplied', symbol: 'NEAR', amount: '2' },
      { slot: 'supplied', symbol: 'USDC', amount: '50' },
      { slot: 'borrowed', symbol: 'USDT', amount: '12.345678' },
    ])
  })

  it('is empty for an account with nothing there', async () => {
    await expect(rheaLendVenue.positions?.(ME)).resolves.toEqual([])
  })

  it('throws, rather than reading as empty, when it can not read', async () => {
    rpc.down = true
    await expect(rheaLendVenue.positions?.(ME)).rejects.toThrow()
  })
})

describe('an exit through the shared routing', () => {
  const chain: ChainModule = {
    ...nearModule,
    venues: [rheaLendVenue, rheaDexVenue],
    defaultVenue: {},
  }

  it('goes to whichever venue holds it, and reaches it whole', async () => {
    account = lendAccount({ collateral: [[USDC_NEAR, inner18(40)]] })
    const out = await prepareChainAction(chain, lend('withdraw', 'all'), ME)
    expect(out.venueId).toBe('rhea-lend')
    expect(actionsOf(txs(out)[0])).toEqual([
      { DecreaseCollateral: { token_id: USDC_NEAR } },
      { Withdraw: { token_id: USDC_NEAR } },
    ])
  })

  it('finds tokens stranded at Rhea DEX the same way', async () => {
    rpc.views[`${RHEA_DEX}.get_deposits`] = () => ({ [USDC_NEAR]: dollars(7) })
    const out = await prepareChainAction(chain, lend('withdraw', 'all'), ME)
    expect(out.venueId).toBe('rhea-dex')
    expect(lastCall(txs(out)[0]).args).toEqual({ token_id: USDC_NEAR, amount: '0' })
  })

  it('pays off a whole loan from the word "all"', async () => {
    account = lendAccount({ borrowed: [[USDT_NEAR, inner18(10)]] })
    const out = await prepareChainAction(
      { ...chain, venues: [rheaLendVenue] },
      lend('repay', 'all', 'USDT'),
      ME
    )
    expect(lastCall(txs(out)[0]).args['amount']).toBe('10010001')
  })
})

describe('the Rhea Lend policy', () => {
  const call = (
    methodName: string,
    args: Record<string, unknown>,
    deposit = '1',
    gas = '100'
  ): NearTransaction['actions'][number] => ({
    type: 'FunctionCall',
    params: { methodName, args, gas, deposit },
  })
  const payload = (...transactions: NearTransaction[]): SigningPayload => ({
    family: 'near',
    transactions,
  })
  const exec = (actions: unknown[], method = 'execute_with_pyth'): NearTransaction => ({
    receiverId: RHEA_LEND,
    actions: [call(method, { actions })],
  })
  const borrow = { Borrow: { token_id: USDC_NEAR, amount: '5' } }
  const take = { Withdraw: { token_id: USDC_NEAR, max_amount: '5' } }

  it.each<[string, SigningPayload]>([
    ['liquidating someone', payload(exec([{ Liquidate: { account_id: THEM } }, take]))],
    ['closing someone out', payload(exec([{ ForceClose: { account_id: THEM } }, take]))],
    [
      'a callback withdrawal',
      payload(exec([{ ClientEchoWithdraw: { client_echo: 'x', asset_amount: {} } }], 'execute')),
    ],
    ['a position on LP tokens', payload(exec([{ PositionBorrow: {} }, take]))],
    ['repaying out of supply', payload(exec([{ Repay: { token_id: USDC_NEAR } }], 'execute'))],
    ['a borrow without prices', payload(exec([borrow, take], 'execute'))],
    ['a borrow left inside', payload(exec([borrow]))],
    [
      'taking out more than borrowed',
      payload(exec([borrow, { Withdraw: { token_id: USDC_NEAR, max_amount: '6' } }])),
    ],
    [
      'taking out another token',
      payload(exec([borrow, { Withdraw: { token_id: USDT_NEAR, max_amount: '5' } }])),
    ],
    ['an unlisted token', payload(exec([{ Withdraw: { token_id: 'evil.near' } }], 'execute'))],
    [
      'a recipient on a step',
      payload(exec([{ Withdraw: { token_id: USDC_NEAR, recipient: THEM } }], 'execute')),
    ],
    [
      'releasing one token and taking another',
      payload(
        exec([
          { DecreaseCollateral: { token_id: USDT_NEAR } },
          { Withdraw: { token_id: USDC_NEAR } },
        ])
      ),
    ],
    [
      'a withdrawal that can name who is paid',
      payload({
        receiverId: RHEA_LEND,
        actions: [
          call('simple_withdraw', {
            token_id: USDC_NEAR,
            amount_with_inner_decimal: '1',
            recipient_id: THEM,
          }),
        ],
      }),
    ],
    [
      'the old oracle route',
      payload({
        receiverId: 'priceoracle.near',
        actions: [call('oracle_call', { receiver_id: RHEA_LEND, msg: '{}' })],
      }),
    ],
    [
      'a deposit somewhere else',
      payload({
        receiverId: USDC_NEAR,
        actions: [call('ft_transfer_call', { receiver_id: THEM, amount: '5', msg: '' })],
      }),
    ],
    [
      'margin through a deposit message',
      payload({
        receiverId: USDC_NEAR,
        actions: [
          call('ft_transfer_call', {
            receiver_id: RHEA_LEND,
            amount: '5',
            msg: '"DepositToMargin"',
          }),
        ],
      }),
    ],
    [
      'a repayment for more than was sent',
      payload({
        receiverId: USDC_NEAR,
        actions: [
          call('ft_transfer_call', {
            receiver_id: RHEA_LEND,
            amount: '5',
            msg: JSON.stringify({
              Execute: {
                actions: [{ Repay: { token_id: USDC_NEAR, max_amount: '6000000000000' } }],
              },
            }),
          }),
        ],
      }),
    ],
    [
      'a deposit message that also withdraws',
      payload({
        receiverId: USDC_NEAR,
        actions: [
          call('ft_transfer_call', {
            receiver_id: RHEA_LEND,
            amount: '5',
            msg: JSON.stringify({ Execute: { actions: [take] } }),
          }),
        ],
      }),
    ],
    [
      'a plain transfer out',
      payload({
        receiverId: USDC_NEAR,
        actions: [call('ft_transfer', { receiver_id: THEM, amount: '5' })],
      }),
    ],
    [
      'an unwrap of NEAR this did not take out',
      payload({ receiverId: WRAP_NEAR, actions: [call('near_withdraw', { amount: '5' })] }),
    ],
    [
      'storage paid for someone else',
      payload({
        receiverId: RHEA_LEND,
        actions: [
          call(
            'storage_deposit',
            { account_id: THEM, registration_only: true },
            RHEA_LEND_STORAGE_YOCTO
          ),
        ],
      }),
    ],
    [
      'more storage than the minimum',
      payload({
        receiverId: RHEA_LEND,
        actions: [call('storage_deposit', { account_id: ME, registration_only: true }, yocto(5))],
      }),
    ],
    [
      'moving money twice',
      payload(
        exec([{ Withdraw: { token_id: USDC_NEAR } }], 'execute'),
        exec([{ Withdraw: { token_id: USDT_NEAR } }], 'execute')
      ),
    ],
    ['nothing at all', { family: 'near', transactions: [] }],
    ['another chain', { family: 'sui', transaction: 'x' }],
  ])('refuses %s', (_name, signing) => {
    expect(() => assertRheaLendSafe(signing, ME)).toThrow(ChainActionRefused)
  })

  it('refuses an account that is not one', () => {
    expect(() => assertRheaLendSafe(payload(exec([take])), 'NOT AN ACCOUNT')).toThrow(/not a NEAR/)
  })
})

describe('confirming on Rhea Lend', () => {
  const borrowCall: FakeTx = { method: 'execute_with_pyth', args: { actions: [] } }

  it('reports what ran', async () => {
    rpc.tx = () => fakeTx(borrowCall)
    await expect(confirmRheaLend(signedNear())).resolves.toMatchObject({ ok: true, hash: HASH })
  })

  it('catches a loan refused after the prices came back, though the transaction succeeded', async () => {
    rpc.tx = () => fakeTx({ ...borrowCall, receipts: [{ executor: RHEA_LEND, failed: true }] })
    const out = await confirmRheaLend(signedNear())
    expect(out.ok).toBe(false)
    expect(out).not.toHaveProperty('pending')
    expect((out as { error: string }).error).toMatch(/nothing moved/)
  })

  it('says a loan stands if its money could not reach the wallet', async () => {
    rpc.tx = () =>
      fakeTx({
        ...borrowCall,
        receipts: [
          {
            executor: RHEA_LEND,
            logs: ['EVENT_JSON:{"data":[],"event":"withdraw_failed","standard":"burrow"}'],
          },
        ],
      })
    const out = await confirmRheaLend(signedNear())
    expect(out).toMatchObject({ ok: false, pending: true })
    expect((out as { error: string }).error).toMatch(/you still owe it/)
  })

  it('reads a deposit the contract handed back', async () => {
    rpc.tx = () =>
      fakeTx({ receiver: USDC_NEAR, method: 'ft_transfer_call', args: {}, returned: '"0"' })
    const out = await confirmRheaLend(signedNear())
    expect(out.ok).toBe(false)
    expect((out as { error: string }).error).toMatch(/came back to your wallet/)
  })

  it('accepts a deposit the contract kept', async () => {
    rpc.tx = () =>
      fakeTx({ receiver: USDC_NEAR, method: 'ft_transfer_call', args: {}, returned: '"5"' })
    await expect(confirmRheaLend(signedNear())).resolves.toMatchObject({ ok: true })
  })

  it('says NEAR is there as wNEAR if only the last step failed', async () => {
    rpc.tx = (hash) =>
      fakeTx(
        hash === HASH
          ? borrowCall
          : { receiver: WRAP_NEAR, method: 'near_withdraw', args: {}, failed: true }
      )
    const out = await confirmRheaLend(signedNear([HASH, HASH2]))
    expect(out).toMatchObject({ ok: false, pending: true })
    expect((out as { error: string }).error).toMatch(/as wNEAR/)
  })

  it.each<[string, FakeTx]>([
    ['someone else signed', { ...borrowCall, signer: THEM }],
    ['it ran elsewhere', { ...borrowCall, receiver: 'evil.near' }],
    ['it is another call', { method: 'storage_withdraw', args: {} }],
    ['it only registered', { method: 'storage_deposit', args: {} }],
  ])('will not report a hash where %s', async (_name, tx) => {
    rpc.tx = () => fakeTx(tx)
    await expect(confirmRheaLend(signedNear())).resolves.toMatchObject({ ok: false, pending: true })
  })
})

describe('the listings', () => {
  it.each([rheaDexListing, rheaLendListing])('$id ships its logo and says what it does', (v) => {
    expect(existsSync(join(process.cwd(), `public/images/venues/${v.id}.webp`))).toBe(true)
    expect(v.integration).toBe('executes')
    expect(v.capability).toMatch(/Mainnet only/)
  })

  it('use the ids their venues run under', () => {
    expect(rheaDexVenue.id).toBe(rheaDexListing.id)
    expect(rheaLendVenue.id).toBe(rheaLendListing.id)
  })
})
