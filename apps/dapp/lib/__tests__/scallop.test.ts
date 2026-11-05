import { Transaction } from '@mysten/sui/transactions'
import { toBase64 } from '@mysten/sui/utils'
import { describe, expect, it } from 'vitest'

import {
  amountForReceipts,
  createScallopVenue,
  receiptsForAmount,
  scallopSupplyApr,
  scallopVenue,
  type ScallopPool,
  type ScallopReader,
} from '../chains/sui/scallop'
import { scallopListing } from '../chains/sui/scallop-listing'
import { ChainActionRefused, type ChainActionRequest, type SigningPayload } from '../chains/types'
import {
  callNamed,
  inputOf,
  OTHER_ADDRESS,
  OTHER_OBJECT,
  payTo,
  pointAt,
  SCALLOP_SUPPLY,
  SCALLOP_SUPPLY_SENDER,
  SCALLOP_WITHDRAW,
  SCALLOP_WITHDRAW_SENDER,
  tampered,
} from './sui-lending-captured'

const USDT = '0x375f70cf2ae4c00bf37117d0c85a2c71545e6ee05c4a5c7d282cd66a4504b068::usdt::USDT'
const ME = '0x0000000000000000000000000000000000000000000000000000000000000abc'

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
}

function reader(receipts: bigint, pool: ScallopPool = POOL): ScallopReader {
  return { pool: async () => pool, receipts: async () => receipts }
}

function withdraw(amount = '1'): ChainActionRequest {
  return { kind: 'withdraw', amount, tokenIn: 'USDC' }
}

describe('what the venue really built passes', () => {
  it('a supply and a withdrawal', () => {
    expect(() => checkSupply(SCALLOP_SUPPLY)).not.toThrow()
    expect(() => checkWithdraw(SCALLOP_WITHDRAW)).not.toThrow()
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

  it.each(['redeem_entry', 'flash_loan', 'borrow'])(
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

  it('uses a token other than USDC', async () => {
    const tx = await tampered(SCALLOP_SUPPLY, (t) => {
      callNamed(t, 'mint').typeArguments = [USDT]
    })
    expect(() => checkSupply(tx)).toThrow(/token Scallop isn't confirmed for/)
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
  })

  it('shows no rate when it cannot be worked out', () => {
    expect(scallopSupplyApr({ ...POOL, borrowRateScale: BigInt(0) })).toBeUndefined()
    expect(scallopSupplyApr({ ...POOL, debt: BigInt(0), cash: BigInt(0) })).toBeUndefined()
  })

  it('refuses a pool it cannot value rather than guess', () => {
    const empty = { ...POOL, receiptSupply: BigInt(0) }
    expect(() => receiptsForAmount(BigInt(1), empty)).toThrow(/couldn't read Scallop/)
    expect(() => amountForReceipts(BigInt(1), empty)).toThrow(ChainActionRefused)
  })
})

describe('prepare refuses before anything is built', () => {
  it('a token other than USDC', async () => {
    await expect(
      createScallopVenue(reader(BigInt(0))).prepare(
        { kind: 'supply', amount: '1', tokenIn: 'SUI' },
        ME
      )
    ).rejects.toThrow(/takes USDC here, not SUI/)
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
})

describe('the venue', () => {
  it('offers only supply and withdraw', () => {
    expect(scallopVenue.kinds).toEqual(['supply', 'withdraw'])
  })

  it('quotes a base rate from the reader alone', async () => {
    const quote = await createScallopVenue(reader(BigInt(0))).quote?.(
      { kind: 'supply', amount: '1', tokenIn: 'USDC' },
      ME
    )
    expect(quote?.apyPercent).toBeCloseTo(5.37, 1)
  })

  it('has a listing that says it executes', () => {
    expect(scallopListing).toMatchObject({ id: 'scallop', family: 'sui', integration: 'executes' })
  })
})
