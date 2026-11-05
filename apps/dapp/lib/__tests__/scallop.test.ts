import { Transaction } from '@mysten/sui/transactions'
import { fromBase64, toBase64 } from '@mysten/sui/utils'
import { describe, expect, it } from 'vitest'

import { coinTypeName } from '../chains/sui/lending-calls'
import {
  accruedPool,
  amountForReceipts,
  createScallopVenue,
  receiptsForAmount,
  scallopBorrowApr,
  scallopBorrowTransaction,
  scallopRepayTransaction,
  scallopSupplyApr,
  scallopVenue,
  scallopWithdrawTransaction,
  type ScallopObligation,
  type ScallopPool,
  type ScallopReader,
} from '../chains/sui/scallop'
import { scallopListing } from '../chains/sui/scallop-listing'
import { SUI_TOKENS } from '../chains/sui/tokens'
import { ChainActionRefused, type ChainActionRequest, type SigningPayload } from '../chains/types'
import {
  callNamed,
  inputOf,
  OTHER_ADDRESS,
  OTHER_OBJECT,
  payTo,
  pointAt,
  SCALLOP_BORROW,
  SCALLOP_BORROW_SENDER,
  SCALLOP_REPAY,
  SCALLOP_REPAY_SENDER,
  SCALLOP_SUPPLY,
  SCALLOP_SUPPLY_SENDER,
  SCALLOP_WITHDRAW,
  SCALLOP_WITHDRAW_SENDER,
  tampered,
} from './sui-lending-captured'

const USDT = '0x375f70cf2ae4c00bf37117d0c85a2c71545e6ee05c4a5c7d282cd66a4504b068::usdt::USDT'
const UNLISTED = '0x0000000000000000000000000000000000000000000000000000000000000bad::fake::FAKE'
const ME = '0x0000000000000000000000000000000000000000000000000000000000000abc'
const USDC_TYPE = SUI_TOKENS.find((t) => t.symbol === 'USDC')?.id ?? ''
const USDC_NAME = coinTypeName(USDC_TYPE)
const SUI_NAME = coinTypeName('0x2::sui::SUI')
const OBLIGATION = '0x0000000000000000000000000000000000000000000000000000000000000b01'
const KEY = '0x0000000000000000000000000000000000000000000000000000000000000b02'

function checkSupply(transaction: string, account = SCALLOP_SUPPLY_SENDER): void {
  scallopVenue.assertSafe({ family: 'sui', transaction }, account)
}

function checkWithdraw(transaction: string, account = SCALLOP_WITHDRAW_SENDER): void {
  scallopVenue.assertSafe({ family: 'sui', transaction }, account)
}

/** The USDC pool as read on 2026-11-05. */
const POOL: ScallopPool = {
  cash: BigInt('408594658931'),
  debt: BigInt('1148010447929'),
  revenue: BigInt('3217384834'),
  receiptSupply: BigInt('1358202340967'),
  borrowRate: BigInt('123747030'),
  borrowRateScale: BigInt('10000000'),
  revenueFactor: BigInt('858993459'),
  updatedSeconds: 0,
}

function obligation(over: Partial<ScallopObligation> = {}): ScallopObligation {
  return {
    id: OBLIGATION,
    keyId: KEY,
    collaterals: [{ coinName: SUI_NAME, amount: BigInt(10_000_000_000) }],
    debts: [],
    borrowLocked: false,
    repayLocked: false,
    withdrawLocked: false,
    ...over,
  }
}

function reader(
  receipts: bigint,
  pool: ScallopPool = POOL,
  over: Partial<ScallopReader> = {}
): ScallopReader {
  return {
    pool: async () => pool,
    receipts: async () => receipts,
    obligations: async () => [],
    standing: async () => ({
      liquidationUsd: 8,
      limitUsd: 7,
      owedUsd: 0,
      readings: [
        { objectId: OTHER_OBJECT, priceUsd: 1, emaUsd: 1, ageSeconds: 3 },
        { objectId: OTHER_OBJECT, priceUsd: 1, emaUsd: 1, ageSeconds: 3 },
      ],
    }),
    weights: async () => ({ collateralFactor: 0.7, liquidationFactor: 0.8 }),
    borrowFeePercent: async () => 0,
    walletBalance: async () => BigInt(50_000_000),
    ...over,
  }
}

function withdraw(amount = '1'): ChainActionRequest {
  return { kind: 'withdraw', amount, tokenIn: 'USDC' }
}

function action(kind: ChainActionRequest['kind'], amount = '1', tokenIn = 'USDC') {
  return { kind, amount, tokenIn } as ChainActionRequest
}

function literal(tx: Transaction, name: string, index: number): bigint {
  const data = tx.getData()
  const call = data.commands.find(
    (c) => c.$kind === 'MoveCall' && c.MoveCall.function === name
  )?.MoveCall
  const argument = call?.arguments[index]
  const input = argument?.$kind === 'Input' ? data.inputs[argument.Input] : undefined
  if (input?.$kind !== 'Pure') throw new Error(`no literal at ${index} of ${name}`)
  const bytes = fromBase64(input.Pure.bytes)
  return new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(0, true)
}

function calls(tx: Transaction): string[] {
  return tx.getData().commands.flatMap((c) => (c.$kind === 'MoveCall' ? [c.MoveCall.function] : []))
}

describe('what the venue really built passes', () => {
  it('a supply and a withdrawal', () => {
    expect(() => checkSupply(SCALLOP_SUPPLY)).not.toThrow()
    expect(() => checkWithdraw(SCALLOP_WITHDRAW)).not.toThrow()
  })

  it('a borrow and a repay', () => {
    expect(() => checkSupply(SCALLOP_BORROW, SCALLOP_BORROW_SENDER)).not.toThrow()
    expect(() => checkSupply(SCALLOP_REPAY, SCALLOP_REPAY_SENDER)).not.toThrow()
  })
})

describe('Scallop refuses a transaction that', () => {
  it('another account would sign', () => {
    expect(() => checkSupply(SCALLOP_SUPPLY, OTHER_ADDRESS)).toThrow(/different account/)
    expect(() => checkWithdraw(SCALLOP_WITHDRAW, OTHER_ADDRESS)).toThrow(ChainActionRefused)
  })

  it('calls a contract that is not confirmed', async () => {
    const tx = await tampered(SCALLOP_WITHDRAW, (t) => {
      callNamed(t, 'redeem').package = OTHER_OBJECT
    })
    expect(() => checkWithdraw(tx)).toThrow(/haven't confirmed for Scallop/)
  })

  it('calls the older package the docs still name', async () => {
    const tx = await tampered(SCALLOP_WITHDRAW, (t) => {
      callNamed(t, 'redeem').package =
        '0xa45b8ffca59e5b44ec7c04481a04cb620b0e07b2b183527bca4e5f32372c5f1a'
    })
    expect(() => checkWithdraw(tx)).toThrow(/haven't confirmed for Scallop/)
  })

  it.each(['redeem_entry', 'flash_loan', 'liquidate'])(
    'calls %s, which this venue never uses',
    async (name) => {
      const tx = await tampered(SCALLOP_WITHDRAW, (t) => {
        callNamed(t, 'redeem').function = name
      })
      expect(() => checkWithdraw(tx)).toThrow(/haven't confirmed for Scallop/)
    }
  )

  it('passes an extra argument', async () => {
    const tx = await tampered(SCALLOP_WITHDRAW, (t) => {
      const call = callNamed(t, 'redeem')
      const extra = call.arguments[0]
      if (extra === undefined) throw new Error('no argument')
      call.arguments.push(extra)
    })
    expect(() => checkWithdraw(tx)).toThrow(/wrong arguments/)
  })

  it('takes an extra step of a kind it never needs', async () => {
    const base = Transaction.from(SCALLOP_SUPPLY)
    base.makeMoveVec({ type: 'u64', elements: [] })
    const tx = toBase64(await base.build())
    expect(() => checkSupply(tx)).toThrow(/does more than Scallop needs/)
  })

  it('moves anything through the framework', async () => {
    const base = Transaction.from(SCALLOP_WITHDRAW)
    base.moveCall({
      target: '0x2::transfer::public_transfer',
      typeArguments: ['0x2::sui::SUI'],
      arguments: [base.gas, base.pure.address(OTHER_ADDRESS)],
    })
    const tx = toBase64(await base.build())
    expect(() => checkWithdraw(tx)).toThrow(ChainActionRefused)
  })

  it('pays the withdrawal to someone else', async () => {
    const tx = await tampered(SCALLOP_WITHDRAW, (t) => payTo(t, OTHER_ADDRESS))
    expect(() => checkWithdraw(tx)).toThrow(/another address/)
  })

  it('sends the receipts to someone else', async () => {
    const tx = await tampered(SCALLOP_SUPPLY, (t) => payTo(t, OTHER_ADDRESS))
    expect(() => checkSupply(tx)).toThrow(/another address/)
  })

  it('supplies a token other than USDC', async () => {
    const tx = await tampered(SCALLOP_SUPPLY, (t) => {
      callNamed(t, 'mint').typeArguments = [USDT]
    })
    expect(() => checkSupply(tx)).toThrow(/token Scallop isn't confirmed for/)
  })

  it('redeems a token outside the list', async () => {
    const tx = await tampered(SCALLOP_WITHDRAW, (t) => {
      callNamed(t, 'redeem').typeArguments = [UNLISTED]
    })
    expect(() => checkWithdraw(tx)).toThrow(/token Scallop isn't confirmed for/)
  })

  it('points at another market or version object', async () => {
    const market = await tampered(SCALLOP_WITHDRAW, (t) => {
      pointAt(inputOf(t, callNamed(t, 'redeem'), 1), OTHER_OBJECT)
    })
    expect(() => checkWithdraw(market)).toThrow(/object Scallop doesn't use/)
    const version = await tampered(SCALLOP_WITHDRAW, (t) => {
      pointAt(inputOf(t, callNamed(t, 'redeem'), 0), OTHER_OBJECT)
    })
    expect(() => checkWithdraw(version)).toThrow(/object Scallop doesn't use/)
  })

  it('is not a Sui transaction, or not readable', () => {
    const near: SigningPayload = { family: 'near', transactions: [] }
    expect(() => scallopVenue.assertSafe(near, SCALLOP_SUPPLY_SENDER)).toThrow(/not a Sui/)
    expect(() => checkSupply('not base64!')).toThrow(ChainActionRefused)
  })

  it('sends a borrow to someone else', async () => {
    const tx = await tampered(SCALLOP_BORROW, (t) => payTo(t, OTHER_ADDRESS))
    expect(() => checkSupply(tx, SCALLOP_BORROW_SENDER)).toThrow(/another address/)
  })

  it('borrows through another oracle or market', async () => {
    const oracle = await tampered(SCALLOP_BORROW, (t) => {
      pointAt(inputOf(t, callNamed(t, 'borrow'), 6), OTHER_OBJECT)
    })
    expect(() => checkSupply(oracle, SCALLOP_BORROW_SENDER)).toThrow(/object Scallop doesn't use/)
    const market = await tampered(SCALLOP_BORROW, (t) => {
      pointAt(inputOf(t, callNamed(t, 'borrow'), 3), OTHER_OBJECT)
    })
    expect(() => checkSupply(market, SCALLOP_BORROW_SENDER)).toThrow(/object Scallop doesn't use/)
  })

  it('reads a price by another rule', async () => {
    const tx = await tampered(SCALLOP_BORROW, (t) => {
      callNamed(t, 'set_price_as_primary').package = OTHER_OBJECT
    })
    expect(() => checkSupply(tx, SCALLOP_BORROW_SENDER)).toThrow(/haven't confirmed for Scallop/)
  })

  it("repays someone else's loan, while proving the key on its own", async () => {
    const tx = await tampered(SCALLOP_REPAY, (t) => {
      const repay = callNamed(t, 'repay')
      const own = inputOf(t, repay, 1)
      const stranger = JSON.parse(JSON.stringify(own)) as typeof own
      pointAt(stranger, OTHER_OBJECT)
      t.inputs.push(stranger)
      repay.arguments[1] = { Input: t.inputs.length - 1 }
    })
    expect(() => checkSupply(tx, SCALLOP_REPAY_SENDER)).toThrow(/isn't shown to be yours/)
  })

  it('repays with no key check at all', async () => {
    const tx = await tampered(SCALLOP_REPAY, (t) => {
      callNamed(t, 'assert_key_match').function = 'is_key_match'
    })
    expect(() => checkSupply(tx, SCALLOP_REPAY_SENDER)).toThrow(/haven't confirmed for Scallop/)
  })

  it('names another token on a repay', async () => {
    const tx = await tampered(SCALLOP_REPAY, (t) => {
      callNamed(t, 'repay').typeArguments = [UNLISTED]
    })
    expect(() => checkSupply(tx, SCALLOP_REPAY_SENDER)).toThrow(/token Scallop isn't confirmed for/)
  })
})

describe('amounts', () => {
  it('matches what a dry run redeemed: 100000 receipts for about 114370', () => {
    const value = amountForReceipts(BigInt(100_000), POOL)
    expect(Number(value)).toBeGreaterThan(114_300)
    expect(Number(value)).toBeLessThan(114_400)
  })

  it('rounds receipts up, and a whole holding converts back within itself', () => {
    const held = BigInt('874346')
    const value = amountForReceipts(held, POOL)
    expect(receiptsForAmount(value, POOL) <= held).toBe(true)
    expect(receiptsForAmount(BigInt(1_000_000), POOL) * BigInt(1) > BigInt(874_000)).toBe(true)
  })

  it('reads the rate from the contract, with Scallop’s share taken off', () => {
    expect(scallopSupplyApr(POOL)).toBeCloseTo(5.37, 1)
    expect(scallopBorrowApr(POOL)).toBeCloseTo(9.09, 0)
  })

  it('shows no rate when it cannot be worked out', () => {
    expect(scallopSupplyApr({ ...POOL, borrowRateScale: BigInt(0) })).toBeUndefined()
    expect(scallopSupplyApr({ ...POOL, debt: BigInt(0), cash: BigInt(0) })).toBeUndefined()
    expect(scallopBorrowApr({ ...POOL, borrowRateScale: BigInt(0) })).toBeUndefined()
  })

  it('refuses a pool it cannot value rather than guess', () => {
    const empty = { ...POOL, receiptSupply: BigInt(0) }
    expect(() => receiptsForAmount(BigInt(1), empty)).toThrow(/couldn't read Scallop/)
    expect(() => amountForReceipts(BigInt(1), empty)).toThrow(ChainActionRefused)
  })

  it('adds interest since the pool last moved, so receipts are worth what they are now', () => {
    const later = accruedPool({ ...POOL, updatedSeconds: 1000 }, 1000 + 86_400)
    expect(later.debt).toBeGreaterThan(POOL.debt)
    expect(amountForReceipts(BigInt(100_000), later)).toBeGreaterThan(
      amountForReceipts(BigInt(100_000), POOL)
    )
  })
})

describe('the transactions it builds', () => {
  const held = { id: OBLIGATION, keyId: KEY }
  const prices = [{ coinType: USDC_TYPE, priceObject: OTHER_OBJECT }]

  it('borrow exactly what was asked, and price each coin first', () => {
    const tx = scallopBorrowTransaction(ME, USDC_TYPE, BigInt(1_500_000), held, prices)
    expect(literal(tx, 'borrow', 5)).toBe(BigInt(1_500_000))
    expect(calls(tx)).toEqual([
      'price_update_request',
      'set_price_as_primary',
      'confirm_price_update_request',
      'borrow',
    ])
    const transfers = tx.getData().commands.filter((c) => c.$kind === 'TransferObjects')
    expect(transfers).toHaveLength(1)
  })

  it('check the key before each repay, with no price needed', () => {
    const tx = scallopRepayTransaction(ME, USDC_TYPE, [{ obligation: held, coin: BigInt(5) }])
    expect(calls(tx)).toEqual(['assert_key_match', 'repay'])
  })

  it('hand back every receipt on a whole withdraw, and take collateral too', () => {
    const tx = scallopWithdrawTransaction(
      ME,
      USDC_TYPE,
      BigInt(874_346),
      [{ obligation: obligation(), amount: BigInt(7) }],
      prices
    )
    expect(calls(tx)).toEqual([
      'redeem',
      'price_update_request',
      'set_price_as_primary',
      'confirm_price_update_request',
      'withdraw_collateral',
    ])
    expect(literal(tx, 'withdraw_collateral', 5)).toBe(BigInt(7))
  })

  it('touch no collateral when receipts cover it', () => {
    const tx = scallopWithdrawTransaction(ME, USDC_TYPE, BigInt(10), [], [])
    expect(calls(tx)).toEqual(['redeem'])
  })
})

describe('prepare refuses before anything is built', () => {
  it('a token outside Scallop’s list, and a supply of anything but USDC', async () => {
    const venue = createScallopVenue(reader(BigInt(0)))
    await expect(
      venue.prepare({ kind: 'supply', amount: '1', tokenIn: 'SUI' }, ME)
    ).rejects.toThrow(/takes USDC here, not SUI/)
    await expect(venue.prepare(action('borrow', '1', 'sSUI'), ME)).rejects.toThrow(
      /doesn't take sSUI/
    )
    await expect(venue.prepare(action('withdraw', '1', 'sSUI'), ME)).rejects.toThrow(
      /doesn't take sSUI/
    )
  })

  it('a malformed account', async () => {
    await expect(createScallopVenue(reader(BigInt(1))).prepare(withdraw(), 'nope')).rejects.toThrow(
      /not a Sui address/
    )
  })

  it('a withdrawal with no receipts, and says where such a deposit can be', async () => {
    await expect(createScallopVenue(reader(BigInt(0))).prepare(withdraw(), ME)).rejects.toThrow(
      /no Scallop USDC receipts.*scallop\.io/
    )
  })

  it('more than the receipts are worth, and names what they are', async () => {
    await expect(
      createScallopVenue(reader(BigInt(1_000_000))).prepare(withdraw('5'), ME)
    ).rejects.toThrow(/worth about 1\.14\d+ USDC, which is less than 5/)
  })

  it('collateral a loan depends on, in plain words', async () => {
    const loaned = obligation({
      collaterals: [{ coinName: USDC_NAME, amount: BigInt(10_000_000) }],
      debts: [{ coinName: SUI_NAME, amount: BigInt(1_000_000_000) }],
    })
    const venue = createScallopVenue(
      reader(BigInt(0), POOL, {
        obligations: async () => [loaned],
        standing: async () => ({
          liquidationUsd: 8,
          limitUsd: 7,
          owedUsd: 5,
          readings: [
            { objectId: OTHER_OBJECT, priceUsd: 1, emaUsd: 1, ageSeconds: 3 },
            { objectId: OTHER_OBJECT, priceUsd: 1, emaUsd: 1, ageSeconds: 3 },
          ],
        }),
      })
    )
    await expect(venue.prepare(withdraw('10'), ME)).rejects.toThrow(
      /Your loan on Scallop depends on this USDC/
    )
  })

  it('a position locked for its rewards', async () => {
    const venue = createScallopVenue(
      reader(BigInt(0), POOL, {
        obligations: async () => [
          obligation({
            collaterals: [{ coinName: USDC_NAME, amount: BigInt(5_000_000) }],
            withdrawLocked: true,
          }),
        ],
      })
    )
    await expect(venue.prepare(withdraw('1'), ME)).rejects.toThrow(/locked for its rewards/)
  })

  it('a borrow with no borrowing position, saying receipts do not count', async () => {
    await expect(
      createScallopVenue(reader(BigInt(5_000_000))).prepare(action('borrow'), ME)
    ).rejects.toThrow(/no collateral in a Scallop borrowing position.*receipts/)
  })

  it('a borrow from a position staked for rewards', async () => {
    const venue = createScallopVenue(
      reader(BigInt(0), POOL, { obligations: async () => [obligation({ borrowLocked: true })] })
    )
    await expect(venue.prepare(action('borrow'), ME)).rejects.toThrow(
      /staked for its borrow rewards/
    )
  })

  it('a borrow of what the position holds as collateral', async () => {
    const venue = createScallopVenue(
      reader(BigInt(0), POOL, {
        obligations: async () => [
          obligation({ collaterals: [{ coinName: USDC_NAME, amount: BigInt(5) }] }),
        ],
      })
    )
    await expect(venue.prepare(action('borrow'), ME)).rejects.toThrow(
      /won't lend USDC against a position that holds USDC/
    )
  })

  it('a borrow past what the collateral can back', async () => {
    const venue = createScallopVenue(
      reader(BigInt(0), POOL, { obligations: async () => [obligation()] })
    )
    await expect(venue.prepare(action('borrow', '100'), ME)).rejects.toThrow(
      /can back about 7 more/
    )
  })

  it('a repay of a token not owed', async () => {
    await expect(
      createScallopVenue(reader(BigInt(0))).prepare(action('repay'), ME)
    ).rejects.toThrow(/don't owe any USDC on Scallop/)
  })

  it('a repay of a loan staked for rewards', async () => {
    const venue = createScallopVenue(
      reader(BigInt(0), POOL, {
        obligations: async () => [
          obligation({
            debts: [{ coinName: USDC_NAME, amount: BigInt(1_000_000) }],
            repayLocked: true,
          }),
        ],
      })
    )
    await expect(venue.prepare(action('repay'), ME)).rejects.toThrow(/Repay at scallop\.io/)
  })

  it('a whole repay the wallet cannot cover', async () => {
    const venue = createScallopVenue(
      reader(BigInt(0), POOL, {
        walletBalance: async () => BigInt(1),
        obligations: async () => [
          obligation({ debts: [{ coinName: USDC_NAME, amount: BigInt(1_000_000) }] }),
        ],
      })
    )
    await expect(venue.prepare({ ...action('repay'), wholePosition: true }, ME)).rejects.toThrow(
      /which is less than the 1 you owe/
    )
  })
})

describe('positions', () => {
  it('adds receipts and collateral, and reports what is owed', async () => {
    const venue = createScallopVenue(
      reader(BigInt(1_000_000), POOL, {
        receipts: async (_account, coinType) =>
          coinType === USDC_TYPE ? BigInt(1_000_000) : BigInt(0),
        obligations: async () => [
          obligation({
            collaterals: [{ coinName: USDC_NAME, amount: BigInt(2_000_000) }],
            debts: [{ coinName: SUI_NAME, amount: BigInt(3_000_000_000) }],
          }),
        ],
      })
    )
    const held = (await venue.positions?.(ME)) ?? []
    const usdc = held.find((p) => p.slot === 'supplied' && p.symbol === 'USDC')
    expect(Number(usdc?.amount)).toBeGreaterThan(3.14)
    expect(Number(usdc?.amount)).toBeLessThan(3.15)
    expect(held.find((p) => p.slot === 'borrowed' && p.symbol === 'SUI')?.amount).toBe('3')
  })

  it('is empty for a wallet with nothing there', async () => {
    expect(await createScallopVenue(reader(BigInt(0))).positions?.(ME)).toEqual([])
  })

  it('throws when it cannot read, and never reads as empty', async () => {
    const down = reader(BigInt(0), POOL, {
      obligations: async () => {
        throw new Error('rpc down')
      },
    })
    await expect(createScallopVenue(down).positions?.(ME)).rejects.toThrow('rpc down')
  })
})

describe('the venue', () => {
  it('supplies, withdraws, borrows and repays', () => {
    expect(scallopVenue.kinds).toEqual(['supply', 'withdraw', 'borrow', 'repay'])
  })

  it('quotes a base rate from the reader alone', async () => {
    const quote = await createScallopVenue(reader(BigInt(0))).quote?.(
      { kind: 'supply', amount: '1', tokenIn: 'USDC' },
      ME
    )
    expect(quote?.apyPercent).toBeCloseTo(5.37, 1)
  })

  it('quotes no rate on a loan, where a saving rate would mislead', async () => {
    expect(await createScallopVenue(reader(BigInt(0))).quote?.(action('borrow'), ME)).toEqual({})
  })

  it('has a listing that says it executes', () => {
    expect(scallopListing).toMatchObject({ id: 'scallop', family: 'sui', integration: 'executes' })
  })
})
