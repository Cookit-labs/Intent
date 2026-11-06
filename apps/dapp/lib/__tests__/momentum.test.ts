import { bcs } from '@mysten/sui/bcs'
import { Transaction } from '@mysten/sui/transactions'
import { fromBase64, toBase64 } from '@mysten/sui/utils'
import { beforeAll, describe, expect, it } from 'vitest'

import type { SwapIo } from '../chains/sui/direct-swap'
import {
  createMomentumVenue,
  MOMENTUM_PACKAGE,
  MOMENTUM_POOLS,
  MOMENTUM_VERSION,
} from '../chains/sui/momentum'
import { momentumListing } from '../chains/sui/momentum-listing'
import { ChainActionRefused, type ChainActionRequest } from '../chains/types'

const ME = '0x00000000000000000000000000000000000000000000000000000000000000a1'
const THIEF = '0x000000000000000000000000000000000000000000000000000000000000dead'
const FOREIGN = '0x00000000000000000000000000000000000000000000000000000000000bad01'
const COIN = '0x00000000000000000000000000000000000000000000000000000000000000c1'
const GAS = '0x00000000000000000000000000000000000000000000000000000000000000c2'
const DIGEST = '11111111111111111111111111111111'
const SCAM = '0x778e2ae6096389cfad3e0b1c6e8080a9287f8792a08d3df1f9025251d820be93::usdt::USDT'

const u64 = (n: string): Uint8Array => bcs.u64().serialize(n).toBytes()
const u128 = (n: string): Uint8Array => bcs.u128().serialize(n).toBytes()

interface PoolReading {
  out?: string
  left?: string
  after?: string
  before?: string
}

/** 10 SUI into 9.3 USDC at a 0.175% fee, moving the price a hair. */
function fakeIo(reading: PoolReading = {}, prices: Record<string, number | undefined> = {}) {
  const views: Transaction[] = []
  const built: Transaction[] = []
  const io: SwapIo = {
    view: async (tx) => {
      views.push(tx)
      return [
        [],
        [u64(reading.out ?? '9300000')],
        [u64(reading.left ?? '0')],
        [u128(reading.after ?? '563200040872796795')],
        [u128(reading.before ?? '563203070563371839')],
        [u64('1750')],
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

async function preparedBytes(
  request: ChainActionRequest = SELL,
  reading: PoolReading = {}
): Promise<string> {
  const prepared = await createMomentumVenue(fakeIo(reading).io).prepare(request, ME)
  if (prepared.signing.family !== 'sui') throw new Error('wrong family')
  return prepared.signing.transaction
}

const venue = createMomentumVenue(fakeIo().io)
const check = (transaction: string, account = ME) =>
  venue.assertSafe({ family: 'sui', transaction }, account)

let SOLD = ''

beforeAll(async () => {
  SOLD = await preparedBytes(SELL)
})

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
interface JsonCall {
  package: string
  module: string
  function: string
  typeArguments: string[]
  arguments: JsonArg[]
}
interface JsonTx {
  inputs: { Pure?: { bytes: string }; Object?: { SharedObject?: { objectId: string } } }[]
  commands: { MoveCall?: JsonCall }[]
}

async function rewritten(base: string, edit: (data: JsonTx) => void): Promise<string> {
  const data = JSON.parse(await Transaction.from(base).toJSON()) as JsonTx
  edit(data)
  return toBase64(await Transaction.from(JSON.stringify(data)).build())
}

function named(data: JsonTx, fn: string): JsonCall {
  const call = data.commands.find((c) => c.MoveCall?.function === fn)?.MoveCall
  if (call === undefined) throw new Error(`no ${fn} in this transaction`)
  return call
}

function moveCalls(transaction: string) {
  return Transaction.from(transaction)
    .getData()
    .commands.flatMap((c) => (c.$kind === 'MoveCall' ? [c.MoveCall] : []))
}

describe('the Momentum quote', () => {
  it('reads what the pool gives, and builds nothing', async () => {
    const { io, views, built } = fakeIo()
    const quoted = await createMomentumVenue(io).quote?.(SELL, ME)
    expect(quoted?.receive).toEqual({ amount: '9.3', symbol: 'USDC' })
    expect(built).toHaveLength(0)
    expect(views[0]?.getData().commands.map((c) => c.MoveCall?.function)).toEqual([
      'compute_swap_result',
      'get_state_amount_calculated',
      'get_state_amount_specified',
      'get_state_sqrt_price',
      'sqrt_price',
      'swap_fee_rate',
    ])
  })

  it('refuses a pair with no pinned pool', async () => {
    await expect(venue.quote?.({ ...SELL, tokenOut: 'USDsui' }, ME)).rejects.toThrow(
      /no direct pool/i
    )
  })

  it('refuses a token outside the list', async () => {
    await expect(venue.quote?.({ ...SELL, tokenOut: 'FDUSD' }, ME)).rejects.toThrow(
      ChainActionRefused
    )
  })

  it('refuses when the read fails, rather than guessing', async () => {
    const { io } = fakeIo()
    io.view = () => Promise.reject(new Error('fullnode down'))
    await expect(createMomentumVenue(io).quote?.(SELL, ME)).rejects.toThrow(/couldn't read/i)
  })

  it('refuses a pool that runs out before the amount is spent', async () => {
    const { io } = fakeIo({ left: '5000000000', out: '4650000' })
    await expect(createMomentumVenue(io).quote?.(SELL, ME)).rejects.toThrow(/part of this amount/i)
  })

  it('refuses a swap that moves the price more than the limit', async () => {
    const { io } = fakeIo({ after: '540000000000000000' })
    await expect(createMomentumVenue(io).quote?.(SELL, ME)).rejects.toThrow(/move the price/)
  })

  it('refuses a fill worth far less than the market', async () => {
    const { io } = fakeIo({}, { SUI: 2 })
    await expect(createMomentumVenue(io).quote?.(SELL, ME)).rejects.toThrow(/worse than the market/)
  })

  it('refuses when no outside price can be read', async () => {
    const { io } = fakeIo({}, { USDC: undefined })
    await expect(createMomentumVenue(io).quote?.(SELL, ME)).rejects.toThrow(/live price/)
  })

  it('refuses an account that is not a Sui address', async () => {
    await expect(venue.quote?.(SELL, 'not-an-address')).rejects.toThrow(/Sui address/)
  })
})

describe('what Momentum prepare builds', () => {
  it('runs the flash swap in full, with a minimum 0.5% under the quote', () => {
    const calls = moveCalls(SOLD)
    expect(calls.map((c) => `${c.module}::${c.function}`)).toEqual([
      'trade::flash_swap',
      'balance::destroy_zero',
      'trade::swap_receipt_debts',
      'coin::into_balance',
      'balance::zero',
      'trade::repay_flash_swap',
      'coin::from_balance',
      'coin::split',
    ])
    expect(calls[0]?.package).toBe(MOMENTUM_PACKAGE)
    const data = Transaction.from(SOLD).getData()
    const minimum = calls[7]?.arguments[1]
    if (minimum?.$kind !== 'Input') throw new Error('minimum is not stated')
    const bytes = data.inputs[minimum.Input]?.Pure?.bytes ?? ''
    expect(bcs.u64().parse(fromBase64(bytes))).toBe('9253500')
    expect(() => check(SOLD)).not.toThrow()
  })

  it('swaps the other way through the same pool, and passes its own check', async () => {
    const transaction = await preparedBytes(BUY, { out: '10700000000' })
    const data = Transaction.from(transaction).getData()
    const direction = moveCalls(transaction)[0]?.arguments[1]
    if (direction?.$kind !== 'Input') throw new Error('direction is not stated')
    const bytes = data.inputs[direction.Input]?.Pure?.bytes ?? ''
    expect(bcs.bool().parse(fromBase64(bytes))).toBe(false)
    expect(() => check(transaction)).not.toThrow()
  })

  it('sends what is left of the input and all the output to the person', () => {
    const data = Transaction.from(SOLD).getData()
    const transfer = data.commands.find((c) => c.$kind === 'TransferObjects')?.TransferObjects
    expect(transfer?.objects).toHaveLength(2)
    const to = transfer?.address
    if (to?.$kind !== 'Input') throw new Error('recipient is not stated')
    expect(bcs.Address.parse(fromBase64(data.inputs[to.Input]?.Pure?.bytes ?? ''))).toBe(ME)
  })

  it('tells the person the price protection, the fee it read and the risks', async () => {
    const prepared = await venue.prepare(SELL, ME)
    const notes = prepared.notes.join(' ')
    expect(notes).toMatch(/more than 0\.5%, the swap cancels/)
    expect(notes).toMatch(/fee is 0\.175%/)
    expect(notes).toMatch(/upgrade/)
    expect(notes).toMatch(/pause/)
    expect(prepared.receive).toEqual({ amount: '9.3', symbol: 'USDC', approximate: true })
    expect(prepared.venueId).toBe('momentum')
  })
})

describe('the Momentum safety check refuses', () => {
  it('a different account', () => {
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

  it('the original package id, which is not the one to call', async () => {
    const tampered = await rewritten(SOLD, (data) => {
      named(data, 'flash_swap').package =
        '0x70285592c97965e811e0c6f98dccc3a9c2b4ad854b3594faab9597ada267b860'
    })
    expect(() => check(tampered)).toThrow(/confirmed/)
  })

  it('a Momentum function this flow never needs', async () => {
    const tampered = await rewritten(SOLD, (data) => {
      named(data, 'flash_swap').function = 'flash_loan'
    })
    expect(() => check(tampered)).toThrow(/confirmed/)
  })

  it('an extra argument', async () => {
    const tampered = await rewritten(SOLD, (data) => {
      const call = named(data, 'flash_swap')
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
      const at = named(data, 'split').arguments[1]?.Input
      const input = at === undefined ? undefined : data.inputs[at]
      if (input?.Pure === undefined) throw new Error('no minimum')
      input.Pure.bytes = toBase64(u64('0'))
    })
    expect(() => check(tampered)).toThrow(/minimum/)
  })

  it('a minimum computed elsewhere in the transaction', async () => {
    const tampered = await rewritten(SOLD, (data) => {
      named(data, 'split').arguments[1] = { NestedResult: [2, 0] }
    })
    expect(() => check(tampered)).toThrow(/minimum/)
  })

  it('a minimum taken from a coin other than the output', async () => {
    const tampered = await rewritten(SOLD, (data) => {
      named(data, 'split').arguments[0] = { NestedResult: [0, 0] }
    })
    expect(() => check(tampered)).toThrow(/minimum/)
  })

  it('a swap with no minimum at all', async () => {
    const tampered = await rewritten(SOLD, (data) => {
      data.commands = data.commands.filter((c) => c.MoveCall?.function !== 'split')
    })
    expect(() => check(tampered)).toThrow(/minimum/)
  })

  it('a token outside the pool', async () => {
    const tampered = await rewritten(SOLD, (data) => {
      const call = named(data, 'flash_swap')
      call.typeArguments[1] = SCAM
    })
    expect(() => check(tampered)).toThrow(/pool/)
  })

  it('a pool that is not pinned', async () => {
    const tampered = await rewritten(SOLD, (data) => {
      const at = named(data, 'flash_swap').arguments[0]?.Input
      const pool = at === undefined ? undefined : data.inputs[at]?.Object?.SharedObject
      if (pool === undefined) throw new Error('no pool')
      pool.objectId = FOREIGN
    })
    expect(() => check(tampered)).toThrow(/pool/)
  })

  it("one pool's id with another pair's types", async () => {
    const other = MOMENTUM_POOLS.find((p) => p.x === 'USDT')
    if (other === undefined) throw new Error('no USDT pool')
    const tampered = await rewritten(SOLD, (data) => {
      const at = named(data, 'flash_swap').arguments[0]?.Input
      const pool = at === undefined ? undefined : data.inputs[at]?.Object?.SharedObject
      if (pool === undefined) throw new Error('no pool')
      pool.objectId = other.id
    })
    expect(() => check(tampered)).toThrow(/pool/)
  })

  it('an exact-out swap, which the minimum was never worked out for', async () => {
    const tampered = await rewritten(SOLD, (data) => {
      const at = named(data, 'flash_swap').arguments[2]?.Input
      const input = at === undefined ? undefined : data.inputs[at]
      if (input?.Pure === undefined) throw new Error('no flag')
      input.Pure.bytes = toBase64(bcs.bool().serialize(false).toBytes())
    })
    expect(() => check(tampered)).toThrow(/does not match/)
  })

  it('a version object that is not the pinned one', async () => {
    const tampered = await rewritten(SOLD, (data) => {
      const at = named(data, 'flash_swap').arguments[6]?.Input
      const version = at === undefined ? undefined : data.inputs[at]?.Object?.SharedObject
      if (version === undefined) throw new Error('no version')
      version.objectId = FOREIGN
    })
    expect(() => check(tampered)).toThrow(/does not match/)
  })

  it('two swaps in one transaction', async () => {
    const tampered = await rewritten(SOLD, (data) => {
      const flash = data.commands.find((c) => c.MoveCall?.function === 'flash_swap')
      if (flash === undefined) throw new Error('no swap')
      data.commands.push(JSON.parse(JSON.stringify(flash)) as JsonTx['commands'][number])
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

describe('the Momentum pins and listing', () => {
  it('pins only the pools with real depth for tokens in the table', () => {
    expect(MOMENTUM_POOLS.map((p) => `${p.x}/${p.y}`).sort()).toEqual(['SUI/USDC', 'USDT/USDC'])
    expect(MOMENTUM_VERSION).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('lists as executing on Sui', () => {
    expect(momentumListing.id).toBe('momentum')
    expect(momentumListing.family).toBe('sui')
    expect(momentumListing.integration).toBe('executes')
    expect(momentumListing.capability).toMatch(/SUI, USDC and USDT/)
  })
})
