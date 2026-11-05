import { Transaction } from '@mysten/sui/transactions'
import { toBase64 } from '@mysten/sui/utils'
import { describe, expect, it } from 'vitest'

import {
  amountForCtokens,
  createSuilendVenue,
  ctokensForAmount,
  parseSuilendReserve,
  positionForSupply,
  SUILEND_USDC_RESERVE,
  suilendSupplyApr,
  suilendVenue,
  type SuilendPosition,
  type SuilendReader,
  type SuilendReserve,
} from '../chains/sui/suilend'
import { suilendListing } from '../chains/sui/suilend-listing'
import { ChainActionRefused, type ChainActionRequest, type SigningPayload } from '../chains/types'
import {
  callNamed,
  inputOf,
  OTHER_ADDRESS,
  OTHER_OBJECT,
  payTo,
  pointAt,
  SUILEND_SUPPLY,
  SUILEND_SUPPLY_SENDER,
  SUILEND_WITHDRAW,
  SUILEND_WITHDRAW_SENDER,
  tampered,
} from './sui-lending-captured'

const USDT = '0x375f70cf2ae4c00bf37117d0c85a2c71545e6ee05c4a5c7d282cd66a4504b068::usdt::USDT'
const ME = '0x0000000000000000000000000000000000000000000000000000000000000abc'
const WAD = BigInt('1000000000000000000')

function sui(transaction: string): SigningPayload {
  return { family: 'sui', transaction }
}

function checkSupply(transaction: string, account = SUILEND_SUPPLY_SENDER): void {
  suilendVenue.assertSafe(sui(transaction), account)
}

function checkWithdraw(transaction: string, account = SUILEND_WITHDRAW_SENDER): void {
  suilendVenue.assertSafe(sui(transaction), account)
}

/** The reserve as read on 2026-11-05, rounded. */
const RESERVE: SuilendReserve = {
  available: BigInt('5627000000000'),
  ctokenSupply: BigInt('25263000000000'),
  borrowedWad: BigInt('22749000000000') * WAD,
  spreadFeesWad: BigInt('1856000000') * WAD,
  depositLimit: BigInt('110000000000000'),
  utilsPercent: [0, 93, 97, 100],
  aprsBps: [400, 700, 1500, 15000],
  spreadFeeBps: 2000,
}

function position(over: Partial<SuilendPosition> = {}): SuilendPosition {
  return {
    capId: '0x0000000000000000000000000000000000000000000000000000000000000c01',
    obligationId: '0x0000000000000000000000000000000000000000000000000000000000000b01',
    ctokens: BigInt('10000000'),
    hasBorrows: false,
    ...over,
  }
}

function reader(positions: SuilendPosition[], reserve: SuilendReserve = RESERVE): SuilendReader {
  return { reserve: async () => reserve, positions: async () => positions }
}

function withdraw(amount = '1'): ChainActionRequest {
  return { kind: 'withdraw', amount, tokenIn: 'USDC' }
}

describe('what the venue really built passes', () => {
  it('a first supply and a withdrawal', () => {
    expect(() => checkSupply(SUILEND_SUPPLY)).not.toThrow()
    expect(() => checkWithdraw(SUILEND_WITHDRAW)).not.toThrow()
  })
})

describe('Suilend refuses a transaction that', () => {
  it('another account would sign', () => {
    expect(() => checkSupply(SUILEND_SUPPLY, OTHER_ADDRESS)).toThrow(/different account/)
    expect(() => checkWithdraw(SUILEND_WITHDRAW, OTHER_ADDRESS)).toThrow(ChainActionRefused)
  })

  it('calls a contract that is not confirmed', async () => {
    const tx = await tampered(SUILEND_WITHDRAW, (t) => {
      callNamed(t, 'withdraw_ctokens').package = OTHER_OBJECT
    })
    expect(() => checkWithdraw(tx)).toThrow(/haven't confirmed for Suilend/)
  })

  it.each(['borrow_request', 'repay', 'forgive', 'liquidate'])(
    'calls %s, which this venue never uses',
    async (name) => {
      const tx = await tampered(SUILEND_WITHDRAW, (t) => {
        callNamed(t, 'withdraw_ctokens').function = name
      })
      expect(() => checkWithdraw(tx)).toThrow(/haven't confirmed for Suilend/)
    }
  )

  it('passes an extra argument', async () => {
    const tx = await tampered(SUILEND_WITHDRAW, (t) => {
      const call = callNamed(t, 'fulfill_liquidity_request')
      const extra = call.arguments[0]
      if (extra === undefined) throw new Error('no argument')
      call.arguments.push(extra)
    })
    expect(() => checkWithdraw(tx)).toThrow(/wrong arguments/)
  })

  it('takes an extra step of a kind it never needs', async () => {
    const base = Transaction.from(SUILEND_WITHDRAW)
    base.makeMoveVec({ type: 'u64', elements: [] })
    const tx = toBase64(await base.build())
    expect(() => checkWithdraw(tx)).toThrow(/does more than Suilend needs/)
  })

  it('moves anything through the framework', async () => {
    const base = Transaction.from(SUILEND_WITHDRAW)
    base.moveCall({
      target: '0x2::transfer::public_transfer',
      typeArguments: ['0x2::sui::SUI'],
      arguments: [base.gas, base.pure.address(OTHER_ADDRESS)],
    })
    const tx = toBase64(await base.build())
    expect(() => checkWithdraw(tx)).toThrow(ChainActionRefused)
  })

  it('pays someone else', async () => {
    const tx = await tampered(SUILEND_WITHDRAW, (t) => payTo(t, OTHER_ADDRESS))
    expect(() => checkWithdraw(tx)).toThrow(/another address/)
  })

  it("sends a new position's cap to someone else", async () => {
    const tx = await tampered(SUILEND_SUPPLY, (t) => payTo(t, OTHER_ADDRESS))
    expect(() => checkSupply(tx)).toThrow(/another address/)
  })

  it('uses a token other than USDC', async () => {
    const tx = await tampered(SUILEND_WITHDRAW, (t) => {
      const call = callNamed(t, 'withdraw_ctokens')
      call.typeArguments = [call.typeArguments[0] ?? '', USDT]
    })
    expect(() => checkWithdraw(tx)).toThrow(/token Suilend isn't confirmed for/)
  })

  it('uses another pool type', async () => {
    const tx = await tampered(SUILEND_SUPPLY, (t) => {
      callNamed(t, 'create_obligation').typeArguments = [USDT]
    })
    expect(() => checkSupply(tx)).toThrow(/token Suilend isn't confirmed for/)
  })

  it('points at another market', async () => {
    const tx = await tampered(SUILEND_WITHDRAW, (t) => {
      pointAt(inputOf(t, callNamed(t, 'withdraw_ctokens'), 0), OTHER_OBJECT)
    })
    expect(() => checkWithdraw(tx)).toThrow(/object Suilend doesn't use/)
  })

  it('names another reserve', async () => {
    const tx = await tampered(SUILEND_SUPPLY, (t) => {
      const input = inputOf(t, callNamed(t, 'deposit_liquidity_and_mint_ctokens'), 1)
      if (input.Pure === undefined) throw new Error('not a literal')
      input.Pure.bytes = 'AQAAAAAAAAA='
    })
    expect(() => checkSupply(tx)).toThrow(/value Suilend doesn't use/)
  })

  it('is not a Sui transaction, or not readable', () => {
    const near: SigningPayload = { family: 'near', transactions: [] }
    expect(() => suilendVenue.assertSafe(near, SUILEND_SUPPLY_SENDER)).toThrow(/not a Sui/)
    expect(() => checkSupply('not base64!')).toThrow(ChainActionRefused)
  })
})

describe('amounts', () => {
  it('rounds cTokens up, and a whole position converts back within what it holds', () => {
    const asked = BigInt('10000000')
    const ctokens = ctokensForAmount(asked, RESERVE)
    expect(amountForCtokens(ctokens, RESERVE) >= asked - BigInt(1)).toBe(true)

    const held = BigInt('79254808')
    const value = amountForCtokens(held, RESERVE)
    expect(ctokensForAmount(value, RESERVE) <= held).toBe(true)
  })

  it('reads the rate off the contract curve, without rewards', () => {
    expect(suilendSupplyApr(RESERVE)).toBeCloseTo(4.22, 1)
  })

  it('is zero with nothing borrowed, and shows none when the curve does not read', () => {
    expect(suilendSupplyApr({ ...RESERVE, borrowedWad: BigInt(0) })).toBe(0)
    expect(suilendSupplyApr({ ...RESERVE, utilsPercent: [] })).toBeUndefined()
    expect(
      suilendSupplyApr({ ...RESERVE, borrowedWad: BigInt(0), available: BigInt(0) })
    ).toBeUndefined()
  })
})

describe('reading the market', () => {
  const usdc = {
    coin_type: 'dba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
    available_amount: '5',
    ctoken_supply: '5',
    borrowed_amount: { value: '0' },
    unclaimed_spread_fees: { value: '0' },
    config: {
      element: {
        deposit_limit: '5',
        interest_rate_utils: 'AF1hZA==',
        interest_rate_aprs: ['400', '700', '1500', '15000'],
        spread_fee_bps: '2000',
      },
    },
  }
  const market = (entry: unknown) => {
    const reserves: unknown[] = new Array(SUILEND_USDC_RESERVE + 1).fill({})
    reserves[SUILEND_USDC_RESERVE] = entry
    return { reserves }
  }

  it('takes the curve from the bytes the chain returns', () => {
    expect(parseSuilendReserve(market(usdc)).utilsPercent).toEqual([0, 93, 97, 100])
  })

  it('refuses when the pinned reserve is not USDC, or fields are missing', () => {
    expect(() => parseSuilendReserve(market({ ...usdc, coin_type: 'x::y::Z' }))).toThrow(
      /couldn't read Suilend/
    )
    expect(() => parseSuilendReserve(market({ ...usdc, ctoken_supply: undefined }))).toThrow(
      ChainActionRefused
    )
    expect(() => parseSuilendReserve(undefined)).toThrow(ChainActionRefused)
  })
})

describe('positionForSupply', () => {
  it('prefers a loan-free position holding USDC, then any loan-free one', () => {
    const empty = position({ capId: '0x1', ctokens: BigInt(0) })
    const holding = position({ capId: '0x2' })
    const loaned = position({ capId: '0x3', hasBorrows: true })
    expect(positionForSupply([loaned, empty, holding])?.capId).toBe('0x2')
    expect(positionForSupply([loaned, empty])?.capId).toBe('0x1')
  })

  it('never adds to a position with a loan, so a new one opens instead', () => {
    expect(positionForSupply([position({ hasBorrows: true })])).toBeUndefined()
    expect(positionForSupply([])).toBeUndefined()
  })
})

describe('prepare refuses before anything is built', () => {
  it('a token other than USDC', async () => {
    const venue = createSuilendVenue(reader([]))
    await expect(
      venue.prepare({ kind: 'supply', amount: '1', tokenIn: 'SUI' }, ME)
    ).rejects.toThrow(/takes USDC here, not SUI/)
    await expect(venue.prepare({ ...withdraw(), tokenIn: 'USDT' }, ME)).rejects.toThrow(
      ChainActionRefused
    )
  })

  it('a malformed account', async () => {
    await expect(createSuilendVenue(reader([])).prepare(withdraw(), 'nope')).rejects.toThrow(
      /not a Sui address/
    )
  })

  it('a deposit over the market limit', async () => {
    const full = { ...RESERVE, depositLimit: BigInt(1) }
    await expect(
      createSuilendVenue(reader([], full)).prepare(
        { kind: 'supply', amount: '1', tokenIn: 'USDC' },
        ME
      )
    ).rejects.toThrow(/deposit limit/)
  })

  it('a withdrawal with no position', async () => {
    const empty = position({ ctokens: BigInt(0) })
    await expect(createSuilendVenue(reader([empty])).prepare(withdraw(), ME)).rejects.toThrow(
      /no USDC in Suilend/
    )
  })

  it('a withdrawal from a position that backs a loan, and says where to go', async () => {
    const venue = createSuilendVenue(reader([position({ hasBorrows: true })]))
    await expect(venue.prepare(withdraw(), ME)).rejects.toThrow(/backs a loan.*suilend\.fi/)
  })

  it('more than the position holds, and names what it does', async () => {
    const venue = createSuilendVenue(reader([position()]))
    await expect(venue.prepare(withdraw('100000'), ME)).rejects.toThrow(
      /You have about 11\.\d+ USDC in Suilend, which is less than 100000/
    )
  })
})

describe('the venue', () => {
  it('offers only supply and withdraw', () => {
    expect(suilendVenue.kinds).toEqual(['supply', 'withdraw'])
  })

  it('quotes a base rate from the reader alone', async () => {
    const quote = await createSuilendVenue(reader([])).quote?.(
      { kind: 'supply', amount: '1', tokenIn: 'USDC' },
      ME
    )
    expect(quote?.apyPercent).toBeCloseTo(4.22, 1)
  })

  it('has a listing that says it executes', () => {
    expect(suilendListing).toMatchObject({ id: 'suilend', family: 'sui', integration: 'executes' })
  })
})
