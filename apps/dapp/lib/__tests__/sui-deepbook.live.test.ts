import { bcs } from '@mysten/sui/bcs'
import { coinWithBalance, Transaction } from '@mysten/sui/transactions'
import { fromBase64, normalizeStructTag } from '@mysten/sui/utils'
import { describe, expect, it } from 'vitest'

import { suiClient } from '../chains/sui/client'
import { deepbookBook, deepbookVenue } from '../chains/sui/deepbook'
import { decodeSettled, DEEPBOOK_READS } from '../chains/sui/deepbook-rules'
import { DEEPBOOK_CALLS } from '../chains/sui/policies'
import type { PreparedAction } from '../chains/types'

/**
 * Against mainnet, reading and simulating only. Nothing here signs: a simulation needs no signature,
 * and each account named is a public address whose key nobody here has. Run by this exact file name.
 */

const FUNDED = '0xc6fa48a7455bff49124318d5297320441cfac33f83ceea890c485372de917df4'
const EMPTY = '0x0000000000000000000000000000000000000000000000000000000000001234'
const PACKAGE = '0xbca0cefe720330e7bb4f2283438b68de6a0e656688db4ac90d61e71fe6151fe8'
const TYPES = '0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809'
const REGISTRY = '0xaf16199a2dff736e9f07a845f23c5da6df6f756eddb631aed9d24a93efc4549d'
const POOL = '0xe05dafb5133bcffb8d59f4e12465dc0e9faeaa05e3e342a08fe135800e3e4407'
const SUI = '0x2::sui::SUI'
const USDC = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'
const MANAGER_TYPE = `${TYPES}::balance_manager::BalanceManager`
const POST_ONLY = 3
const SLOW_MS = 120_000
const INDEXER = 'https://deepbook-indexer.mainnet.mystenlabs.com'
const ZERO = BigInt(0)

async function read(build: (tx: Transaction) => void): Promise<Uint8Array[][]> {
  const tx = new Transaction()
  tx.setSender(FUNDED)
  build(tx)
  const result = await suiClient().core.simulateTransaction({
    transaction: tx,
    include: { commandResults: true, effects: true },
  })
  if (result.$kind !== 'Transaction') {
    throw new Error(JSON.stringify(result.FailedTransaction.effects?.status))
  }
  return (result.commandResults ?? []).map((c) => c.returnValues.map((v) => v.bcs))
}

interface Params {
  tick: bigint
  lot: bigint
  min: bigint
  makerFee: bigint
  takerFee: bigint
  mid: bigint
}

async function poolParams(): Promise<Params> {
  const [book, trade, mid] = await read((tx) => {
    const common = { typeArguments: [SUI, USDC] }
    tx.moveCall({
      target: `${PACKAGE}::pool::pool_book_params`,
      ...common,
      arguments: [tx.object(POOL)],
    })
    tx.moveCall({
      target: `${PACKAGE}::pool::pool_trade_params`,
      ...common,
      arguments: [tx.object(POOL)],
    })
    tx.moveCall({
      target: `${PACKAGE}::pool::mid_price`,
      ...common,
      arguments: [tx.object(POOL), tx.object.clock()],
    })
  })
  const u64 = (bytes: Uint8Array | undefined): bigint =>
    BigInt(bcs.u64().parse(bytes as Uint8Array))
  return {
    tick: u64(book?.[0]),
    lot: u64(book?.[1]),
    min: u64(book?.[2]),
    takerFee: u64(trade?.[0]),
    makerFee: u64(trade?.[1]),
    mid: u64(mid?.[0]),
  }
}

interface Attempt {
  selling: boolean
  payWithDeep: boolean
  register: boolean
  price: bigint
  quantity: bigint
  deposit: bigint
}

function firstUseTransaction(attempt: Attempt): Transaction {
  const tx = new Transaction()
  tx.setSender(FUNDED)
  const manager = tx.moveCall({ target: `${PACKAGE}::balance_manager::new` })
  const coin = tx.add(
    attempt.selling
      ? coinWithBalance({ balance: attempt.deposit })
      : coinWithBalance({ type: USDC, balance: attempt.deposit, useGasCoin: false })
  )
  tx.moveCall({
    target: `${PACKAGE}::balance_manager::deposit`,
    typeArguments: [attempt.selling ? SUI : USDC],
    arguments: [manager, coin],
  })
  const proof = tx.moveCall({
    target: `${PACKAGE}::balance_manager::generate_proof_as_owner`,
    arguments: [manager],
  })
  tx.moveCall({
    target: `${PACKAGE}::pool::place_limit_order`,
    typeArguments: [SUI, USDC],
    arguments: [
      tx.object(POOL),
      manager,
      proof,
      tx.pure.u64(0),
      tx.pure.u8(POST_ONLY),
      tx.pure.u8(0),
      tx.pure.u64(attempt.price),
      tx.pure.u64(attempt.quantity),
      tx.pure.bool(!attempt.selling),
      tx.pure.bool(attempt.payWithDeep),
      tx.pure.u64(Date.now() + 7 * 24 * 60 * 60 * 1000),
      tx.object.clock(),
    ],
  })
  if (attempt.register) {
    tx.moveCall({
      target: `${PACKAGE}::balance_manager::register_balance_manager`,
      arguments: [manager, tx.object(REGISTRY)],
    })
  }
  tx.moveCall({
    target: '0x2::transfer::public_share_object',
    typeArguments: [MANAGER_TYPE],
    arguments: [manager],
  })
  return tx
}

const onTick = (value: bigint, tick: bigint): bigint => (value / tick) * tick
const away = (mid: bigint, above: boolean): bigint => (mid * BigInt(above ? 12 : 8)) / BigInt(10)
const display = (raw: bigint): string => (Number(raw) / 1_000_000).toFixed(5)

function amountFor(
  changes: readonly { coinType: string; address: string; amount: string }[] | undefined,
  owner: string,
  coin: string
): bigint {
  return (changes ?? [])
    .filter(
      (c) => c.address === owner && normalizeStructTag(c.coinType) === normalizeStructTag(coin)
    )
    .reduce((sum, c) => sum + BigInt(c.amount), ZERO)
}

async function dryRun(prepared: PreparedAction, sender: string) {
  if (prepared.signing.family !== 'sui') throw new Error('Expected Sui.')
  const result = await suiClient().core.simulateTransaction({
    transaction: fromBase64(prepared.signing.transaction),
    include: { effects: true, balanceChanges: true },
  })
  const held = result.$kind === 'Transaction' ? result.Transaction : result.FailedTransaction
  return {
    held,
    sui: amountFor(held.balanceChanges, sender, SUI),
    usdc: amountFor(held.balanceChanges, sender, USDC),
  }
}

/** Nothing for a manager that can't be read on its own, as one held inside another object can't. */
async function ownerOf(manager: string): Promise<string | undefined> {
  try {
    const { object } = await suiClient().core.getObject({
      objectId: manager,
      include: { json: true },
    })
    const owner = (object.json as { owner?: unknown } | null)?.owner
    return object.owner.$kind === 'Shared' && typeof owner === 'string' ? owner : undefined
  } catch {
    return undefined
  }
}

/**
 * Managers that have traded lately, those with the fewest trades first. The two market makers hold
 * most of the book but replace their orders at once and settle as they go, so a person's order is
 * what these tests need.
 */
async function recentMakers(): Promise<string[]> {
  const counts = new Map<string, number>()
  const now = Math.floor(Date.now() / 1000)
  for (const daysAgo of [1, 3, 7, 14, 21, 30]) {
    const end = now - daysAgo * 86_400
    const reply = await fetch(
      `${INDEXER}/trades/SUI_USDC?limit=1000&start_time=${end - 86_400}&end_time=${end}`,
      { signal: AbortSignal.timeout(20_000) }
    )
    if (!reply.ok) throw new Error(`The indexer answered ${reply.status}.`)
    for (const trade of (await reply.json()) as { maker_balance_manager_id: string }[]) {
      const id = trade.maker_balance_manager_id
      counts.set(id, (counts.get(id) ?? 0) + 1)
    }
  }
  return [...counts.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id)
}

async function managerRef(manager: string) {
  const { object } = await suiClient().core.getObject({ objectId: manager })
  if (object.owner.$kind !== 'Shared') throw new Error('The manager is not shared.')
  return {
    objectId: manager,
    initialSharedVersion: object.owner.Shared.initialSharedVersion,
    mutable: true,
  }
}

describe.skipIf(process.env['SKIP_LIVE'] === '1')('DeepBook on mainnet', () => {
  it(
    'reads tick, lot, minimum and fees from the chain, and the pinned shared versions',
    async () => {
      const params = await poolParams()
      console.log('params', params)
      expect(params.tick).toBe(BigInt(10))
      expect(params.lot).toBe(BigInt(100_000_000))
      expect(params.min).toBe(BigInt(1_000_000_000))
      expect(params.makerFee).toBe(ZERO)
      const shared = async (id: string): Promise<string | undefined> => {
        const { object } = await suiClient().core.getObject({ objectId: id })
        return object.owner.$kind === 'Shared'
          ? object.owner.Shared.initialSharedVersion
          : undefined
      }
      expect(await shared(POOL)).toBe('389750322')
      expect(await shared(REGISTRY)).toBe('336155480')
    },
    SLOW_MS
  )

  it.each([
    ['sell, pay_with_deep false', true, false, false],
    ['buy, pay_with_deep false', false, false, false],
    ['sell, pay_with_deep true', true, true, false],
    ['buy, pay_with_deep true', false, true, false],
    ['sell, registered, pay_with_deep false', true, false, true],
    ['buy, registered, pay_with_deep false', false, false, true],
  ])(
    'first use in one transaction: %s',
    async (name, selling, payWithDeep, register) => {
      const { tick, min, mid } = await poolParams()
      const price = onTick(away(mid, selling), tick)
      const deposit = selling ? min : (min * price) / BigInt(1_000_000_000)
      const result = await suiClient().core.simulateTransaction({
        transaction: firstUseTransaction({
          selling,
          payWithDeep,
          register,
          price,
          quantity: min,
          deposit,
        }),
        include: { effects: true, balanceChanges: true, objectTypes: true },
      })
      const held = result.$kind === 'Transaction' ? result.Transaction : result.FailedTransaction
      const created = held.effects?.changedObjects.filter((c) => c.idOperation === 'Created') ?? []
      const types = created.map((c) => held.objectTypes?.[c.objectId] ?? '')
      console.log(name, {
        status: JSON.stringify(held.effects?.status),
        gas: held.effects?.gasUsed,
        created: types,
        balanceChanges: held.balanceChanges,
      })
      expect(held.effects?.status.success).toBe(true)
      const manager = created.find((c) => held.objectTypes?.[c.objectId] === MANAGER_TYPE)
      expect(manager?.outputOwner?.$kind).toBe('Shared')
      expect(types.filter((t) => /TradeCap|DepositCap|WithdrawCap/.test(t))).toEqual([])
      // Registering adds one entry to the registry's table of owners, and moves nothing.
      expect(types.filter((t) => /Field<address,.*VecSet/.test(t))).toHaveLength(register ? 1 : 0)
      const lost = (held.balanceChanges ?? []).filter((c) => BigInt(c.amount) < ZERO)
      expect(lost.every((c) => c.address === FUNDED)).toBe(true)
    },
    SLOW_MS
  )

  it.each([
    ['SUI', 'USDC', '1', true],
    ['USDC', 'SUI', '2', false],
  ])(
    'builds %s to %s for a funded wallet, and it passes its own check and simulates clean',
    async (tokenIn, tokenOut, amount, selling) => {
      const { mid } = await poolParams()
      const prepared = await deepbookVenue.prepare(
        { kind: 'limit', amount, tokenIn, tokenOut, limitPrice: display(away(mid, selling)) },
        FUNDED
      )
      deepbookVenue.assertSafe(prepared.signing, FUNDED, prepared.context)
      const { held, usdc } = await dryRun(prepared, FUNDED)
      if (prepared.signing.family !== 'sui') throw new Error('Expected Sui.')
      const data = Transaction.from(prepared.signing.transaction).getData()
      console.log(tokenIn, 'to', tokenOut, {
        summary: prepared.summary,
        context: prepared.context,
        steps: data.commands.map((c) => c.MoveCall?.function ?? c.$kind),
        status: JSON.stringify(held.effects?.status),
        budget: data.gasData.budget,
        gas: held.effects?.gasUsed,
        usdc,
      })
      expect(held.effects?.status.success).toBe(true)
      expect(prepared.thenPrepareAgain).toBeUndefined()
      // The reserve keeps back the fee reserve and the limit cost: the budget has to fit in that.
      expect(Number(data.gasData.budget)).toBeLessThanOrEqual(70_000_000)
      if (!selling) expect(-usdc).toBe(BigInt(prepared.context?.['deposit'] ?? '0'))
    },
    SLOW_MS
  )

  it.each([
    ['a buy above the market', 'USDC', 'SUI', '5', true],
    ['a sell below the market', 'SUI', 'USDC', '1', false],
  ])(
    'refuses %s, because POST_ONLY would abort',
    async (name, tokenIn, tokenOut, amount, above) => {
      const { mid } = await poolParams()
      const refusal = await deepbookVenue
        .prepare(
          { kind: 'limit', amount, tokenIn, tokenOut, limitPrice: display(away(mid, above)) },
          FUNDED
        )
        .then(
          () => undefined,
          (e: unknown) => (e instanceof Error ? e.message : String(e))
        )
      console.log(name, refusal)
      expect(refusal).toMatch(/Nothing was signed or sent\.$/)
    },
    SLOW_MS
  )

  it(
    'answers an account with no SUI and no manager with no orders',
    async () => {
      expect(await deepbookBook().openOrders(EMPTY)).toEqual([])
    },
    SLOW_MS
  )

  it(
    'simulates cancelling a real open order as its own owner, and reads a registered owner',
    async () => {
      let cancelled = false
      let listed = false
      for (const manager of (await recentMakers()).slice(0, 40)) {
        const owner = await ownerOf(manager)
        if (owner === undefined) continue
        const rows = await deepbookBook().openOrders(owner)
        if (rows.length > 0 && !listed) {
          console.log('rows for a registered owner', owner, rows.slice(0, 3))
          listed = rows.every((row) => row.venueId === 'deepbook-limit')
          expect(listed).toBe(true)
        }
        if (cancelled) {
          if (listed) break
          continue
        }
        const held = await managerRef(manager)
        const reading = await read((tx) => {
          tx.moveCall({
            target: `${PACKAGE}::pool::account_open_orders`,
            typeArguments: [SUI, USDC],
            arguments: [tx.object(POOL), tx.sharedObjectRef(held)],
          })
        })
        const open = bcs
          .struct('VecSet', { contents: bcs.vector(bcs.u128()) })
          .parse(reading[0]?.[0] as Uint8Array).contents
        const order = open[0]
        if (order === undefined) continue
        const prepared = await deepbookBook().prepareExit(owner, `${manager}:${order}`, 'cancel')
        deepbookVenue.assertSafe(prepared.signing, owner, prepared.context)
        const { held: run, sui, usdc } = await dryRun(prepared, owner)
        console.log('cancel', {
          owner,
          manager,
          summary: prepared.summary,
          receive: prepared.receive,
          status: JSON.stringify(run.effects?.status),
          gas: run.effects?.gasUsed,
          sui,
          usdc,
        })
        expect(run.effects?.status.success).toBe(true)
        expect(usdc > ZERO || sui > ZERO).toBe(true)
        cancelled = true
      }
      console.log('cancelled a real order:', cancelled, 'listed a registered owner:', listed)
      expect(cancelled).toBe(true)
    },
    SLOW_MS
  )

  /**
   * Two new managers trade with each other inside one simulation, so a maker's fill is there to look
   * at. `withdraw_all` before settling comes back empty, and after settling holds the whole fill.
   * The book moves between reading the middle and simulating, so a run where the buyer met someone
   * else's order first, or the seller's order crossed, proves nothing and goes again.
   */
  async function tradeWithAnotherManager() {
    const { tick, min, mid } = await poolParams()
    const price = onTick(mid, tick)
    const quote = (min * price) / BigInt(1_000_000_000)
    const tx = new Transaction()
    tx.setSender(FUNDED)
    const pool = tx.object(POOL)
    const clock = tx.object.clock()
    const types = { typeArguments: [SUI, USDC] }
    const expiry = Date.now() + 86_400_000
    const open = (coin: ReturnType<typeof coinWithBalance>, type: string) => {
      const manager = tx.moveCall({ target: `${PACKAGE}::balance_manager::new` })
      tx.moveCall({
        target: `${PACKAGE}::balance_manager::deposit`,
        typeArguments: [type],
        arguments: [manager, tx.add(coin)],
      })
      const proof = tx.moveCall({
        target: `${PACKAGE}::balance_manager::generate_proof_as_owner`,
        arguments: [manager],
      })
      return { manager, proof }
    }
    const order = (
      side: {
        manager: ReturnType<Transaction['moveCall']>
        proof: ReturnType<Transaction['moveCall']>
      },
      orderType: number,
      isBid: boolean
    ) =>
      tx.moveCall({
        target: DEEPBOOK_CALLS.place,
        ...types,
        arguments: [
          pool,
          side.manager,
          side.proof,
          tx.pure.u64(0),
          tx.pure.u8(orderType),
          tx.pure.u8(0),
          tx.pure.u64(price),
          tx.pure.u64(min),
          tx.pure.bool(isBid),
          tx.pure.bool(false),
          tx.pure.u64(expiry),
          clock,
        ],
      })
    const maker = open(coinWithBalance({ balance: min }), SUI)
    const taker = open(
      coinWithBalance({
        type: USDC,
        balance: (quote * BigInt(11)) / BigInt(10),
        useGasCoin: false,
      }),
      USDC
    )
    order(maker, POST_ONLY, false)
    order(taker, 0, true)
    const withdraw = () =>
      tx.moveCall({
        target: DEEPBOOK_CALLS.withdrawAll,
        typeArguments: [USDC],
        arguments: [maker.manager],
      })
    const value = (coin: ReturnType<Transaction['moveCall']>) =>
      tx.moveCall({ target: '0x2::coin::value', typeArguments: [USDC], arguments: [coin] })
    const early = withdraw()
    value(early)
    tx.moveCall({
      target: DEEPBOOK_READS.account,
      ...types,
      arguments: [pool, maker.manager],
    })
    tx.moveCall({
      target: DEEPBOOK_CALLS.settle,
      ...types,
      arguments: [pool, maker.manager, maker.proof],
    })
    const late = withdraw()
    value(late)
    tx.transferObjects([early, late], FUNDED)
    for (const manager of [maker.manager, taker.manager]) {
      tx.moveCall({
        target: DEEPBOOK_CALLS.share,
        typeArguments: [MANAGER_TYPE],
        arguments: [manager],
      })
    }

    const result = await suiClient().core.simulateTransaction({
      transaction: tx,
      include: { effects: true, commandResults: true },
    })
    if (result.$kind !== 'Transaction') return undefined
    // Building has replaced the coin steps, so the handles above no longer count commands.
    const outputs = tx.getData().commands.flatMap((command, index) => {
      const bytes = result.commandResults?.[index]?.returnValues[0]?.bcs
      const fn = command.MoveCall?.function
      return (fn === 'value' || fn === 'account') && bytes !== undefined ? [bytes] : []
    })
    const [earlyBytes, settledBytes, lateBytes] = outputs
    if (earlyBytes === undefined || settledBytes === undefined || lateBytes === undefined) {
      throw new Error('A value did not come back.')
    }
    return {
      price,
      quote,
      before: BigInt(bcs.u64().parse(earlyBytes)),
      after: BigInt(bcs.u64().parse(lateBytes)),
      settled: decodeSettled(settledBytes),
    }
  }

  it(
    'shows on the deployed package that a fill can only be collected once settled',
    async () => {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const trade = await tradeWithAnotherManager()
        console.log('a fill', trade)
        if (trade === undefined || trade.settled.quote === ZERO) continue
        expect(trade.before).toBe(ZERO)
        expect(trade.settled.quote).toBe(trade.quote)
        expect(trade.after).toBe(trade.quote)
        return
      }
      throw new Error('The two managers never met on the book.')
    },
    SLOW_MS
  )

  it(
    'simulates collecting real money waiting for a registered owner, as much as the row says',
    async () => {
      let done = false
      for (const manager of (await recentMakers()).slice(0, 60)) {
        const owner = await ownerOf(manager)
        if (owner === undefined) continue
        const rows = await deepbookBook().openOrders(owner)
        const waiting = rows.find((row) => row.collectable !== undefined)
        if (waiting === undefined) continue
        const prepared = await deepbookBook().prepareExit(owner, waiting.id, 'collect')
        deepbookVenue.assertSafe(prepared.signing, owner, prepared.context)
        const { held, sui, usdc } = await dryRun(prepared, owner)
        console.log('collect', {
          owner,
          waiting,
          summary: prepared.summary,
          status: JSON.stringify(held.effects?.status),
          gas: held.effects?.gasUsed,
          sui,
          usdc,
        })
        expect(held.effects?.status.success).toBe(true)
        const inUsdc = waiting.collectable?.find((c) => c.symbol === 'USDC')?.amount
        if (inUsdc !== undefined) expect(Number(usdc) / 1_000_000).toBe(Number(inUsdc))
        done = true
        break
      }
      expect(done).toBe(true)
    },
    SLOW_MS
  )
})
