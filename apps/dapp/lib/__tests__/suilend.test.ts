import { Transaction } from '@mysten/sui/transactions'
import { fromBase64, toBase64 } from '@mysten/sui/utils'
import { describe, expect, it } from 'vitest'

import type { PythReading } from '../chains/sui/lending-calls'
import {
  accruedReserve,
  amountForCtokens,
  createSuilendVenue,
  ctokensForAmount,
  owedOn,
  parseSuilendReserve,
  positionForSupply,
  standingOf,
  suilendBorrowApr,
  suilendBorrowTransaction,
  suilendRepayTransaction,
  SUILEND_RESERVES,
  SUILEND_USDC_RESERVE,
  suilendSupplyApr,
  suilendVenue,
  suilendWithdrawTransaction,
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
  SUILEND_BORROW,
  SUILEND_BORROW_SENDER,
  SUILEND_REPAY,
  SUILEND_REPAY_SENDER,
  SUILEND_SUPPLY,
  SUILEND_SUPPLY_SENDER,
  SUILEND_WITHDRAW,
  SUILEND_WITHDRAW_SENDER,
  tampered,
} from './sui-lending-captured'

const UNLISTED = '0x0000000000000000000000000000000000000000000000000000000000000bad::fake::FAKE'
const ME = '0x0000000000000000000000000000000000000000000000000000000000000abc'
const CAP = '0x0000000000000000000000000000000000000000000000000000000000000c01'
const WAD = BigInt('1000000000000000000')
const USDT_RESERVE = SUILEND_RESERVES['USDT'] ?? 0
const SUI_RESERVE = SUILEND_RESERVES['SUI'] ?? 0

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
  coinName: 'usdc',
  decimals: 6,
  available: BigInt('5627000000000'),
  ctokenSupply: BigInt('25263000000000'),
  borrowedWad: BigInt('22749000000000') * WAD,
  spreadFeesWad: BigInt('1856000000') * WAD,
  depositLimit: BigInt('110000000000000'),
  borrowLimit: BigInt('85000000000000'),
  utilsPercent: [0, 93, 97, 100],
  aprsBps: [400, 700, 1500, 15000],
  spreadFeeBps: 2000,
  cumulativeBorrowRateWad: WAD,
  interestUpdatedSeconds: 0,
  openLtvPercent: 77,
  closeLtvPercent: 80,
  borrowWeightBps: 10_000,
  borrowFeeBps: 0,
  feed: new Uint8Array(32),
}

function position(
  ctokens: bigint = BigInt('10000000'),
  borrows: SuilendPosition['borrows'] = []
): SuilendPosition {
  return {
    capId: CAP,
    obligationId: '0x0000000000000000000000000000000000000000000000000000000000000b01',
    deposits: ctokens > BigInt(0) ? [{ reserve: SUILEND_USDC_RESERVE, ctokens }] : [],
    borrows,
  }
}

const SOME_DEBT = {
  reserve: USDT_RESERVE,
  amountWad: BigInt(9_000_000) * WAD,
  rateWad: WAD,
}

const PRICE: PythReading = { objectId: OTHER_OBJECT, priceUsd: 1, emaUsd: 1, ageSeconds: 5 }

function reader(
  positions: SuilendPosition[],
  reserve: SuilendReserve = RESERVE,
  over: Partial<SuilendReader> = {}
): SuilendReader {
  return {
    market: async () => () => reserve,
    positions: async () => positions,
    prices: async (reserves) => reserves.map(() => PRICE),
    walletBalance: async () => BigInt(100_000_000),
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
  it('a first supply and a withdrawal', () => {
    expect(() => checkSupply(SUILEND_SUPPLY)).not.toThrow()
    expect(() => checkWithdraw(SUILEND_WITHDRAW)).not.toThrow()
  })

  it('a borrow and a repay', () => {
    expect(() => checkSupply(SUILEND_BORROW, SUILEND_BORROW_SENDER)).not.toThrow()
    expect(() => checkSupply(SUILEND_REPAY, SUILEND_REPAY_SENDER)).not.toThrow()
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

  it.each(['forgive', 'liquidate', 'claim_rewards', 'refresh_reserve_price'])(
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

  it('uses a token outside the list', async () => {
    const tx = await tampered(SUILEND_WITHDRAW, (t) => {
      const call = callNamed(t, 'withdraw_ctokens')
      call.typeArguments = [call.typeArguments[0] ?? '', UNLISTED]
    })
    expect(() => checkWithdraw(tx)).toThrow(/token Suilend isn't confirmed for/)
  })

  it('uses another pool type', async () => {
    const tx = await tampered(SUILEND_SUPPLY, (t) => {
      callNamed(t, 'create_obligation').typeArguments = [UNLISTED]
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

  it('borrows from another reserve than the token it names', async () => {
    const tx = await tampered(SUILEND_BORROW, (t) => {
      const input = inputOf(t, callNamed(t, 'borrow_request'), 1)
      if (input.Pure === undefined) throw new Error('not a literal')
      input.Pure.bytes = 'AQAAAAAAAAA='
    })
    expect(() => checkSupply(tx, SUILEND_BORROW_SENDER)).toThrow(/value Suilend doesn't use/)
  })

  it('sends a borrow to someone else', async () => {
    const tx = await tampered(SUILEND_BORROW, (t) => payTo(t, OTHER_ADDRESS))
    expect(() => checkSupply(tx, SUILEND_BORROW_SENDER)).toThrow(/another address/)
  })

  it("repays someone else's loan, by naming it outright", async () => {
    const base = Transaction.from(SUILEND_REPAY)
    const data = JSON.parse(await base.toJSON()) as {
      inputs: unknown[]
      commands: { MoveCall?: { function: string; arguments: unknown[] } }[]
    }
    const repay = data.commands.find((c) => c.MoveCall?.function === 'repay')?.MoveCall
    if (repay === undefined) throw new Error('no repay')
    data.inputs.push({ Pure: { bytes: toBase64(new Uint8Array(32)) } })
    repay.arguments[2] = { Input: data.inputs.length - 1 }
    const tx = toBase64(await Transaction.from(JSON.stringify(data)).build())
    expect(() => checkSupply(tx, SUILEND_REPAY_SENDER)).toThrow(/isn't shown to be yours/)
  })

  it('sends a repay’s change to someone else', async () => {
    const tx = await tampered(SUILEND_REPAY, (t) => payTo(t, OTHER_ADDRESS))
    expect(() => checkSupply(tx, SUILEND_REPAY_SENDER)).toThrow(/another address/)
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
    expect(suilendBorrowApr(RESERVE)).toBeCloseTo(6.5, 0)
  })

  it('is zero with nothing borrowed, and shows none when the curve does not read', () => {
    expect(suilendSupplyApr({ ...RESERVE, borrowedWad: BigInt(0) })).toBe(0)
    expect(suilendSupplyApr({ ...RESERVE, utilsPercent: [] })).toBeUndefined()
    expect(
      suilendSupplyApr({ ...RESERVE, borrowedWad: BigInt(0), available: BigInt(0) })
    ).toBeUndefined()
  })

  it('adds interest since the reserve last moved, to what is owed and what is held', () => {
    const later = accruedReserve({ ...RESERVE, interestUpdatedSeconds: 1000 }, 1000 + 86_400)
    const owed = owedOn(
      { reserve: SUILEND_USDC_RESERVE, amountWad: BigInt(100_000_000) * WAD, rateWad: WAD },
      later
    )
    expect(owed).toBeGreaterThan(BigInt(100_000_000))
    expect(owed).toBeLessThan(BigInt(100_100_000))
    expect(amountForCtokens(BigInt(100_000_000), later)).toBeGreaterThan(
      amountForCtokens(BigInt(100_000_000), RESERVE)
    )
  })

  it('counts a debt up from when the position last read the rate', () => {
    const owed = owedOn(
      { reserve: USDT_RESERVE, amountWad: BigInt(100) * WAD, rateWad: WAD },
      { ...RESERVE, cumulativeBorrowRateWad: (WAD * BigInt(110)) / BigInt(100) }
    )
    expect(owed).toBe(BigInt(110))
  })
})

describe('reading the market', () => {
  const usdc = {
    coin_type: 'dba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
    mint_decimals: 6,
    available_amount: '5',
    ctoken_supply: '5',
    borrowed_amount: { value: '0' },
    unclaimed_spread_fees: { value: '0' },
    cumulative_borrow_rate: { value: '1000000000000000000' },
    interest_last_update_timestamp_s: '1',
    price_identifier: { bytes: 'AQ==' },
    config: {
      element: {
        deposit_limit: '5',
        borrow_limit: '5',
        borrow_fee_bps: '0',
        borrow_weight_bps: '10000',
        open_ltv_pct: 77,
        close_ltv_pct: 80,
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

  it('reads the loan rules and the feed', () => {
    expect(parseSuilendReserve(market(usdc))).toMatchObject({
      openLtvPercent: 77,
      closeLtvPercent: 80,
      borrowWeightBps: 10_000,
      feed: new Uint8Array([1]),
    })
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
  const at = (capId: string, ctokens: bigint, borrows: SuilendPosition['borrows'] = []) => ({
    ...position(ctokens, borrows),
    capId,
  })

  it('prefers a loan-free position holding USDC, then any loan-free one', () => {
    const empty = at('0x1', BigInt(0))
    const holding = at('0x2', BigInt(5))
    const loaned = at('0x3', BigInt(5), [SOME_DEBT])
    expect(positionForSupply([loaned, empty, holding])?.capId).toBe('0x2')
    expect(positionForSupply([loaned, empty])?.capId).toBe('0x1')
  })

  it('never adds to a position with a loan, so a new one opens instead', () => {
    expect(positionForSupply([at('0x3', BigInt(5), [SOME_DEBT])])).toBeUndefined()
    expect(positionForSupply([])).toBeUndefined()
  })
})

describe('a position in dollars', () => {
  it('weighs collateral low and debt high, as the contract does', () => {
    const market = () => RESERVE
    const standing = standingOf(position(BigInt(100_000_000), [SOME_DEBT]), market, (reserve) =>
      reserve === USDT_RESERVE
        ? { ...PRICE, priceUsd: 1, emaUsd: 1.1 }
        : { ...PRICE, priceUsd: 1, emaUsd: 0.9 }
    )
    const value = Number(amountForCtokens(BigInt(100_000_000), RESERVE)) / 1e6
    expect(standing.limitUsd).toBeCloseTo(value * 0.9 * 0.77, 4)
    expect(standing.liquidationUsd).toBeCloseTo(value * 1 * 0.8, 4)
    expect(standing.owedUsd).toBeCloseTo(9 * 1.1, 4)
  })
})

describe('the transactions it builds', () => {
  it('borrow exactly what was asked, and refresh every price first', () => {
    const refreshes = [
      { reserve: SUILEND_USDC_RESERVE, priceObject: OTHER_OBJECT },
      { reserve: USDT_RESERVE, priceObject: OTHER_OBJECT },
    ]
    const tx = suilendBorrowTransaction(ME, USDT_RESERVE, BigInt(1_500_000), CAP, refreshes)
    expect(literal(tx, 'borrow_request', 4)).toBe(BigInt(1_500_000))
    expect(calls(tx).filter((n) => n === 'refresh_reserve_price_pro_compatible')).toHaveLength(2)
    const transfers = tx.getData().commands.filter((c) => c.$kind === 'TransferObjects')
    expect(transfers).toHaveLength(1)
  })

  it('bring SUI back from staking before paying it out', () => {
    const borrow = suilendBorrowTransaction(ME, SUI_RESERVE, BigInt(1), CAP, [])
    expect(calls(borrow)).toContain('unstake_sui_from_staker')
    const other = suilendBorrowTransaction(ME, USDT_RESERVE, BigInt(1), CAP, [])
    expect(calls(other)).not.toContain('unstake_sui_from_staker')
  })

  it('name a loan by the signer’s own cap, and take no price on a repay', () => {
    const tx = suilendRepayTransaction(ME, USDT_RESERVE, [{ capId: CAP, coin: BigInt(5) }])
    expect(calls(tx)).toEqual(['obligation_id', 'repay'])
  })

  it('pay every position on a whole repay', () => {
    const tx = suilendRepayTransaction(ME, USDT_RESERVE, [
      { capId: CAP, coin: BigInt(5) },
      { capId: OTHER_OBJECT, coin: BigInt(6) },
    ])
    expect(calls(tx).filter((n) => n === 'repay')).toHaveLength(2)
  })

  it('take every share of a position on a whole withdraw', () => {
    const tx = suilendWithdrawTransaction(
      ME,
      SUILEND_USDC_RESERVE,
      [{ capId: CAP, ctokens: BigInt(79_254_808) }],
      []
    )
    expect(literal(tx, 'withdraw_ctokens', 4)).toBe(BigInt(79_254_808))
    expect(calls(tx)).not.toContain('refresh_reserve_price_pro_compatible')
  })
})

describe('prepare refuses before anything is built', () => {
  it('a token Suilend has no reserve for', async () => {
    const venue = createSuilendVenue(reader([]))
    await expect(
      venue.prepare({ kind: 'supply', amount: '1', tokenIn: 'SUI' }, ME)
    ).rejects.toThrow(/takes USDC here, not SUI/)
    await expect(venue.prepare({ ...withdraw(), tokenIn: 'afSUI' }, ME)).rejects.toThrow(
      /doesn't take afSUI/
    )
    await expect(venue.prepare(action('borrow', '1', 'afSUI'), ME)).rejects.toThrow(
      /doesn't take afSUI/
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
    const empty = position(BigInt(0))
    await expect(createSuilendVenue(reader([empty])).prepare(withdraw(), ME)).rejects.toThrow(
      /no USDC in Suilend/
    )
  })

  it('taking out collateral a loan depends on, in plain words', async () => {
    const venue = createSuilendVenue(reader([position(BigInt('10000000'), [SOME_DEBT])]))
    await expect(venue.prepare(withdraw('11'), ME)).rejects.toThrow(
      /Your loan on Suilend depends on this USDC/
    )
  })

  it('a whole withdraw a loan depends on, in plain words', async () => {
    const venue = createSuilendVenue(reader([position(BigInt('10000000'), [SOME_DEBT])]))
    await expect(venue.prepare({ ...withdraw('11'), wholePosition: true }, ME)).rejects.toThrow(
      /Your loan on Suilend depends on this USDC/
    )
  })

  it('more than the position holds, and names what it does', async () => {
    const venue = createSuilendVenue(reader([position()]))
    await expect(venue.prepare(withdraw('100000'), ME)).rejects.toThrow(
      /You have about 11\.\d+ USDC in Suilend, which is less than 100000/
    )
  })

  it('a borrow with no collateral', async () => {
    await expect(
      createSuilendVenue(reader([])).prepare(action('borrow', '1', 'USDT'), ME)
    ).rejects.toThrow(/no collateral on Suilend/)
  })

  it('a borrow of a token the position holds as collateral', async () => {
    await expect(
      createSuilendVenue(reader([position()])).prepare(action('borrow', '1', 'USDC'), ME)
    ).rejects.toThrow(/won't lend USDC against a position that holds USDC/)
  })

  it('a borrow past what the collateral can back', async () => {
    const usdc = position(BigInt(1_000_000))
    const asUsdt = { ...usdc, deposits: [{ reserve: USDT_RESERVE, ctokens: BigInt(1_000_000) }] }
    await expect(
      createSuilendVenue(reader([asUsdt])).prepare(action('borrow', '10', 'USDC'), ME)
    ).rejects.toThrow(/can back about/)
  })

  it('a borrow of a reserve closed to lending', async () => {
    await expect(
      createSuilendVenue(reader([position()], { ...RESERVE, borrowLimit: BigInt(0) })).prepare(
        action('borrow', '1', 'sSUI'),
        ME
      )
    ).rejects.toThrow(/doesn't lend sSUI/)
  })

  it('a borrow when the price published on chain is too old', async () => {
    const stale = reader(
      [{ ...position(), deposits: [{ reserve: USDT_RESERVE, ctokens: BigInt(1_000_000) }] }],
      RESERVE,
      { prices: async (reserves) => reserves.map(() => ({ ...PRICE, ageSeconds: 90 })) }
    )
    await expect(
      createSuilendVenue(stale).prepare(action('borrow', '0.1', 'USDC'), ME)
    ).rejects.toThrow(/prices from the last 60 seconds.*Try again/)
  })

  it('a repay of a token the wallet does not owe', async () => {
    await expect(
      createSuilendVenue(reader([position()])).prepare(action('repay'), ME)
    ).rejects.toThrow(/don't owe any USDC on Suilend/)
  })

  it('a whole repay the wallet cannot cover', async () => {
    const venue = createSuilendVenue(
      reader([position(BigInt(1), [SOME_DEBT])], RESERVE, { walletBalance: async () => BigInt(1) })
    )
    await expect(
      venue.prepare({ ...action('repay', '9', 'USDT'), wholePosition: true }, ME)
    ).rejects.toThrow(/which is less than the 9 you owe/)
  })
})

describe('positions', () => {
  it('reports what is supplied and owed in listed tokens', async () => {
    const held = await createSuilendVenue(
      reader([position(BigInt('10000000'), [SOME_DEBT])])
    ).positions?.(ME)
    const supplied = held?.find((p) => p.slot === 'supplied' && p.symbol === 'USDC')
    expect(Number(supplied?.amount)).toBeGreaterThan(10)
    expect(held?.find((p) => p.slot === 'borrowed' && p.symbol === 'USDT')?.amount).toBe('9')
  })

  it('leaves out a reserve this app does not list', async () => {
    const odd = {
      ...position(BigInt(0)),
      deposits: [{ reserve: 8, ctokens: BigInt(5) }],
    }
    expect(await createSuilendVenue(reader([odd])).positions?.(ME)).toEqual([])
  })

  it('is empty for a wallet with no position', async () => {
    expect(await createSuilendVenue(reader([])).positions?.(ME)).toEqual([])
  })

  it('throws when it cannot read, and never reads as empty', async () => {
    const down = reader([], RESERVE, {
      positions: async () => {
        throw new Error('rpc down')
      },
    })
    await expect(createSuilendVenue(down).positions?.(ME)).rejects.toThrow('rpc down')
  })
})

describe('the venue', () => {
  it('supplies, withdraws, borrows and repays', () => {
    expect(suilendVenue.kinds).toEqual(['supply', 'withdraw', 'borrow', 'repay'])
  })

  it('quotes a base rate from the reader alone', async () => {
    const quote = await createSuilendVenue(reader([])).quote?.(
      { kind: 'supply', amount: '1', tokenIn: 'USDC' },
      ME
    )
    expect(quote?.apyPercent).toBeCloseTo(4.22, 1)
  })

  it('quotes no rate on a loan, where a saving rate would mislead', async () => {
    expect(await createSuilendVenue(reader([])).quote?.(action('borrow'), ME)).toEqual({})
  })

  it('has a listing that says it executes', () => {
    expect(suilendListing).toMatchObject({ id: 'suilend', family: 'sui', integration: 'executes' })
  })
})
