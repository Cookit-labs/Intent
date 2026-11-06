import { describe, expect, it } from 'vitest'

import {
  assertBorrowFits,
  assertWithdrawFits,
  borrowNotes,
  parsePythPrice,
  repayCoinAmount,
  MIN_HEALTH_FACTOR,
  type LoanStanding,
} from '../chains/sui/lending-calls'
import { ChainActionRefused } from '../chains/types'

const STANDING: LoanStanding = { liquidationUsd: 800, limitUsd: 750, owedUsd: 100 }

function borrow(addedOwedUsd: number, standing: LoanStanding = STANDING) {
  return assertBorrowFits({
    venueName: 'NAVI',
    symbol: 'USDC',
    standing,
    addedOwedUsd,
    priceUsd: 1,
  })
}

describe('a borrow', () => {
  it('comes back with the health it leaves', () => {
    expect(borrow(100)).toBeCloseTo(4, 5)
  })

  it('is refused with no collateral to borrow against', () => {
    const empty = { liquidationUsd: 0, limitUsd: 0, owedUsd: 0 }
    expect(() => borrow(1, empty)).toThrow(ChainActionRefused)
    expect(() => borrow(1, empty)).toThrow(/no collateral on NAVI.*Nothing was signed or sent/)
  })

  it('is refused past what the protocol would lend, and says how much is left', () => {
    expect(() => borrow(700)).toThrow(/can back about 650 more USDC.*Nothing was signed or sent/)
  })

  it('is refused under the health this app keeps, even where the protocol would lend it', () => {
    expect(() => borrow(450)).toThrow(/health factor at 1\.45.*stops at 1\.5/)
  })

  it('is refused when nothing more can be lent at all', () => {
    expect(() => borrow(1, { liquidationUsd: 800, limitUsd: 50, owedUsd: 100 })).toThrow(
      /can't back any more/
    )
  })
})

describe('a withdraw', () => {
  const withdraw = (removedUsd: number, standing: LoanStanding = STANDING) =>
    assertWithdrawFits({
      venueName: 'NAVI',
      symbol: 'USDC',
      standing,
      removedLimitUsd: removedUsd * 0.75,
      removedLiquidationUsd: removedUsd * 0.8,
      amount: removedUsd,
    })

  it('needs no check with no loan', () => {
    expect(withdraw(1000, { liquidationUsd: 800, limitUsd: 750, owedUsd: 0 })).toBeUndefined()
  })

  it('returns the health it leaves', () => {
    expect(withdraw(100)).toBeCloseTo(7.2, 5)
  })

  it('is refused plainly when a loan depends on the collateral, with what can leave', () => {
    expect(() => withdraw(900)).toThrow(/loan on NAVI depends on this USDC/)
    expect(() => withdraw(900)).toThrow(/about 812\.5 USDC can come out/)
    expect(() => withdraw(900)).toThrow(/Nothing was signed or sent/)
  })

  it('says repay first when none of it can leave', () => {
    const tight = { liquidationUsd: 150, limitUsd: 100, owedUsd: 100 }
    expect(() => withdraw(1, tight)).toThrow(/Repay the loan first/)
  })
})

describe('what a repay hands over', () => {
  const owed = BigInt(1_000_000)

  it('is what was asked when that is less than the debt', () => {
    expect(
      repayCoinAmount({
        asked: BigInt(400_000),
        owed,
        whole: false,
        held: BigInt(5_000_000),
        symbol: 'USDC',
        decimals: 6,
      })
    ).toBe(BigInt(400_000))
  })

  it('pays over the debt on a whole repay, so interest since the read leaves nothing', () => {
    expect(
      repayCoinAmount({
        asked: owed,
        owed,
        whole: true,
        held: BigInt(5_000_000),
        symbol: 'USDC',
        decimals: 6,
      })
    ).toBe(BigInt(1_001_000))
  })

  it('treats asking for more than is owed as the whole of it', () => {
    expect(
      repayCoinAmount({
        asked: BigInt(9_000_000),
        owed,
        whole: false,
        held: BigInt(9_000_000),
        symbol: 'USDC',
        decimals: 6,
      })
    ).toBe(BigInt(1_001_000))
  })

  it('stops at the wallet, once the wallet covers the debt', () => {
    expect(
      repayCoinAmount({ asked: owed, owed, whole: true, held: owed, symbol: 'USDC', decimals: 6 })
    ).toBe(owed)
  })

  it('refuses a whole repay the wallet cannot cover, and says what it holds', () => {
    expect(() =>
      repayCoinAmount({
        asked: owed,
        owed,
        whole: true,
        held: BigInt(500_000),
        symbol: 'USDC',
        decimals: 6,
      })
    ).toThrow(/You hold 0\.5 USDC, which is less than the 1 you owe.*Nothing was signed or sent/)
  })

  it('refuses a part repay the wallet cannot cover', () => {
    expect(() =>
      repayCoinAmount({
        asked: BigInt(400_000),
        owed,
        whole: false,
        held: BigInt(100_000),
        symbol: 'USDC',
        decimals: 6,
      })
    ).toThrow(/You hold 0\.1 USDC/)
  })
})

describe('a price read from the chain', () => {
  const object = (expo: { magnitude: string; negative: boolean }, timestamp: string) => ({
    price_info: {
      price_feed: {
        price: { price: { magnitude: '92313915', negative: false }, expo, timestamp },
        ema_price: { price: { magnitude: '92000000', negative: false }, expo, timestamp },
      },
    },
  })

  it('reads the price, its average and its age', () => {
    const reading = parsePythPrice(object({ magnitude: '8', negative: true }, '1000'), 1030)
    expect(reading.priceUsd).toBeCloseTo(0.92313915, 8)
    expect(reading.emaUsd).toBeCloseTo(0.92, 8)
    expect(reading.ageSeconds).toBe(30)
  })

  it('throws on anything else, rather than read a wrong price', () => {
    expect(() => parsePythPrice({}, 0)).toThrow()
    expect(() => parsePythPrice(undefined, 0)).toThrow()
    expect(() =>
      parsePythPrice(
        {
          price_info: {
            price_feed: {
              price: {
                price: { magnitude: '1', negative: true },
                expo: { magnitude: '8', negative: true },
                timestamp: '1',
              },
              ema_price: {
                price: { magnitude: '1', negative: false },
                expo: { magnitude: '8', negative: true },
                timestamp: '1',
              },
            },
          },
        },
        1
      )
    ).toThrow()
  })
})

describe('what a borrow card says', () => {
  const notes = borrowNotes({
    venueName: 'Suilend',
    symbol: 'USDC',
    health: 2,
    borrowAprPercent: 6.25,
    feePercent: 0.3,
  }).join(' ')

  it('says liquidation risk in plain words, with the margin', () => {
    expect(notes).toMatch(/can be liquidated/)
    expect(notes).toMatch(/health factor at 2\.00/)
    expect(notes).toMatch(/about 50% in value/)
    expect(notes).toContain(String(MIN_HEALTH_FACTOR))
  })

  it('says the rate and the fee it read, and no rate it did not', () => {
    expect(notes).toMatch(/about 6\.25% a year/)
    expect(notes).toMatch(/0\.3% fee/)
    const none = borrowNotes({ venueName: 'NAVI', symbol: 'SUI', health: 2 }).join(' ')
    expect(none).not.toMatch(/% a year/)
    expect(none).not.toMatch(/fee/)
  })
})
