import { Transaction } from '@mysten/sui/transactions'
import { fromBase64, toBase64 } from '@mysten/sui/utils'
import { describe, expect, it } from 'vitest'

import { CAPTURED_NAVI_DEPOSIT, CAPTURED_SENDER } from '../chains/sui/captured-transactions'
import { createNaviVenue, naviVenue } from '../chains/sui/navi'
import {
  naviBorrowTransaction,
  naviRepayTransaction,
  naviWithdrawTransaction,
  NAVI_USDC_ASSET_ID,
  prepareNaviBorrow,
  prepareNaviRepay,
  prepareNaviWithdraw,
  readNaviPositions,
  wholeWithdrawAmount,
  type NaviAccount,
  type NaviReader,
} from '../chains/sui/navi-withdraw'
import { ChainActionRefused, type ChainActionRequest } from '../chains/types'
import {
  callNamed,
  inputOf,
  NAVI_BORROW,
  NAVI_BORROW_SENDER,
  NAVI_REPAY,
  NAVI_REPAY_SENDER,
  NAVI_WITHDRAW,
  NAVI_WITHDRAW_SENDER,
  OTHER_ADDRESS,
  OTHER_OBJECT,
  pointAt,
  tampered,
} from './sui-lending-captured'

const UNLISTED = '0x0000000000000000000000000000000000000000000000000000000000000bad::fake::FAKE'
const ME = '0x0000000000000000000000000000000000000000000000000000000000000abc'
const SUI_ASSET = 0
const UNKNOWN_ASSET = 200

function check(transaction: string, account = NAVI_WITHDRAW_SENDER): void {
  naviVenue.assertSafe({ family: 'sui', transaction }, account)
}

function action(kind: ChainActionRequest['kind'], amount = '1', tokenIn = 'USDC') {
  return { kind, amount, tokenIn } as ChainActionRequest
}

const RESERVES = new Map([
  [NAVI_USDC_ASSET_ID, { ltv: 0.8, liquidationThreshold: 0.85, borrowAprPercent: 6 }],
  [SUI_ASSET, { ltv: 0.75, liquidationThreshold: 0.8, borrowAprPercent: 3 }],
])

function account(supplied: [number, bigint][], owed: [number, bigint][] = []): NaviAccount {
  return { supplied: new Map(supplied), owed: new Map(owed), reserves: RESERVES }
}

function reader(over: Partial<NaviReader> = {}, held = account([])): NaviReader {
  return {
    account: async () => held,
    standing: async () => ({ liquidationUsd: 85, limitUsd: 80, owedUsd: 0 }),
    priceUsd: async () => 1,
    borrowFeePercent: async () => 0,
    walletBalance: async () => BigInt(5_000_000),
    ...over,
  }
}

const USDC_10 = BigInt(10_000_000)
const holdsUsdc = account([[NAVI_USDC_ASSET_ID, USDC_10]])

/** Every literal a call was given, as the number it encodes. */
function amountOf(tx: Transaction, name: string, index: number): bigint {
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

describe('what the venue really built passes', () => {
  it('a withdrawal', () => {
    expect(() => check(NAVI_WITHDRAW)).not.toThrow()
  })

  it('a deposit, unchanged by the new checks', () => {
    expect(() =>
      naviVenue.assertSafe({ family: 'sui', transaction: CAPTURED_NAVI_DEPOSIT }, CAPTURED_SENDER)
    ).not.toThrow()
  })

  it('a borrow and a repay', () => {
    expect(() => check(NAVI_BORROW, NAVI_BORROW_SENDER)).not.toThrow()
    expect(() => check(NAVI_REPAY, NAVI_REPAY_SENDER)).not.toThrow()
  })
})

describe('NAVI refuses a withdrawal transaction that', () => {
  it('another account would sign', () => {
    expect(() => check(NAVI_WITHDRAW, OTHER_ADDRESS)).toThrow(/different account/)
  })

  it('calls a contract that is not confirmed', async () => {
    const tx = await tampered(NAVI_WITHDRAW, (t) => {
      callNamed(t, 'entry_withdraw').package = OTHER_OBJECT
    })
    expect(() => check(tx)).toThrow(/haven't confirmed for NAVI/)
  })

  it.each(['withdraw_v2', 'borrow_v2', 'entry_repay_on_behalf_of_user'])(
    'calls %s, which this venue never uses',
    async (name) => {
      const tx = await tampered(NAVI_WITHDRAW, (t) => {
        callNamed(t, 'entry_withdraw').function = name
      })
      expect(() => check(tx)).toThrow(/haven't confirmed for NAVI/)
    }
  )

  it('passes an extra argument', async () => {
    const tx = await tampered(NAVI_WITHDRAW, (t) => {
      const call = callNamed(t, 'entry_withdraw')
      const extra = call.arguments[0]
      if (extra === undefined) throw new Error('no argument')
      call.arguments.push(extra)
    })
    expect(() => check(tx)).toThrow(/wrong arguments/)
  })

  it('takes an extra step of a kind it never needs', async () => {
    const base = Transaction.from(NAVI_WITHDRAW)
    base.makeMoveVec({ type: 'u64', elements: [] })
    const tx = toBase64(await base.build())
    expect(() => check(tx)).toThrow(/does more than NAVI needs/)
  })

  it('pays anything to someone else through the framework', async () => {
    const base = Transaction.from(NAVI_WITHDRAW)
    base.moveCall({
      target: '0x2::transfer::public_transfer',
      typeArguments: ['0x2::sui::SUI'],
      arguments: [base.gas, base.pure.address(OTHER_ADDRESS)],
    })
    const tx = toBase64(await base.build())
    expect(() => check(tx)).toThrow(ChainActionRefused)
  })

  it('pays anything to someone else with a transfer', async () => {
    const base = Transaction.from(NAVI_WITHDRAW)
    base.transferObjects([base.gas], OTHER_ADDRESS)
    const tx = toBase64(await base.build())
    expect(() => check(tx)).toThrow(/another address/)
  })

  it('uses a token outside the list', async () => {
    const tx = await tampered(NAVI_WITHDRAW, (t) => {
      callNamed(t, 'entry_withdraw').typeArguments = [UNLISTED]
    })
    expect(() => check(tx)).toThrow(/token NAVI isn't confirmed for/)
  })

  it.each([
    ['price oracle', 1],
    ['storage', 2],
    ['pool', 3],
    ['first incentive', 6],
    ['second incentive', 7],
  ])('points at another %s', async (_name, index) => {
    const tx = await tampered(NAVI_WITHDRAW, (t) => {
      pointAt(inputOf(t, callNamed(t, 'entry_withdraw'), index), OTHER_OBJECT)
    })
    expect(() => check(tx)).toThrow(/object NAVI doesn't use/)
  })

  it('names another asset', async () => {
    const tx = await tampered(NAVI_WITHDRAW, (t) => {
      const input = inputOf(t, callNamed(t, 'entry_withdraw'), 4)
      if (input.Pure === undefined) throw new Error('not a literal')
      input.Pure.bytes = 'AQ=='
    })
    expect(() => check(tx)).toThrow(/value NAVI doesn't use/)
  })

  it('updates a price from another feed or object', async () => {
    const feed = await tampered(NAVI_WITHDRAW, (t) => {
      const input = inputOf(t, callNamed(t, 'update_single_price_v3'), 6)
      if (input.Pure === undefined) throw new Error('not a literal')
      input.Pure.bytes = toBase64(new Uint8Array(32))
    })
    expect(() => check(feed)).toThrow(/value NAVI doesn't use/)
    const pyth = await tampered(NAVI_WITHDRAW, (t) => {
      pointAt(inputOf(t, callNamed(t, 'update_single_price_v3'), 4), OTHER_OBJECT)
    })
    expect(() => check(pyth)).toThrow(/object NAVI doesn't use/)
  })
})

describe('NAVI refuses a borrow or repay transaction that', () => {
  it('another account would sign', () => {
    expect(() => check(NAVI_BORROW, OTHER_ADDRESS)).toThrow(/different account/)
    expect(() => check(NAVI_REPAY, OTHER_ADDRESS)).toThrow(/different account/)
  })

  it('takes a token that is not listed', async () => {
    const tx = await tampered(NAVI_BORROW, (t) => {
      callNamed(t, 'entry_borrow_v2').typeArguments = [UNLISTED]
    })
    expect(() => check(tx, NAVI_BORROW_SENDER)).toThrow(/token NAVI isn't confirmed for/)
  })

  it('borrows from another pool or storage', async () => {
    const tx = await tampered(NAVI_BORROW, (t) => {
      pointAt(inputOf(t, callNamed(t, 'entry_borrow_v2'), 3), OTHER_OBJECT)
    })
    expect(() => check(tx, NAVI_BORROW_SENDER)).toThrow(/object NAVI doesn't use/)
  })

  it('repays through a contract call that pays for somebody else', async () => {
    const tx = await tampered(NAVI_REPAY, (t) => {
      callNamed(t, 'entry_repay').function = 'entry_repay_on_behalf_of_user'
    })
    expect(() => check(tx, NAVI_REPAY_SENDER)).toThrow(/haven't confirmed for NAVI/)
  })

  it('names another asset on a repay', async () => {
    const tx = await tampered(NAVI_REPAY, (t) => {
      const input = inputOf(t, callNamed(t, 'entry_repay'), 4)
      if (input.Pure === undefined) throw new Error('not a literal')
      input.Pure.bytes = 'AQ=='
    })
    expect(() => check(tx, NAVI_REPAY_SENDER)).toThrow(/value NAVI doesn't use/)
  })

  it('sends what is left over to someone else', async () => {
    const base = Transaction.from(NAVI_REPAY)
    base.transferObjects([base.gas], OTHER_ADDRESS)
    const tx = toBase64(await base.build())
    expect(() => check(tx, NAVI_REPAY_SENDER)).toThrow(/another address/)
  })
})

describe('the transactions it builds', () => {
  const usdc = { assetId: NAVI_USDC_ASSET_ID }

  it('borrow exactly what was asked, with no recipient to change', () => {
    const tx = naviBorrowTransaction(ME, 'USDC', BigInt(1_500_000), [NAVI_USDC_ASSET_ID])
    expect(amountOf(tx, 'entry_borrow_v2', 5)).toBe(BigInt(1_500_000))
    expect(tx.getData().commands.some((c) => c.$kind === 'TransferObjects')).toBe(false)
  })

  it('price every asset the position holds before a borrow', () => {
    const tx = naviBorrowTransaction(ME, 'USDC', BigInt(1), [NAVI_USDC_ASSET_ID, SUI_ASSET])
    const updates = tx
      .getData()
      .commands.filter(
        (c) => c.$kind === 'MoveCall' && c.MoveCall.function === 'update_single_price_v3'
      )
    expect(updates).toHaveLength(2)
  })

  it('repay with no price update, since no check of the position runs', () => {
    const tx = naviRepayTransaction(ME, 'USDC', BigInt(2_000_000))
    const names = tx
      .getData()
      .commands.flatMap((c) => (c.$kind === 'MoveCall' ? [c.MoveCall.function] : []))
    expect(names).toContain('entry_repay')
    expect(names).not.toContain('update_single_price_v3')
    expect(amountOf(tx, 'entry_repay', 6)).toBe(BigInt(2_000_000))
  })

  it('withdraw a number above the position on a whole withdraw, which the contract caps', () => {
    expect(wholeWithdrawAmount(USDC_10) > USDC_10).toBe(true)
    const tx = naviWithdrawTransaction(ME, 'USDC', wholeWithdrawAmount(USDC_10), [usdc.assetId])
    expect(amountOf(tx, 'entry_withdraw', 5)).toBe(wholeWithdrawAmount(USDC_10))
  })

  it('withdraw SUI through the call that can unstake it', () => {
    const tx = naviWithdrawTransaction(ME, 'SUI', BigInt(1), [SUI_ASSET])
    const names = tx
      .getData()
      .commands.flatMap((c) => (c.$kind === 'MoveCall' ? [c.MoveCall.function] : []))
    expect(names).toContain('entry_withdraw_v2')
    expect(names).not.toContain('entry_withdraw')
  })
})

describe('prepareNaviWithdraw refuses before anything is built', () => {
  it('a token NAVI does not hold here', async () => {
    await expect(
      prepareNaviWithdraw(action('withdraw', '1', 'sSUI'), ME, reader({}, holdsUsdc))
    ).rejects.toThrow(/NAVI doesn't take sSUI/)
  })

  it('a malformed account', async () => {
    await expect(
      prepareNaviWithdraw(action('withdraw'), 'nope', reader({}, holdsUsdc))
    ).rejects.toThrow(/not a Sui address/)
  })

  it('more decimals than USDC has', async () => {
    await expect(
      prepareNaviWithdraw(action('withdraw', '0.0000001'), ME, reader({}, holdsUsdc))
    ).rejects.toThrow(/decimal places/)
  })

  it('a wallet with nothing in NAVI', async () => {
    await expect(prepareNaviWithdraw(action('withdraw'), ME, reader())).rejects.toThrow(
      /no USDC in NAVI/
    )
  })

  it('more than the wallet has there, naming what it has', async () => {
    await expect(
      prepareNaviWithdraw(action('withdraw', '11'), ME, reader({}, holdsUsdc))
    ).rejects.toThrow(/You have about 10 USDC in NAVI, which is less than 11/)
  })

  it('collateral a loan depends on, in plain words', async () => {
    const borrowed = account([[NAVI_USDC_ASSET_ID, USDC_10]], [[SUI_ASSET, BigInt(1)]])
    const venue = reader(
      { standing: async () => ({ liquidationUsd: 8.5, limitUsd: 8, owedUsd: 7 }) },
      borrowed
    )
    await expect(prepareNaviWithdraw(action('withdraw', '10'), ME, venue)).rejects.toThrow(
      /Your loan on NAVI depends on this USDC/
    )
  })

  it('a position holding an asset it has no price feed for, naming where to go', async () => {
    const odd = account([
      [NAVI_USDC_ASSET_ID, USDC_10],
      [UNKNOWN_ASSET, BigInt(1)],
    ])
    await expect(prepareNaviWithdraw(action('withdraw'), ME, reader({}, odd))).rejects.toThrow(
      /app\.naviprotocol\.io/
    )
  })

  it('stops, rather than guess, when the position cannot be read', async () => {
    const down = reader({
      account: async () => {
        throw new Error('rpc down')
      },
    })
    await expect(prepareNaviWithdraw(action('withdraw'), ME, down)).rejects.toThrow('rpc down')
  })
})

describe('prepareNaviBorrow refuses before anything is built', () => {
  it('a token NAVI does not lend here', async () => {
    await expect(prepareNaviBorrow(action('borrow', '1', 'sSUI'), ME, reader())).rejects.toThrow(
      /NAVI doesn't take sSUI/
    )
  })

  it('a wallet with no collateral', async () => {
    const none = reader({ standing: async () => ({ liquidationUsd: 0, limitUsd: 0, owedUsd: 0 }) })
    await expect(prepareNaviBorrow(action('borrow'), ME, none)).rejects.toThrow(
      /no collateral on NAVI/
    )
  })

  it('more than the collateral can back, counting the fee', async () => {
    const venue = reader(
      {
        borrowFeePercent: async () => 1,
        standing: async () => ({ liquidationUsd: 1000, limitUsd: 10, owedUsd: 0 }),
      },
      holdsUsdc
    )
    await expect(prepareNaviBorrow(action('borrow', '10'), ME, venue)).rejects.toThrow(
      /can back about 9\.9\d* more USDC/
    )
  })

  it('a loan that would leave little room before liquidation', async () => {
    const venue = reader(
      { standing: async () => ({ liquidationUsd: 14, limitUsd: 12, owedUsd: 0 }) },
      holdsUsdc
    )
    await expect(prepareNaviBorrow(action('borrow', '10'), ME, venue)).rejects.toThrow(
      /health factor at 1\.40.*stops at 1\.5/
    )
  })
})

describe('prepareNaviRepay refuses before anything is built', () => {
  it('a wallet that owes none of it', async () => {
    await expect(prepareNaviRepay(action('repay'), ME, reader({}, holdsUsdc))).rejects.toThrow(
      /don't owe any USDC on NAVI/
    )
  })

  it('a whole repay the wallet cannot cover', async () => {
    const owes = account([], [[NAVI_USDC_ASSET_ID, USDC_10]])
    await expect(
      prepareNaviRepay(
        { ...action('repay', '10'), wholePosition: true },
        ME,
        reader({ walletBalance: async () => BigInt(1_000_000) }, owes)
      )
    ).rejects.toThrow(/You hold 1 USDC, which is less than the 10 you owe/)
  })
})

describe('positions', () => {
  it('reports what is supplied and owed in the listed tokens, in display units', async () => {
    const held = account(
      [
        [NAVI_USDC_ASSET_ID, BigInt(12_500_000)],
        [UNKNOWN_ASSET, BigInt(1)],
      ],
      [[SUI_ASSET, BigInt(2_000_000_000)]]
    )
    expect(await readNaviPositions(ME, reader({}, held))).toEqual([
      { slot: 'borrowed', symbol: 'SUI', amount: '2' },
      { slot: 'supplied', symbol: 'USDC', amount: '12.5' },
    ])
  })

  it('is empty for a wallet with nothing there', async () => {
    expect(await readNaviPositions(ME, reader())).toEqual([])
  })

  it('throws when it cannot read, and never reads as empty', async () => {
    const down = reader({
      account: async () => {
        throw new Error('rpc down')
      },
    })
    await expect(readNaviPositions(ME, down)).rejects.toThrow('rpc down')
    await expect(createNaviVenue(down).positions?.(ME)).rejects.toThrow('rpc down')
  })
})

describe('the venue', () => {
  it('supplies, withdraws, borrows and repays', () => {
    expect(naviVenue.kinds).toEqual(['supply', 'withdraw', 'borrow', 'repay'])
  })

  it('still supplies USDC only', async () => {
    await expect(
      createNaviVenue(reader()).prepare(action('supply', '1', 'SUI'), ME)
    ).rejects.toThrow(/takes USDC here, not SUI/)
  })

  it('quotes no rate on a loan, where a saving rate would mislead', async () => {
    expect(await createNaviVenue(reader()).quote?.(action('borrow'), ME)).toEqual({})
  })
})
