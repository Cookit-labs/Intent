import { bcs } from '@mysten/sui/bcs'
import { Transaction } from '@mysten/sui/transactions'
import { fromBase64, toBase64 } from '@mysten/sui/utils'
import { beforeAll, describe, expect, it } from 'vitest'

import {
  createDeepbookVenue,
  DEEP_TYPE,
  DEEPBOOK_PACKAGE,
  DEEPBOOK_POOLS,
} from '../chains/sui/deepbook'
import { deepbookListing } from '../chains/sui/deepbook-listing'
import type { SwapIo } from '../chains/sui/direct-swap'
import { ChainActionRefused, type ChainActionRequest } from '../chains/types'

const ME = '0x00000000000000000000000000000000000000000000000000000000000000a1'
const THIEF = '0x000000000000000000000000000000000000000000000000000000000000dead'
const FOREIGN = '0x00000000000000000000000000000000000000000000000000000000000bad01'
const COIN = '0x00000000000000000000000000000000000000000000000000000000000000c1'
const GAS = '0x00000000000000000000000000000000000000000000000000000000000000c2'
const DIGEST = '11111111111111111111111111111111'
const USDC = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'
const SCAM = '0x778e2ae6096389cfad3e0b1c6e8080a9287f8792a08d3df1f9025251d820be93::usdt::USDT'

const u64 = (n: string): Uint8Array => bcs.u64().serialize(n).toBytes()

interface BookReading {
  sold?: [string, string]
  bought?: [string, string]
  mid?: string
  taker?: string
}

/** 10 SUI into 9.29 USDC with 0.02 SUI left over, and 10 USDC into 10.7 SUI with 0.03 USDC left. */
function fakeIo(reading: BookReading = {}, prices: Record<string, number | undefined> = {}) {
  const views: Transaction[] = []
  const built: Transaction[] = []
  const io: SwapIo = {
    view: async (tx) => {
      views.push(tx)
      const quantities = tx
        .getData()
        .commands.some((c) => c.MoveCall?.function === 'get_base_quantity_out_input_fee')
        ? (reading.bought ?? ['10700000000', '30000'])
        : (reading.sold ?? ['20000000', '9290000'])
      return [
        [u64(quantities[0]), u64(quantities[1]), u64('0')],
        [u64(reading.mid ?? '931800')],
        [u64(reading.taker ?? '200000'), u64('0'), u64('100000000000')],
      ]
    },
    build: async (tx) => {
      built.push(tx)
      tx.setGasPrice(1000)
      tx.setGasBudget(50_000_000)
      tx.setGasPayment([{ objectId: GAS, version: '1', digest: DIGEST }])
      return toBase64(await tx.build())
    },
    price: async (token) =>
      token.symbol in prices ? prices[token.symbol] : token.symbol === 'SUI' ? 0.932 : 1,
    spend: (tx) => tx.objectRef({ objectId: COIN, version: '1', digest: DIGEST }),
  }
  return { io, views, built }
}

const SELL: ChainActionRequest = { kind: 'swap', amount: '10', tokenIn: 'SUI', tokenOut: 'USDC' }
const BUY: ChainActionRequest = { kind: 'swap', amount: '10', tokenIn: 'USDC', tokenOut: 'SUI' }

async function preparedBytes(request: ChainActionRequest = SELL): Promise<string> {
  const prepared = await createDeepbookVenue(fakeIo().io).prepare(request, ME)
  if (prepared.signing.family !== 'sui') throw new Error('wrong family')
  return prepared.signing.transaction
}

const venue = createDeepbookVenue(fakeIo().io)
let SOLD = ''

beforeAll(async () => {
  SOLD = await preparedBytes(SELL)
})

const check = (transaction: string, account = ME) =>
  venue.assertSafe({ family: 'sui', transaction }, account)

async function edited(base: string, edit: (tx: Transaction) => void): Promise<string> {
  const tx = Transaction.from(base)
  edit(tx)
  return toBase64(await tx.build())
}

interface JsonArg {
  Input?: number
  Result?: number
  NestedResult?: [number, number]
}
interface JsonTx {
  inputs: { Pure?: { bytes: string }; Object?: { SharedObject?: { objectId: string } } }[]
  commands: {
    MoveCall?: {
      package: string
      module: string
      function: string
      typeArguments: string[]
      arguments: JsonArg[]
    }
  }[]
}

async function rewritten(base: string, edit: (data: JsonTx) => void): Promise<string> {
  const data = JSON.parse(await Transaction.from(base).toJSON()) as JsonTx
  edit(data)
  return toBase64(await Transaction.from(JSON.stringify(data)).build())
}

function swapCall(data: JsonTx) {
  const call = data.commands.find((c) => c.MoveCall?.function.startsWith('swap_exact'))?.MoveCall
  if (call === undefined) throw new Error('no swap in this transaction')
  return call
}

function moveCalls(transaction: string) {
  return Transaction.from(transaction)
    .getData()
    .commands.flatMap((c) => (c.$kind === 'MoveCall' ? [c.MoveCall] : []))
}

describe('the DeepBook quote', () => {
  it('reads what the book gives, and builds nothing', async () => {
    const { io, views, built } = fakeIo()
    const quoted = await createDeepbookVenue(io).quote?.(SELL, ME)
    expect(quoted?.receive).toEqual({ amount: '9.29', symbol: 'USDC' })
    expect(built).toHaveLength(0)
    expect(views).toHaveLength(1)
    const names = views[0]?.getData().commands.map((c) => c.MoveCall?.function)
    expect(names).toEqual(['get_quote_quantity_out_input_fee', 'mid_price', 'pool_trade_params'])
  })

  it('asks the input-fee path, so no DEEP is needed to read a price', async () => {
    const { io, views } = fakeIo()
    await createDeepbookVenue(io).quote?.(BUY, ME)
    const first = views[0]?.getData().commands[0]?.MoveCall
    expect(first?.function).toBe('get_base_quantity_out_input_fee')
  })

  it('refuses a pair with no direct pool', async () => {
    await expect(
      venue.quote?.({ ...SELL, tokenIn: 'USDsui', tokenOut: 'USDT' }, ME)
    ).rejects.toThrow(/no direct pool/i)
  })

  it('refuses a token outside the list', async () => {
    await expect(venue.quote?.({ ...SELL, tokenOut: 'FDUSD' }, ME)).rejects.toThrow(
      ChainActionRefused
    )
  })

  it('refuses when the read fails, rather than guessing', async () => {
    const { io } = fakeIo()
    io.view = () => Promise.reject(new Error('fullnode down'))
    const failing = createDeepbookVenue(io).quote?.(SELL, ME)
    await expect(failing).rejects.toThrow(ChainActionRefused)
    await expect(createDeepbookVenue(io).quote?.(SELL, ME)).rejects.toThrow(/couldn't read/i)
  })

  it('refuses an amount below the smallest order, where nothing would trade', async () => {
    const { io } = fakeIo({ sold: ['1000000000', '0'] })
    await expect(createDeepbookVenue(io).quote?.({ ...SELL, amount: '1' }, ME)).rejects.toThrow(
      /can't fill/i
    )
  })

  it('refuses when more than 1% would stay unspent', async () => {
    const { io } = fakeIo({ sold: ['200000000', '9110000'] })
    await expect(createDeepbookVenue(io).quote?.(SELL, ME)).rejects.toThrow(/part of this amount/i)
  })

  it('refuses a stale book whose fill is far from its own mid price', async () => {
    const { io } = fakeIo({ sold: ['20000000', '100000'] })
    await expect(createDeepbookVenue(io).quote?.(SELL, ME)).rejects.toThrow(ChainActionRefused)
  })

  it('refuses a fill worth far less than the market, even at the mid price', async () => {
    const { io } = fakeIo({}, { SUI: 2 })
    await expect(createDeepbookVenue(io).quote?.(SELL, ME)).rejects.toThrow(/worse than the market/)
  })

  it('refuses when no outside price can be read', async () => {
    const { io } = fakeIo({}, { USDC: undefined })
    await expect(createDeepbookVenue(io).quote?.(SELL, ME)).rejects.toThrow(/live price/)
  })

  it('refuses an account that is not a Sui address', async () => {
    await expect(venue.quote?.(SELL, 'not-an-address')).rejects.toThrow(/Sui address/)
  })
})

describe('what DeepBook prepare builds', () => {
  it('sells base with a minimum 0.5% under the quote, and no DEEP from the wallet', async () => {
    const transaction = await preparedBytes(SELL)
    const data = Transaction.from(transaction).getData()
    expect(data.sender).toBe(ME)
    const calls = moveCalls(transaction)
    expect(calls.map((c) => `${c.module}::${c.function}`)).toEqual([
      'coin::zero',
      'pool::swap_exact_base_for_quote',
      'coin::destroy_zero',
    ])
    const swap = calls[1]
    expect(swap?.package).toBe(DEEPBOOK_PACKAGE)
    const minimum = swap?.arguments[3]
    if (minimum?.$kind !== 'Input') throw new Error('minimum is not stated')
    const input = data.inputs[minimum.Input]
    expect(bcs.u64().parse(fromBase64(input?.Pure?.bytes ?? ''))).toBe('9243550')
    expect(calls[0]?.typeArguments).toEqual([DEEP_TYPE])
    expect(() => check(transaction)).not.toThrow()
  })

  it('buys base through the other function, and passes its own check', async () => {
    const transaction = await preparedBytes(BUY)
    expect(moveCalls(transaction)[1]?.function).toBe('swap_exact_quote_for_base')
    expect(() => check(transaction)).not.toThrow()
  })

  it('sends both leftovers and the output to the person', async () => {
    const data = Transaction.from(await preparedBytes(SELL)).getData()
    const transfer = data.commands.find((c) => c.$kind === 'TransferObjects')?.TransferObjects
    expect(transfer?.objects).toHaveLength(2)
    const to = transfer?.address
    if (to?.$kind !== 'Input') throw new Error('recipient is not stated')
    const bytes = data.inputs[to.Input]?.Pure?.bytes ?? ''
    expect(bcs.Address.parse(fromBase64(bytes))).toBe(ME)
  })

  it('tells the person the price protection, the fee it read, the leftover and the risks', async () => {
    const prepared = await venue.prepare(SELL, ME)
    const notes = prepared.notes.join(' ')
    expect(notes).toMatch(/more than 0\.5%, the swap cancels/)
    expect(notes).toMatch(/fee is about 0\.025%/)
    expect(notes).toMatch(/0\.02 SUI/)
    expect(notes).toMatch(/can upgrade DeepBook's contracts/)
    expect(prepared.receive).toEqual({ amount: '9.29', symbol: 'USDC', approximate: true })
    expect(prepared.pay).toEqual({ amount: '10', symbol: 'SUI' })
    expect(prepared.venueId).toBe('deepbook')
    expect(prepared.kind).toBe('swap')
  })

  it('says a bridged USDT depends on the bridge', async () => {
    const { io } = fakeIo({ sold: ['1000', '9990000'], mid: '999000000', taker: '10000' })
    const prepared = await createDeepbookVenue(io).prepare(
      { ...SELL, tokenIn: 'USDT', tokenOut: 'USDC' },
      ME
    )
    expect(prepared.notes.join(' ')).toMatch(/Sui Bridge/)
  })
})

describe('the DeepBook safety check refuses', () => {
  it('a different account', async () => {
    expect(() => check(SOLD, THIEF)).toThrow(/different account/)
  })

  it('a transaction sent by someone else', async () => {
    const tampered = await edited(SOLD, (tx) => tx.setSender(THIEF))
    expect(() => check(tampered)).toThrow(/different account/)
  })

  it('an unknown contract', async () => {
    const tampered = await edited(SOLD, (tx) => {
      tx.moveCall({ target: `${FOREIGN}::drain::everything` })
    })
    expect(() => check(tampered)).toThrow(/confirmed/)
  })

  it('an upgraded package id, until someone checks it', async () => {
    const tampered = await rewritten(SOLD, (data) => {
      swapCall(data).package = FOREIGN
    })
    expect(() => check(tampered)).toThrow(/confirmed/)
  })

  it('a DeepBook function this flow never needs', async () => {
    const tampered = await rewritten(SOLD, (data) => {
      swapCall(data).function = 'place_market_order'
    })
    expect(() => check(tampered)).toThrow(/confirmed/)
  })

  it('an extra argument', async () => {
    const tampered = await rewritten(SOLD, (data) => {
      const call = swapCall(data)
      call.arguments.push(call.arguments[3] as JsonArg)
    })
    expect(() => check(tampered)).toThrow(/does not match/)
  })

  it('payment to someone else', async () => {
    const tampered = await edited(SOLD, (tx) => {
      const [coin] = tx.splitCoins(tx.gas, [BigInt(1)])
      tx.transferObjects([coin as never], THIEF)
    })
    expect(() => check(tampered)).toThrow(/another address/)
  })

  it('a framework transfer that hides the recipient', async () => {
    const tampered = await edited(SOLD, (tx) => {
      const [coin] = tx.splitCoins(tx.gas, [BigInt(1)])
      tx.moveCall({
        target: '0x2::transfer::public_transfer',
        typeArguments: ['0x2::coin::Coin<0x2::sui::SUI>'],
        arguments: [coin as never, tx.pure.address(THIEF)],
      })
    })
    expect(() => check(tampered)).toThrow(/confirmed/)
  })

  it('no minimum, which is what an unlimited approval would be here', async () => {
    const tampered = await rewritten(SOLD, (data) => {
      const at = swapCall(data).arguments[3]?.Input
      const input = at === undefined ? undefined : data.inputs[at]
      if (input?.Pure === undefined) throw new Error('no minimum')
      input.Pure.bytes = toBase64(u64('0'))
    })
    expect(() => check(tampered)).toThrow(/minimum/)
  })

  it('a minimum computed elsewhere in the transaction', async () => {
    const tampered = await rewritten(SOLD, (data) => {
      const call = swapCall(data)
      call.arguments[3] = { NestedResult: [0, 0] }
    })
    expect(() => check(tampered)).toThrow(/minimum/)
  })

  it('a token outside the pool', async () => {
    const tampered = await rewritten(SOLD, (data) => {
      swapCall(data).typeArguments[1] = SCAM
    })
    expect(() => check(tampered)).toThrow(/pool/)
  })

  it('a pool that is not pinned', async () => {
    const tampered = await rewritten(SOLD, (data) => {
      const at = swapCall(data).arguments[0]?.Input
      const pool = at === undefined ? undefined : data.inputs[at]?.Object?.SharedObject
      if (pool === undefined) throw new Error('no pool')
      pool.objectId = FOREIGN
    })
    expect(() => check(tampered)).toThrow(/pool/)
  })

  it("one pool's id with another pair's types", async () => {
    const other = DEEPBOOK_POOLS.find((p) => p.base === 'USDT')
    if (other === undefined) throw new Error('no USDT pool')
    const tampered = await rewritten(SOLD, (data) => {
      const at = swapCall(data).arguments[0]?.Input
      const pool = at === undefined ? undefined : data.inputs[at]?.Object?.SharedObject
      if (pool === undefined) throw new Error('no pool')
      pool.objectId = other.id
    })
    expect(() => check(tampered)).toThrow(/pool/)
  })

  it('DEEP drawn from the wallet', async () => {
    const tampered = await rewritten(SOLD, (data) => {
      const call = swapCall(data)
      call.arguments[2] = call.arguments[1] as JsonArg
    })
    expect(() => check(tampered)).toThrow(/DEEP/)
  })

  it('a zero coin of anything but DEEP', async () => {
    const tampered = await rewritten(SOLD, (data) => {
      const zero = data.commands.find((c) => c.MoveCall?.function === 'zero')?.MoveCall
      if (zero === undefined) throw new Error('no zero coin')
      zero.typeArguments = [USDC]
    })
    expect(() => check(tampered)).toThrow(/DEEP/)
  })

  it('a clock that is not the clock', async () => {
    const tampered = await rewritten(SOLD, (data) => {
      const at = swapCall(data).arguments[4]?.Input
      const clock = at === undefined ? undefined : data.inputs[at]?.Object?.SharedObject
      if (clock === undefined) throw new Error('no clock')
      clock.objectId = FOREIGN
    })
    expect(() => check(tampered)).toThrow(/does not match/)
  })

  it('two swaps in one transaction', async () => {
    const tampered = await rewritten(SOLD, (data) => {
      const swap = data.commands.find((c) => c.MoveCall?.function.startsWith('swap_exact'))
      if (swap === undefined) throw new Error('no swap')
      data.commands.push(JSON.parse(JSON.stringify(swap)) as JsonTx['commands'][number])
    })
    expect(() => check(tampered)).toThrow(/one swap/)
  })

  it('a transaction with no swap at all', async () => {
    const tampered = await rewritten(SOLD, (data) => {
      data.commands = data.commands.filter((c) => !c.MoveCall?.function.startsWith('swap_exact'))
    })
    expect(() => check(tampered)).toThrow(/one swap/)
  })

  it('a payload for another chain', () => {
    expect(() => venue.assertSafe({ family: 'solana', transaction: SOLD }, ME)).toThrow(
      ChainActionRefused
    )
  })

  it('bytes that are not a transaction', () => {
    expect(() => check('not base64 at all!')).toThrow(ChainActionRefused)
  })
})

describe('the DeepBook pins and listing', () => {
  it('pins exactly the pools for tokens in the table', () => {
    expect(DEEPBOOK_POOLS.map((p) => `${p.base}/${p.quote}`).sort()).toEqual([
      'SUI/USDC',
      'SUI/USDsui',
      'USDT/USDC',
      'USDsui/USDC',
    ])
  })

  it('lists as executing on Sui, and says limit orders are not connected', () => {
    expect(deepbookListing.id).toBe('deepbook')
    expect(deepbookListing.family).toBe('sui')
    expect(deepbookListing.integration).toBe('executes')
    expect(deepbookListing.capability).toMatch(/limit orders/i)
  })
})
