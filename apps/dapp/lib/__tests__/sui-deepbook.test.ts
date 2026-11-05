import { bcs } from '@mysten/sui/bcs'
import { Transaction } from '@mysten/sui/transactions'
import { fromBase64, normalizeStructTag, toBase64 } from '@mysten/sui/utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { deepbookBook, deepbookVenue } from '../chains/sui/deepbook'
import { decodeOrderId, deepbookAssertSafe, orderFigures } from '../chains/sui/deepbook-rules'
import { ChainActionRefused, type ChainActionRequest, type PreparedAction } from '../chains/types'

const ME = '0xc6fa48a7455bff49124318d5297320441cfac33f83ceea890c485372de917df4'
const THIEF = `0x${'dead'.repeat(16)}`
const MANAGER = `0x${'a1'.repeat(32)}`
const OTHER_MANAGER = `0x${'a2'.repeat(32)}`
const GAS_COIN = `0x${'c1'.repeat(32)}`
const USDC_COIN = `0x${'c2'.repeat(32)}`
const USDC_COIN_2 = `0x${'c3'.repeat(32)}`
const DIGEST = '11111111111111111111111111111111'

const PACKAGE = '0xbca0cefe720330e7bb4f2283438b68de6a0e656688db4ac90d61e71fe6151fe8'
const TYPES = '0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809'
const POOL = '0xe05dafb5133bcffb8d59f4e12465dc0e9faeaa05e3e342a08fe135800e3e4407'
const OTHER_POOL = '0xf948981b806057580f91622417534f491da5f61aeaf33d0ed8e69fd5691c95ce'
const REGISTRY = '0xaf16199a2dff736e9f07a845f23c5da6df6f756eddb631aed9d24a93efc4549d'
const SUI = normalizeStructTag('0x2::sui::SUI')
const USDC = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'
const USDT = '0x375f70cf2ae4c00bf37117d0c85a2c71545e6ee05c4a5c7d282cd66a4504b068::usdt::USDT'
const MANAGER_TYPE = `${TYPES}::balance_manager::BalanceManager`

const NOW = 1_793_720_000_000
const DAY = 86_400_000

const VecSetOfIds = bcs.struct('VecSet', { contents: bcs.vector(bcs.Address) })
const ManagerBytes = bcs.struct('BalanceManager', {
  id: bcs.Address,
  owner: bcs.Address,
  balances: bcs.struct('Bag', { id: bcs.Address, size: bcs.u64() }),
  allow_listed: VecSetOfIds,
})
const BalancesBytes = bcs.struct('Balances', { base: bcs.u64(), quote: bcs.u64(), deep: bcs.u64() })
const AccountBytes = bcs.struct('Account', {
  epoch: bcs.u64(),
  open_orders: bcs.struct('VecSet', { contents: bcs.vector(bcs.u128()) }),
  taker_volume: bcs.u128(),
  maker_volume: bcs.u128(),
  active_stake: bcs.u64(),
  inactive_stake: bcs.u64(),
  created_proposal: bcs.bool(),
  voted_proposal: bcs.option(bcs.Address),
  unclaimed_rebates: BalancesBytes,
  settled_balances: BalancesBytes,
  owed_balances: BalancesBytes,
})
const OrderBytes = bcs.struct('Order', {
  balance_manager_id: bcs.Address,
  order_id: bcs.u128(),
  client_order_id: bcs.u64(),
  quantity: bcs.u64(),
  filled_quantity: bcs.u64(),
  fee_is_deep: bcs.bool(),
  order_deep_price: bcs.struct('OrderDeepPrice', {
    asset_is_base: bcs.bool(),
    deep_per_asset: bcs.u64(),
  }),
  epoch: bcs.u64(),
  status: bcs.u8(),
  expire_timestamp: bcs.u64(),
})

const encodeOrderId = (isBid: boolean, price: bigint, counter: bigint): bigint =>
  (isBid ? BigInt(0) : BigInt(1) << BigInt(127)) + (price << BigInt(64)) + counter

interface FakeOrder {
  id: bigint
  quantity: bigint
  filled: bigint
  expires: number
}

function fakeOrder(isBid: boolean, price: string, quantity: string, filled = '0'): FakeOrder {
  return {
    id: encodeOrderId(isBid, BigInt(price), BigInt(7)),
    quantity: BigInt(quantity),
    filled: BigInt(filled),
    expires: NOW + 7 * DAY,
  }
}

interface ManagerState {
  owner: string
  caps?: string[]
  type?: string
  orders?: FakeOrder[]
  sui?: string
  usdc?: string
  settledBase?: string
  settledQuote?: string
  noAccount?: boolean
}

interface Chain {
  managers: Record<string, ManagerState>
  registered: string[]
  makerFee: string
  suiAddressBalance: string
  usdcAddressBalance: string
  usdcCoins: { id: string; balance: string }[]
  simulateFails: boolean
  builds: number
}

let chain: Chain

function freshChain(): Chain {
  return {
    managers: {},
    registered: [],
    makerFee: '0',
    suiAddressBalance: '0',
    usdcAddressBalance: '0',
    usdcCoins: [{ id: USDC_COIN, balance: '20000000' }],
    simulateFails: false,
    builds: 0,
  }
}

const u64 = (value: string | number | bigint): Uint8Array => bcs.u64().serialize(value).toBytes()

type Read = {
  function: string
  typeArguments: readonly string[]
  arguments: readonly { $kind: string; Input?: number }[]
}

function objectIdOf(tx: Transaction, argument: { Input?: number } | undefined): string | undefined {
  const input = tx.getData().inputs[argument?.Input ?? -1]
  return input?.Object?.SharedObject?.objectId
}

function answer(tx: Transaction, call: Read): Uint8Array[] {
  const managerOf = (index: number): ManagerState => {
    const id = objectIdOf(tx, call.arguments[index])
    return chain.managers[id ?? ''] ?? { owner: ME }
  }
  switch (call.function) {
    case 'pool_book_params':
      return [u64('10'), u64('100000000'), u64('1000000000')]
    case 'pool_trade_params':
      return [u64('200000'), u64(chain.makerFee), u64('100000000000')]
    case 'get_balance_manager_ids':
      return [VecSetOfIds.serialize({ contents: chain.registered }).toBytes()]
    case 'account_exists':
      return [
        bcs
          .bool()
          .serialize(managerOf(1).noAccount !== true)
          .toBytes(),
      ]
    case 'balance':
      return [
        u64(
          normalizeStructTag(call.typeArguments[0] as string) === SUI
            ? (managerOf(0).sui ?? '0')
            : (managerOf(0).usdc ?? '0')
        ),
      ]
    case 'get_account_order_details':
      return [
        bcs
          .vector(OrderBytes)
          .serialize(
            (managerOf(1).orders ?? []).map((o) => ({
              balance_manager_id: MANAGER,
              order_id: o.id,
              client_order_id: '0',
              quantity: o.quantity,
              filled_quantity: o.filled,
              fee_is_deep: false,
              order_deep_price: { asset_is_base: true, deep_per_asset: '0' },
              epoch: '900',
              status: 0,
              expire_timestamp: String(o.expires),
            }))
          )
          .toBytes(),
      ]
    case 'account': {
      const m = managerOf(1)
      const none = { base: '0', quote: '0', deep: '0' }
      return [
        AccountBytes.serialize({
          epoch: '900',
          open_orders: { contents: [] },
          taker_volume: '0',
          maker_volume: '0',
          active_stake: '0',
          inactive_stake: '0',
          created_proposal: false,
          voted_proposal: null,
          unclaimed_rebates: none,
          settled_balances: {
            base: m.settledBase ?? '0',
            quote: m.settledQuote ?? '0',
            deep: '0',
          },
          owed_balances: none,
        }).toBytes(),
      ]
    }
    default:
      throw new Error(`nothing answers ${call.function}`)
  }
}

const fakeClient = {
  core: {
    simulateTransaction: async ({ transaction }: { transaction: Transaction }) => {
      if (chain.simulateFails) throw new Error('fetch failed')
      const commandResults = transaction.getData().commands.map((command) => ({
        returnValues: answer(transaction, command.MoveCall as Read).map((value) => ({
          bcs: value,
        })),
        mutatedReferences: [],
      }))
      return { $kind: 'Transaction', Transaction: {}, commandResults }
    },
    getObject: async ({ objectId }: { objectId: string }) => {
      const manager = chain.managers[objectId]
      if (manager === undefined) throw new Error('Object not found')
      return {
        object: {
          objectId,
          version: '500',
          digest: DIGEST,
          owner: { $kind: 'Shared', Shared: { initialSharedVersion: '123' } },
          type: manager.type ?? MANAGER_TYPE,
          content: ManagerBytes.serialize({
            id: objectId,
            owner: manager.owner,
            balances: { id: OTHER_MANAGER, size: '1' },
            allow_listed: { contents: manager.caps ?? [] },
          }).toBytes(),
        },
      }
    },
    getBalance: async ({ coinType }: { coinType: string }) => {
      const usdc = chain.usdcCoins.reduce((sum, c) => sum + BigInt(c.balance), BigInt(0))
      const address =
        normalizeStructTag(coinType) === SUI ? chain.suiAddressBalance : chain.usdcAddressBalance
      return {
        balance: {
          coinType,
          balance: String(usdc + BigInt(address)),
          coinBalance: String(usdc),
          addressBalance: address,
        },
      }
    },
    listCoins: async () => ({
      objects: chain.usdcCoins.map((c) => ({
        objectId: c.id,
        digest: DIGEST,
        version: '9',
        balance: c.balance,
      })),
      hasNextPage: false,
      cursor: null,
    }),
    resolveTransactionPlugin:
      () =>
      async (
        data: { gasData: { budget?: unknown; price?: unknown; payment?: unknown } },
        _options: unknown,
        next: () => Promise<void>
      ) => {
        chain.builds += 1
        data.gasData.budget ??= '100000000'
        data.gasData.price ??= '1000'
        data.gasData.payment ??= [{ objectId: GAS_COIN, version: '4', digest: DIGEST }]
        await next()
      },
  },
}

vi.mock('../chains/sui/client', async (original) => ({
  ...(await original<typeof import('../chains/sui/client')>()),
  suiClient: () => fakeClient,
}))

beforeEach(() => {
  chain = freshChain()
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
})

afterEach(() => {
  vi.useRealTimers()
})

function sell(amount = '2', limitPrice = '1.10'): ChainActionRequest {
  return { kind: 'limit', amount, tokenIn: 'SUI', tokenOut: 'USDC', limitPrice }
}

function buy(amount = '11', limitPrice = '1.00'): ChainActionRequest {
  return { kind: 'limit', amount, tokenIn: 'USDC', tokenOut: 'SUI', limitPrice }
}

const bytesOf = (prepared: PreparedAction): string => {
  if (prepared.signing.family !== 'sui') throw new Error('Expected Sui.')
  return prepared.signing.transaction
}

const dataOf = (prepared: PreparedAction) => Transaction.from(bytesOf(prepared)).getData()

const inputIndex = (argument: object | undefined): number =>
  (argument as { Input?: number } | undefined)?.Input ?? -1

function stepNames(prepared: PreparedAction): string[] {
  return dataOf(prepared).commands.map((c) =>
    c.$kind === 'MoveCall' ? c.MoveCall.function : c.$kind
  )
}

function callOf(prepared: PreparedAction, fn: string) {
  const data = dataOf(prepared)
  const call = data.commands.find((c) => c.MoveCall?.function === fn)?.MoveCall
  if (call === undefined) throw new Error(`no ${fn}`)
  const pure = (index: number): Uint8Array => {
    const input = data.inputs[inputIndex(call.arguments[index])]
    if (input?.Pure === undefined) throw new Error(`argument ${index} is not pure`)
    return fromBase64(input.Pure.bytes)
  }
  return { call, pure, data }
}

function placed(prepared: PreparedAction) {
  const { pure } = callOf(prepared, 'place_limit_order')
  return {
    orderType: bcs.u8().parse(pure(4)),
    selfMatching: bcs.u8().parse(pure(5)),
    price: bcs.u64().parse(pure(6)),
    quantity: bcs.u64().parse(pure(7)),
    isBid: bcs.bool().parse(pure(8)),
    payWithDeep: bcs.bool().parse(pure(9)),
    expiry: Number(bcs.u64().parse(pure(10))),
  }
}

function splitAmounts(prepared: PreparedAction): string[] {
  const data = dataOf(prepared)
  const split = data.commands.find((c) => c.$kind === 'SplitCoins')?.SplitCoins
  return (split?.amounts ?? []).map((a) =>
    bcs.u64().parse(fromBase64(data.inputs[inputIndex(a)]?.Pure?.bytes ?? ''))
  )
}

const FIRST_USE_SELL = [
  'SplitCoins',
  'new',
  'deposit',
  'generate_proof_as_owner',
  'place_limit_order',
  'register_balance_manager',
  'public_share_object',
]

function useExistingManager(state: Partial<ManagerState> = {}): void {
  chain.registered = [MANAGER]
  chain.managers[MANAGER] = { owner: ME, ...state }
}

describe('placing an order', () => {
  it('sells 2 SUI at 1.10: deposits 2 SUI and places an ask, sharing a new manager last', async () => {
    const prepared = await deepbookVenue.prepare(sell(), ME)
    expect(stepNames(prepared)).toEqual(FIRST_USE_SELL)
    expect(splitAmounts(prepared)).toEqual(['2000000000'])
    expect(placed(prepared)).toEqual({
      orderType: 3,
      selfMatching: 0,
      price: '1100000',
      quantity: '2000000000',
      isBid: false,
      payWithDeep: false,
      expiry: NOW + 7 * DAY,
    })
    const { call } = callOf(prepared, 'place_limit_order')
    expect(call.typeArguments.map((t) => normalizeStructTag(t))).toEqual([SUI, USDC])
    expect(
      callOf(prepared, 'deposit').call.typeArguments.map((t) => normalizeStructTag(t))
    ).toEqual([SUI])
    expect(callOf(prepared, 'public_share_object').call.typeArguments).toEqual([MANAGER_TYPE])
    expect(prepared.pay).toEqual({ amount: '2', symbol: 'SUI' })
    expect(prepared.receive).toEqual({ amount: '2.2', symbol: 'USDC', approximate: false })
    expect(prepared.summary).toBe('Offer 2 SUI on DeepBook for 2.2 USDC, at 1.1 USDC per SUI.')
  })

  it('takes one signature on first use, so nothing asks to be prepared again', async () => {
    const prepared = await deepbookVenue.prepare(sell(), ME)
    expect(prepared.thenPrepareAgain).toBeUndefined()
  })

  it('buys with 11 USDC at 1.00: deposits 11 USDC and places a bid for 11 SUI', async () => {
    const prepared = await deepbookVenue.prepare(buy(), ME)
    expect(splitAmounts(prepared)).toEqual(['11000000'])
    expect(
      callOf(prepared, 'deposit').call.typeArguments.map((t) => normalizeStructTag(t))
    ).toEqual([USDC])
    expect(placed(prepared)).toMatchObject({
      price: '1000000',
      quantity: '11000000000',
      isBid: true,
      orderType: 3,
    })
    expect(prepared.pay).toEqual({ amount: '11', symbol: 'USDC' })
    expect(prepared.receive).toEqual({ amount: '11', symbol: 'SUI', approximate: false })
  })

  it('uses the manager the wallet already has, and creates and shares nothing', async () => {
    useExistingManager()
    const prepared = await deepbookVenue.prepare(sell(), ME)
    expect(stepNames(prepared)).toEqual([
      'SplitCoins',
      'deposit',
      'generate_proof_as_owner',
      'place_limit_order',
    ])
    const { call, data } = callOf(prepared, 'deposit')
    expect(data.inputs[inputIndex(call.arguments[0])]?.Object?.SharedObject).toMatchObject({
      objectId: MANAGER,
      initialSharedVersion: '123',
      mutable: true,
    })
    expect(prepared.context?.['manager']).toBe(MANAGER)
  })

  it('says it opens a DeepBook account only when it does', async () => {
    const first = await deepbookVenue.prepare(sell(), ME)
    expect(first.notes.join(' ')).toMatch(/opens a DeepBook account/)
    useExistingManager()
    const again = await deepbookVenue.prepare(sell(), ME)
    expect(again.notes.join(' ')).not.toMatch(/opens a DeepBook account/)
  })

  it('carries its notes, word for word', async () => {
    const prepared = await deepbookVenue.prepare(sell(), ME)
    expect(prepared.notes).toEqual(
      expect.arrayContaining([
        'Filled tokens stay in your DeepBook account until you press Collect, which needs a second signature. Cancelling brings back what is left in one signature.',
        'Expires in 7 days. After that, cancel it to bring back what is left.',
        'It never fills at once. If the price has already passed yours, placing it fails and nothing moves.',
        "DeepBook's contracts can be upgraded by the multisig that holds their upgrade key, so your deposit carries that risk.",
      ])
    )
  })

  it('refuses under the minimum, read from the chain', async () => {
    await expect(deepbookVenue.prepare(sell('0.9'), ME)).rejects.toThrow(
      "DeepBook's smallest SUI order is 1 SUI. Nothing was signed or sent."
    )
    await expect(deepbookVenue.prepare(buy('0.9', '1'), ME)).rejects.toThrow(
      "DeepBook's smallest SUI order is 1 SUI. Nothing was signed or sent."
    )
  })

  it('rounds a sell off the lot down, and the card shows the rounded figure', async () => {
    const prepared = await deepbookVenue.prepare(sell('2.37'), ME)
    expect(placed(prepared).quantity).toBe('2300000000')
    expect(splitAmounts(prepared)).toEqual(['2300000000'])
    expect(prepared.pay).toEqual({ amount: '2.3', symbol: 'SUI' })
    expect(prepared.summary).toContain('2.3 SUI')
  })

  it('rounds a buy off the lot down, and deposits only what that order holds', async () => {
    const prepared = await deepbookVenue.prepare(buy('11', '1.03'), ME)
    expect(placed(prepared).quantity).toBe('10600000000')
    expect(splitAmounts(prepared)).toEqual(['10918000'])
    expect(prepared.pay).toEqual({ amount: '10.918', symbol: 'USDC' })
    expect(prepared.receive?.amount).toBe('10.6')
  })

  it('refuses anything but SUI against USDC', async () => {
    await expect(deepbookVenue.prepare({ ...sell(), tokenOut: 'USDT' }, ME)).rejects.toThrow(
      'DeepBook orders here take SUI against USDC only. Nothing was signed or sent.'
    )
    await expect(
      deepbookVenue.prepare(
        { kind: 'limit', amount: '5', tokenIn: 'USDC', tokenOut: 'USDsui', limitPrice: '1' },
        ME
      )
    ).rejects.toThrow(
      'DeepBook orders here take SUI against USDC only. Nothing was signed or sent.'
    )
  })

  it('refuses a kind it does not do', async () => {
    await expect(
      deepbookVenue.prepare({ kind: 'swap', amount: '2', tokenIn: 'SUI', tokenOut: 'USDC' }, ME)
    ).rejects.toThrow(/Nothing was signed or sent\.$/)
  })

  it('refuses a resting fee it has not been checked against', async () => {
    chain.makerFee = '100000'
    await expect(deepbookVenue.prepare(sell(), ME)).rejects.toThrow(
      /charges a fee to rest an order.*Nothing was signed or sent\.$/
    )
  })

  it('refuses in words when it cannot read the pool, and builds nothing', async () => {
    chain.simulateFails = true
    await expect(deepbookVenue.prepare(sell(), ME)).rejects.toThrow(ChainActionRefused)
    await expect(deepbookVenue.prepare(sell(), ME)).rejects.toThrow(
      /couldn’t read DeepBook.*Nothing was signed or sent\.$/
    )
    expect(chain.builds).toBe(0)
  })

  it('ends a refusal from the build in the same words as every other', async () => {
    chain.usdcCoins = [{ id: USDC_COIN, balance: '5' }]
    await expect(deepbookVenue.prepare(buy(), ME)).rejects.toThrow(
      /enough USDC.*Nothing was signed or sent\.$/
    )
  })

  it('counts the first-use storage in what the reserve keeps back', () => {
    expect(deepbookVenue.limitCost).toEqual({ amount: '0.02', symbol: 'SUI' })
  })
})

describe('an existing manager', () => {
  it('is refused before anything is built when its owner on chain is someone else', async () => {
    useExistingManager({ owner: THIEF })
    await expect(deepbookVenue.prepare(sell(), ME)).rejects.toThrow(
      /belongs to another wallet.*Nothing was signed or sent\.$/
    )
    expect(chain.builds).toBe(0)
  })

  it('is passed over, and never deposited into, when the object is not a BalanceManager', async () => {
    useExistingManager({ type: `${TYPES}::balance_manager::Lookalike` })
    const prepared = await deepbookVenue.prepare(sell(), ME)
    expect(stepNames(prepared)).toEqual(FIRST_USE_SELL)
    expect(prepared.context?.['manager']).toBe('new')
  })

  it('is passed over when it can’t be read on its own, as one held inside another object can’t', async () => {
    chain.registered = [OTHER_MANAGER, MANAGER]
    chain.managers[MANAGER] = { owner: ME }
    const prepared = await deepbookVenue.prepare(sell(), ME)
    expect(prepared.context?.['manager']).toBe(MANAGER)
  })

  it('takes no deposit when a cap has been minted on it, and opens a clean one instead', async () => {
    useExistingManager({ caps: [THIEF] })
    const prepared = await deepbookVenue.prepare(sell(), ME)
    expect(stepNames(prepared)).toEqual(FIRST_USE_SELL)
    expect(prepared.context?.['manager']).toBe('new')
  })

  it('prefers a clean manager over one with a cap', async () => {
    chain.registered = [OTHER_MANAGER, MANAGER]
    chain.managers[OTHER_MANAGER] = { owner: ME, caps: [THIEF] }
    chain.managers[MANAGER] = { owner: ME }
    const prepared = await deepbookVenue.prepare(sell(), ME)
    expect(prepared.context?.['manager']).toBe(MANAGER)
  })
})

describe('orderFigures', () => {
  const book = { tick: BigInt(10), lot: BigInt(100000000), min: BigInt(1000000000) }

  it('rounds a sell price up to the tick, so it never accepts less than stated', () => {
    const f = orderFigures({ amount: '2', price: '1.100001', selling: true, book })
    expect(f.price.toString()).toBe('1100010')
  })

  it('rounds a buy price down to the tick, so it never pays more than stated', () => {
    const f = orderFigures({ amount: '11', price: '1.100009', selling: false, book })
    expect(f.price.toString()).toBe('1100000')
  })

  it('uses the tick it is given, not one it assumes', () => {
    const f = orderFigures({
      amount: '2',
      price: '1.1005',
      selling: false,
      book: { ...book, tick: BigInt(10000) },
    })
    expect(f.price.toString()).toBe('1100000')
  })

  it('refuses a price that rounds to nothing', () => {
    expect(() => orderFigures({ amount: '11', price: '0.000001', selling: false, book })).toThrow(
      /Nothing was signed or sent\.$/
    )
  })

  it('refuses text that is no price', () => {
    expect(() => orderFigures({ amount: '2', price: 'lots', selling: true, book })).toThrow(
      /Nothing was signed or sent\.$/
    )
  })

  it('says what the receive is at the order’s own price', () => {
    const f = orderFigures({ amount: '2.37', price: '1.1', selling: true, book })
    expect(f.quantity.toString()).toBe('2300000000')
    expect(f.deposit.toString()).toBe('2300000000')
    expect(f.receive.toString()).toBe('2530000')
  })
})

interface JsonCall {
  package: string
  module: string
  function: string
  typeArguments: string[]
  arguments: { Input?: number; Result?: number; NestedResult?: [number, number]; GasCoin?: true }[]
}
interface JsonMerge {
  destination: unknown
  sources: unknown[]
}
interface JsonCommand {
  MoveCall?: JsonCall
  SplitCoins?: { coin: unknown; amounts: { Input: number }[] }
  MergeCoins?: JsonMerge
  TransferObjects?: { objects: unknown[]; address: { Input: number } }
}
interface JsonInput {
  Pure?: { bytes: string }
  Object?: {
    SharedObject?: { objectId: string; initialSharedVersion: string; mutable: boolean }
    ImmOrOwnedObject?: { objectId: string; version: string; digest: string }
  }
}
interface JsonTx {
  inputs: JsonInput[]
  commands: JsonCommand[]
}

async function rewrite(base: string, edit: (data: JsonTx) => void): Promise<string> {
  const data = JSON.parse(await Transaction.from(base).toJSON()) as JsonTx
  edit(data)
  return toBase64(await Transaction.from(JSON.stringify(data)).build())
}

const callIn = (data: JsonTx, fn: string): JsonCall => {
  const call = data.commands.find((c) => c.MoveCall?.function === fn)?.MoveCall
  if (call === undefined) throw new Error(`no ${fn}`)
  return call
}

function setPure(data: JsonTx, fn: string, index: number, bytes: Uint8Array): void {
  const input = callIn(data, fn).arguments[index]?.Input as number
  const target = data.inputs[input]
  if (target?.Pure === undefined) throw new Error('not pure')
  target.Pure.bytes = toBase64(bytes)
}

function check(transaction: string, context: Record<string, string> | undefined): void {
  deepbookAssertSafe({ family: 'sui', transaction }, ME, context)
}

const NOT_SENT = /Nothing was signed or sent\.$/

describe('DEEPBOOK_POLICY on a placed order', () => {
  async function firstUse(request = sell()) {
    const prepared = await deepbookVenue.prepare(request, ME)
    return { base: bytesOf(prepared), context: prepared.context }
  }

  it('passes what it built, and a copy of it re-sealed unchanged', async () => {
    const { base, context } = await firstUse()
    expect(() => check(base, context)).not.toThrow()
    const resealed = await rewrite(base, () => undefined)
    expect(() => check(resealed, context)).not.toThrow()
  })

  it('passes a buy and an existing manager', async () => {
    const buying = await firstUse(buy())
    expect(() => check(buying.base, buying.context)).not.toThrow()
    useExistingManager()
    const existing = await firstUse()
    expect(() => check(existing.base, existing.context)).not.toThrow()
  })

  it('passes the coin shapes a wallet’s holdings can produce', async () => {
    chain.usdcCoins = [
      { id: USDC_COIN, balance: '5000000' },
      { id: USDC_COIN_2, balance: '15000000' },
    ]
    const merged = await deepbookVenue.prepare(buy(), ME)
    expect(stepNames(merged).slice(0, 2)).toEqual(['MergeCoins', 'SplitCoins'])
    expect(() => check(bytesOf(merged), merged.context)).not.toThrow()

    chain.usdcCoins = [{ id: USDC_COIN, balance: '11000000' }]
    const exact = await deepbookVenue.prepare(buy(), ME)
    expect(stepNames(exact).slice(0, 2)).toEqual(['SplitCoins', 'destroy_zero'])
    expect(() => check(bytesOf(exact), exact.context)).not.toThrow()

    chain.usdcCoins = []
    chain.usdcAddressBalance = '20000000'
    const fromAddress = await deepbookVenue.prepare(buy(), ME)
    expect(stepNames(fromAddress).slice(0, 3)).toEqual(['redeem_funds', 'SplitCoins', 'send_funds'])
    expect(() => check(bytesOf(fromAddress), fromAddress.context)).not.toThrow()

    chain.suiAddressBalance = '5000000000'
    const suiFromAddress = await deepbookVenue.prepare(sell(), ME)
    expect(stepNames(suiFromAddress).slice(0, 3)).toEqual([
      'redeem_funds',
      'SplitCoins',
      'send_funds',
    ])
    expect(() => check(bytesOf(suiFromAddress), suiFromAddress.context)).not.toThrow()
  })

  it.each([
    ['mint_trade_cap'],
    ['mint_deposit_cap'],
    ['mint_withdraw_cap'],
    ['set_owner'],
    ['new_with_custom_owner'],
  ])('refuses %s, by name', async (fn) => {
    const { base, context } = await firstUse()
    const tampered = await rewrite(base, (data) => {
      callIn(data, 'new').function = fn
    })
    expect(() => check(tampered, context)).toThrow(new RegExp(`balance_manager::${fn}`))
    expect(() => check(tampered, context)).toThrow(NOT_SENT)
  })

  it('refuses a cap minted beside the order, on the manager it makes', async () => {
    const { base, context } = await firstUse()
    const tampered = await rewrite(base, (data) => {
      const proof = callIn(data, 'generate_proof_as_owner')
      data.commands.push({
        MoveCall: { ...proof, function: 'mint_withdraw_cap' },
      })
    })
    expect(() => check(tampered, context)).toThrow(/mint_withdraw_cap/)
  })

  it('refuses another pool with the right types', async () => {
    const { base, context } = await firstUse()
    const tampered = await rewrite(base, (data) => {
      const input = callIn(data, 'place_limit_order').arguments[0]?.Input as number
      const shared = data.inputs[input]?.Object?.SharedObject
      if (shared === undefined) throw new Error('no pool')
      shared.objectId = OTHER_POOL
    })
    expect(() => check(tampered, context)).toThrow(/different market/)
    expect(() => check(tampered, context)).toThrow(NOT_SENT)
  })

  it('refuses wrong type arguments on the order', async () => {
    const { base, context } = await firstUse()
    const tampered = await rewrite(base, (data) => {
      callIn(data, 'place_limit_order').typeArguments = [SUI, USDT]
    })
    expect(() => check(tampered, context)).toThrow(/other tokens/)
    expect(() => check(tampered, context)).toThrow(NOT_SENT)
  })

  it('refuses a deposit of another coin', async () => {
    const { base, context } = await firstUse()
    const tampered = await rewrite(base, (data) => {
      callIn(data, 'deposit').typeArguments = [USDT]
    })
    expect(() => check(tampered, context)).toThrow(/other tokens/)
  })

  it('refuses a deposit of the other listed coin than the side asked for', async () => {
    const { base, context } = await firstUse()
    const tampered = await rewrite(base, (data) => {
      callIn(data, 'deposit').typeArguments = [USDC]
    })
    expect(() => check(tampered, context)).toThrow(/deposits the wrong token/)
  })

  it.each([
    ['price', 6, () => bcs.u64().serialize('1000000').toBytes(), /price/],
    ['quantity', 7, () => bcs.u64().serialize('3000000000').toBytes(), /amount/],
    ['side', 8, () => bcs.bool().serialize(true).toBytes(), /side/],
  ])('refuses a changed %s', async (_name, index, bytes, words) => {
    const { base, context } = await firstUse()
    const tampered = await rewrite(base, (data) => {
      setPure(data, 'place_limit_order', index, bytes())
    })
    expect(() => check(tampered, context)).toThrow(words)
    expect(() => check(tampered, context)).toThrow(NOT_SENT)
  })

  it('refuses an order type other than POST_ONLY', async () => {
    const { base, context } = await firstUse()
    for (const kind of [0, 1, 2]) {
      const tampered = await rewrite(base, (data) => {
        setPure(data, 'place_limit_order', 4, bcs.u8().serialize(kind).toBytes())
      })
      expect(() => check(tampered, context)).toThrow(/fill at once/)
    }
  })

  it('refuses paying with DEEP, and another self-matching rule', async () => {
    const { base, context } = await firstUse()
    const deep = await rewrite(base, (data) => {
      setPure(data, 'place_limit_order', 9, bcs.bool().serialize(true).toBytes())
    })
    expect(() => check(deep, context)).toThrow(/pays its fee/)
    const matching = await rewrite(base, (data) => {
      setPure(data, 'place_limit_order', 5, bcs.u8().serialize(1).toBytes())
    })
    expect(() => check(matching, context)).toThrow(/matches/)
  })

  it('refuses an expiry past 8 days, whatever the context says', async () => {
    const { base, context } = await firstUse()
    const far = String(NOW + 8 * DAY + 1)
    const tampered = await rewrite(base, (data) => {
      setPure(data, 'place_limit_order', 10, bcs.u64().serialize(far).toBytes())
    })
    expect(() => check(tampered, context)).toThrow(/8 days/)
    expect(() => check(tampered, { ...context, expiry: far })).toThrow(/8 days/)
  })

  it('refuses an expiry changed within the 8 days', async () => {
    const { base, context } = await firstUse()
    const tampered = await rewrite(base, (data) => {
      const sooner = bcs
        .u64()
        .serialize(String(NOW + DAY))
        .toBytes()
      setPure(data, 'place_limit_order', 10, sooner)
    })
    expect(() => check(tampered, context)).toThrow(/expiry/)
  })

  it('refuses sharing anything but a BalanceManager', async () => {
    const { base, context } = await firstUse()
    const tampered = await rewrite(base, (data) => {
      callIn(data, 'public_share_object').typeArguments = [`${TYPES}::pool::Pool`]
    })
    expect(() => check(tampered, context)).toThrow(/shares something/)
    expect(() => check(tampered, context)).toThrow(NOT_SENT)
  })

  it('refuses a manager that is not shared at the end', async () => {
    const { base, context } = await firstUse()
    const tampered = await rewrite(base, (data) => {
      data.commands = data.commands.filter((c) => c.MoveCall?.function !== 'public_share_object')
    })
    expect(() => check(tampered, context)).toThrow(/steps are not the ones expected/)
  })

  it('refuses a new manager left out of the registry, which a new device could not find', async () => {
    const { base, context } = await firstUse()
    const tampered = await rewrite(base, (data) => {
      data.commands = data.commands.filter(
        (c) => c.MoveCall?.function !== 'register_balance_manager'
      )
    })
    expect(() => check(tampered, context)).toThrow(/steps are not the ones expected/)
  })

  it('refuses another registry', async () => {
    const { base, context } = await firstUse()
    const tampered = await rewrite(base, (data) => {
      const input = callIn(data, 'register_balance_manager').arguments[1]?.Input as number
      const shared = data.inputs[input]?.Object?.SharedObject
      if (shared === undefined) throw new Error('no registry')
      shared.objectId = OTHER_POOL
    })
    expect(() => check(tampered, context)).toThrow(/registry/)
  })

  it('refuses a deposit coin that differs from the expected amount', async () => {
    const { base, context } = await firstUse()
    const tampered = await rewrite(base, (data) => {
      const split = data.commands.find((c) => c.SplitCoins !== undefined)?.SplitCoins
      const input = data.inputs[split?.amounts[0]?.Input as number]
      if (input?.Pure === undefined) throw new Error('no amount')
      input.Pure.bytes = toBase64(bcs.u64().serialize('3000000000').toBytes())
    })
    expect(() => check(tampered, context)).toThrow(/deposits a different amount/)
    expect(() => check(tampered, context)).toThrow(NOT_SENT)
  })

  describe('a merge beside the split', () => {
    const SPLIT = { NestedResult: [0, 0] }
    const coinInput = (objectId: string): JsonInput => ({
      Object: { ImmOrOwnedObject: { objectId, version: '9', digest: DIGEST } },
    })

    /** Adds a merge straight after the split at step 0, keeping every later step's references true. */
    function mergeAfterSplit(
      data: JsonTx,
      merge: (coin: (objectId: string) => { Input: number }) => JsonMerge
    ): void {
      const coin = (objectId: string): { Input: number } => {
        data.inputs.push(coinInput(objectId))
        return { Input: data.inputs.length - 1 }
      }
      expect(data.commands[0]?.SplitCoins).toBeDefined()
      for (const command of data.commands) {
        for (const argument of command.MoveCall?.arguments ?? []) {
          if (argument.Result !== undefined && argument.Result > 0) argument.Result += 1
          if (argument.NestedResult !== undefined && argument.NestedResult[0] > 0) {
            argument.NestedResult[0] += 1
          }
        }
      }
      data.commands.splice(1, 0, { MergeCoins: merge(coin) })
    }

    it('still passes one between other coins, which puts nothing into the deposit', async () => {
      const { base, context } = await firstUse()
      const tampered = await rewrite(base, (data) => {
        mergeAfterSplit(data, (coin) => ({
          destination: coin(USDC_COIN),
          sources: [coin(USDC_COIN_2)],
        }))
      })
      expect(() => check(tampered, context)).not.toThrow()
    })

    it('refuses more coin merged into the deposit, past what the card says', async () => {
      const { base, context } = await firstUse()
      const tampered = await rewrite(base, (data) => {
        mergeAfterSplit(data, (coin) => ({ destination: SPLIT, sources: [coin(USDC_COIN)] }))
      })
      expect(() => check(tampered, context)).toThrow(/deposits a different amount/)
      expect(() => check(tampered, context)).toThrow(NOT_SENT)
    })

    it('refuses the split merged into something else', async () => {
      const { base, context } = await firstUse()
      const tampered = await rewrite(base, (data) => {
        mergeAfterSplit(data, (coin) => ({ destination: coin(USDC_COIN), sources: [SPLIT] }))
      })
      expect(() => check(tampered, context)).toThrow(/deposits a different amount/)
    })

    it('refuses it however the split is named', async () => {
      const { base, context } = await firstUse()
      const tampered = await rewrite(base, (data) => {
        mergeAfterSplit(data, (coin) => ({
          destination: { Result: 0 },
          sources: [coin(USDC_COIN)],
        }))
      })
      expect(() => check(tampered, context)).toThrow(/deposits a different amount/)
    })
  })

  it('refuses a deposit that does not come from the split it checked', async () => {
    const { base, context } = await firstUse()
    const tampered = await rewrite(base, (data) => {
      const deposit = callIn(data, 'deposit')
      deposit.arguments[1] = { GasCoin: true }
    })
    expect(() => check(tampered, context)).toThrow(/deposits a different amount/)
  })

  it('refuses an order on a manager other than the one it funds', async () => {
    useExistingManager()
    const { base, context } = await firstUse()
    const tampered = await rewrite(base, (data) => {
      data.inputs.push({
        Object: {
          SharedObject: { objectId: OTHER_MANAGER, initialSharedVersion: '5', mutable: true },
        },
      })
      callIn(data, 'deposit').arguments[0] = { Input: data.inputs.length - 1 }
    })
    expect(() => check(tampered, context)).toThrow(/different DeepBook account/)
    expect(() => check(tampered, context)).toThrow(NOT_SENT)
  })

  it('refuses a context naming a manager the bytes do not use', async () => {
    useExistingManager()
    const { base, context } = await firstUse()
    expect(() => check(base, { ...context, manager: OTHER_MANAGER })).toThrow(
      /different DeepBook account/
    )
    expect(() => check(base, { ...context, manager: 'new' })).toThrow(
      /steps are not the ones expected/
    )
  })

  it('refuses a transfer added to the order', async () => {
    const { base, context } = await firstUse()
    const tampered = await rewrite(base, (data) => {
      const me = data.inputs.length
      data.inputs.push({ Pure: { bytes: toBase64(bcs.Address.serialize(ME).toBytes()) } })
      data.commands.push({
        TransferObjects: { objects: [{ Result: 1 }], address: { Input: me } },
      })
    })
    expect(() => check(tampered, context)).toThrow(/steps are not the ones expected/)
  })

  it.each([
    ['no context', undefined],
    ['a missing figure', { manager: 'new', side: 'sell', price: '1100000' }],
    [
      'a figure that is no number',
      {
        manager: 'new',
        side: 'sell',
        price: 'x',
        quantity: '2000000000',
        deposit: '2000000000',
        expiry: String(NOW + 7 * DAY),
      },
    ],
  ])('refuses %s', async (_name, context) => {
    const { base } = await firstUse()
    expect(() => check(base, context)).toThrow(/lost track/)
    expect(() => check(base, context)).toThrow(NOT_SENT)
  })

  it('refuses another sender', async () => {
    const { base, context } = await firstUse()
    const tx = Transaction.from(base)
    tx.setSender(THIEF)
    const tampered = toBase64(await tx.build())
    expect(() => check(tampered, context)).toThrow(/different account/)
  })
})

describe('leaving an order', () => {
  const ORDER = fakeOrder(false, '1100000', '2000000000', '500000000')
  const orderKey = `${MANAGER}:${ORDER.id}`

  beforeEach(() => {
    useExistingManager({
      orders: [ORDER],
      sui: '0',
      usdc: '0',
      settledQuote: '550000',
    })
  })

  it('cancels, then withdraws both coins to the account, in one transaction', async () => {
    const prepared = await deepbookBook().prepareExit(ME, orderKey, 'cancel')
    expect(stepNames(prepared)).toEqual([
      'generate_proof_as_owner',
      'cancel_order',
      'withdraw_all',
      'withdraw_all',
      'TransferObjects',
    ])
    const data = dataOf(prepared)
    const transfer = data.commands.at(-1)?.TransferObjects
    expect(transfer?.objects).toHaveLength(2)
    const to = data.inputs[inputIndex(transfer?.address)]?.Pure?.bytes ?? ''
    expect(bcs.Address.parse(fromBase64(to))).toBe(ME)
    const types = data.commands
      .filter((c) => c.MoveCall?.function === 'withdraw_all')
      .map((c) => normalizeStructTag(c.MoveCall?.typeArguments[0] as string))
    expect(types).toEqual([SUI, USDC])
    const { pure } = callOf(prepared, 'cancel_order')
    expect(bcs.u128().parse(pure(3))).toBe(ORDER.id.toString())
    expect(() => deepbookVenue.assertSafe(prepared.signing, ME, prepared.context)).not.toThrow()
  })

  it('says what a cancel brings back to the wallet, and where it was', async () => {
    const prepared = await deepbookBook().prepareExit(ME, orderKey, 'cancel')
    expect(prepared.summary).toBe(
      'Cancel your DeepBook order and bring 1.5 SUI and 0.55 USDC back to your wallet.'
    )
    expect(prepared.pay).toEqual({ amount: '0', symbol: 'SUI' })
    expect(prepared.receive).toEqual({ amount: '1.5', symbol: 'SUI', approximate: false })
  })

  it('collects what filled: settles it into the manager, then withdraws both', async () => {
    const prepared = await deepbookBook().prepareExit(ME, MANAGER, 'collect')
    expect(stepNames(prepared)).toEqual([
      'generate_proof_as_owner',
      'withdraw_settled_amounts',
      'withdraw_all',
      'withdraw_all',
      'TransferObjects',
    ])
    expect(prepared.summary).toBe('Move 0.55 USDC from your DeepBook account to your wallet.')
    expect(prepared.receive).toEqual({ amount: '0.55', symbol: 'USDC', approximate: false })
    expect(() => deepbookVenue.assertSafe(prepared.signing, ME, prepared.context)).not.toThrow()
  })

  it('collects from an order’s row without touching the order', async () => {
    const prepared = await deepbookBook().prepareExit(ME, orderKey, 'collect')
    expect(stepNames(prepared)).not.toContain('cancel_order')
    expect(prepared.notes.join(' ')).toMatch(/stays open/)
  })

  it('counts the manager’s balance as well as what is settled', async () => {
    useExistingManager({ sui: '1000000000', usdc: '2000000', settledQuote: '550000', orders: [] })
    const prepared = await deepbookBook().prepareExit(ME, MANAGER, 'collect')
    expect(prepared.summary).toBe(
      'Move 1 SUI and 2.55 USDC from your DeepBook account to your wallet.'
    )
  })

  it('refuses a manager that is not the account’s, for both exits', async () => {
    useExistingManager({ owner: THIEF, orders: [ORDER] })
    await expect(deepbookBook().prepareExit(ME, orderKey, 'cancel')).rejects.toThrow(
      'That order belongs to another wallet. Nothing was signed or sent.'
    )
    await expect(deepbookBook().prepareExit(ME, MANAGER, 'collect')).rejects.toThrow(
      'That order belongs to another wallet. Nothing was signed or sent.'
    )
    expect(chain.builds).toBe(0)
  })

  it('refuses an order that is not open on this account’s manager', async () => {
    const stranger = fakeOrder(false, '1100000', '2000000000').id + BigInt(1)
    await expect(
      deepbookBook().prepareExit(ME, `${MANAGER}:${stranger}`, 'cancel')
    ).rejects.toThrow(/no longer open.*Nothing was signed or sent\.$/)
    expect(chain.builds).toBe(0)
  })

  it('refuses cancelling the row of waiting money, which has no order', async () => {
    await expect(deepbookBook().prepareExit(ME, MANAGER, 'cancel')).rejects.toThrow(
      /nothing to cancel.*Nothing was signed or sent\.$/
    )
  })

  it('refuses collecting when nothing is waiting', async () => {
    useExistingManager({ orders: [] })
    await expect(deepbookBook().prepareExit(ME, MANAGER, 'collect')).rejects.toThrow(
      /nothing waiting.*Nothing was signed or sent\.$/
    )
    expect(chain.builds).toBe(0)
  })

  it('refuses an order that is not there, and something that is no order', async () => {
    await expect(deepbookBook().prepareExit(ME, `${OTHER_MANAGER}:5`, 'cancel')).rejects.toThrow(
      /Nothing was signed or sent\.$/
    )
    for (const bad of ['nonsense', `${MANAGER}:abc`, `${MANAGER}:`, '0x1']) {
      await expect(deepbookBook().prepareExit(ME, bad, 'cancel')).rejects.toThrow(
        'That is not a DeepBook order. Nothing was signed or sent.'
      )
    }
  })

  it('refuses when the manager is not a BalanceManager', async () => {
    useExistingManager({ type: `${TYPES}::balance_manager::Lookalike` })
    await expect(deepbookBook().prepareExit(ME, MANAGER, 'collect')).rejects.toThrow(
      'That is not a DeepBook order. Nothing was signed or sent.'
    )
  })

  describe('their check', () => {
    async function exit(action: 'cancel' | 'collect') {
      const prepared = await deepbookBook().prepareExit(
        ME,
        action === 'cancel' ? orderKey : MANAGER,
        action
      )
      return bytesOf(prepared)
    }

    it('passes each re-sealed unchanged', async () => {
      for (const action of ['cancel', 'collect'] as const) {
        const resealed = await rewrite(await exit(action), () => undefined)
        expect(() => check(resealed, undefined)).not.toThrow()
      }
    })

    it('refuses sending the coins to someone else', async () => {
      const tampered = await rewrite(await exit('cancel'), (data) => {
        const to = data.commands.at(-1)?.TransferObjects?.address.Input as number
        const input = data.inputs[to]
        if (input?.Pure === undefined) throw new Error('no recipient')
        input.Pure.bytes = toBase64(bcs.Address.serialize(THIEF).toBytes())
      })
      expect(() => check(tampered, undefined)).toThrow(/another address/)
    })

    it('refuses leaving a withdrawn coin out of the transfer', async () => {
      const tampered = await rewrite(await exit('collect'), (data) => {
        data.commands.at(-1)?.TransferObjects?.objects.pop()
      })
      expect(() => check(tampered, undefined)).toThrow(/does not bring both/)
    })

    it('refuses a withdrawal of another coin', async () => {
      const tampered = await rewrite(await exit('collect'), (data) => {
        const call = data.commands.find((c) => c.MoveCall?.function === 'withdraw_all')?.MoveCall
        if (call === undefined) throw new Error('no withdrawal')
        call.typeArguments = [USDT]
      })
      expect(() => check(tampered, undefined)).toThrow(/other tokens/)
    })

    it('refuses the same coin withdrawn twice', async () => {
      const tampered = await rewrite(await exit('collect'), (data) => {
        const calls = data.commands.filter((c) => c.MoveCall?.function === 'withdraw_all')
        if (calls[1]?.MoveCall === undefined) throw new Error('no withdrawal')
        calls[1].MoveCall.typeArguments = [SUI]
      })
      expect(() => check(tampered, undefined)).toThrow(/does not bring both/)
    })

    it('refuses a cancel on another pool', async () => {
      const tampered = await rewrite(await exit('cancel'), (data) => {
        const input = callIn(data, 'cancel_order').arguments[0]?.Input as number
        const shared = data.inputs[input]?.Object?.SharedObject
        if (shared === undefined) throw new Error('no pool')
        shared.objectId = OTHER_POOL
      })
      expect(() => check(tampered, undefined)).toThrow(/different market/)
    })

    it('refuses an exit that takes from a second manager', async () => {
      const tampered = await rewrite(await exit('collect'), (data) => {
        data.inputs.push({
          Object: {
            SharedObject: { objectId: OTHER_MANAGER, initialSharedVersion: '5', mutable: true },
          },
        })
        const call = data.commands.find((c) => c.MoveCall?.function === 'withdraw_all')?.MoveCall
        if (call === undefined) throw new Error('no withdrawal')
        call.arguments[0] = { Input: data.inputs.length - 1 }
      })
      expect(() => check(tampered, undefined)).toThrow(/different DeepBook account/)
    })

    it('refuses extra steps', async () => {
      const tampered = await rewrite(await exit('collect'), (data) => {
        const proof = callIn(data, 'generate_proof_as_owner')
        data.commands.splice(1, 0, { MoveCall: { ...proof } })
      })
      expect(() => check(tampered, undefined)).toThrow(/steps are not the ones expected/)
    })
  })
})

describe('reading orders', () => {
  it('reads an open sell and an open buy, with their prices and expiries', async () => {
    const asking = fakeOrder(false, '1100000', '2000000000')
    const bidding = fakeOrder(true, '900000', '3000000000')
    useExistingManager({ orders: [asking, bidding] })
    const orders = await deepbookBook().openOrders(ME)
    expect(orders).toEqual([
      {
        id: `${MANAGER}:${asking.id}`,
        venueId: 'deepbook-limit',
        tokenIn: 'SUI',
        tokenOut: 'USDC',
        amountIn: '2',
        remainingIn: '2',
        receivedOut: '0',
        limitPrice: '1.1',
        status: 'open',
        expiresAt: NOW + 7 * DAY,
      },
      {
        id: `${MANAGER}:${bidding.id}`,
        venueId: 'deepbook-limit',
        tokenIn: 'USDC',
        tokenOut: 'SUI',
        amountIn: '2.7',
        remainingIn: '2.7',
        receivedOut: '0',
        limitPrice: '0.9',
        status: 'open',
        expiresAt: NOW + 7 * DAY,
      },
    ])
  })

  it('reads what a partly filled order has given and got', async () => {
    useExistingManager({ orders: [fakeOrder(false, '1100000', '2000000000', '500000000')] })
    const [order] = await deepbookBook().openOrders(ME)
    expect(order).toMatchObject({
      status: 'partly',
      amountIn: '2',
      remainingIn: '1.5',
      receivedOut: '0.55',
    })
    expect(order?.note).toMatch(/DeepBook account, not your wallet/)
  })

  it('reads a partly filled buy', async () => {
    useExistingManager({ orders: [fakeOrder(true, '900000', '3000000000', '1000000000')] })
    const [order] = await deepbookBook().openOrders(ME)
    expect(order).toMatchObject({
      tokenIn: 'USDC',
      tokenOut: 'SUI',
      status: 'partly',
      amountIn: '2.7',
      remainingIn: '1.8',
      receivedOut: '1',
    })
  })

  it('says an expired order can only be cancelled', async () => {
    const expired = { ...fakeOrder(false, '1100000', '2000000000'), expires: NOW - 1 }
    useExistingManager({ orders: [expired] })
    const [order] = await deepbookBook().openOrders(ME)
    expect(order?.status).toBe('open')
    expect(order?.note).toMatch(/expired.*Cancel/)
  })

  it('marks money waiting as collectable, and never as being in the wallet', async () => {
    useExistingManager({ sui: '1000000000', usdc: '2000000', settledQuote: '550000' })
    const orders = await deepbookBook().openOrders(ME)
    expect(orders).toHaveLength(1)
    const [waiting] = orders
    expect(waiting).toMatchObject({ id: MANAGER, status: 'filled' })
    expect(waiting?.collectable).toEqual([
      { amount: '2.55', symbol: 'USDC' },
      { amount: '1', symbol: 'SUI' },
    ])
    expect(waiting?.note).toBe(
      'This is in your DeepBook account, not your wallet, until you press Collect.'
    )
  })

  it('counts settled money that has not reached the manager yet', async () => {
    useExistingManager({ settledBase: '1000000000' })
    const [waiting] = await deepbookBook().openOrders(ME)
    expect(waiting?.collectable).toEqual([{ amount: '1', symbol: 'SUI' }])
    expect(waiting).toMatchObject({ tokenOut: 'SUI', tokenIn: 'USDC', receivedOut: '1' })
  })

  it('lists an open order and the waiting money apart', async () => {
    useExistingManager({
      orders: [fakeOrder(false, '1100000', '2000000000', '500000000')],
      settledQuote: '550000',
    })
    const orders = await deepbookBook().openOrders(ME)
    expect(orders.map((o) => o.status)).toEqual(['partly', 'filled'])
    expect(orders[0]?.collectable).toBeUndefined()
  })

  it('shows nothing for a wallet with no manager, or a manager with nothing', async () => {
    expect(await deepbookBook().openOrders(ME)).toEqual([])
    useExistingManager({ noAccount: true })
    expect(await deepbookBook().openOrders(ME)).toEqual([])
  })

  it('still reads the rest when one registered manager can’t be read on its own', async () => {
    chain.registered = [OTHER_MANAGER, MANAGER]
    chain.managers[MANAGER] = { owner: ME, sui: '1000000000' }
    const orders = await deepbookBook().openOrders(ME)
    expect(orders.map((o) => o.id)).toEqual([MANAGER])
  })

  it('leaves out a manager that is not the account’s', async () => {
    useExistingManager({ owner: THIEF, orders: [fakeOrder(false, '1100000', '2000000000')] })
    expect(await deepbookBook().openOrders(ME)).toEqual([])
  })

  it('refuses something that is no address, and lets a failed read reach the route', async () => {
    await expect(deepbookBook().openOrders('nope')).rejects.toThrow(ChainActionRefused)
    chain.simulateFails = true
    await expect(deepbookBook().openOrders(ME)).rejects.toThrow('fetch failed')
  })
})

describe('decodeOrderId', () => {
  it('reads the side and price out of an order id', () => {
    expect(decodeOrderId(encodeOrderId(true, BigInt(900000), BigInt(3)))).toEqual({
      isBid: true,
      price: BigInt(900000),
    })
    expect(decodeOrderId(encodeOrderId(false, BigInt(1100000), BigInt(3)))).toEqual({
      isBid: false,
      price: BigInt(1100000),
    })
  })
})

describe('the constants', () => {
  it('are the published ids', async () => {
    const { DEEPBOOK_PACKAGE, DEEPBOOK_POOL, DEEPBOOK_REGISTRY } =
      await import('../chains/sui/policies')
    expect(DEEPBOOK_PACKAGE).toBe(PACKAGE)
    expect(DEEPBOOK_POOL).toBe(POOL)
    expect(DEEPBOOK_REGISTRY).toBe(REGISTRY)
  })
})
