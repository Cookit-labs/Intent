import { Transaction } from '@mysten/sui/transactions'
import { toBase64 } from '@mysten/sui/utils'
import { describe, expect, it } from 'vitest'

import { CAPTURED_NAVI_DEPOSIT, CAPTURED_SENDER } from '../chains/sui/captured-transactions'
import { naviVenue } from '../chains/sui/navi'
import {
  assertWithdrawableHoldings,
  NAVI_USDC_ASSET_ID,
  prepareNaviWithdraw,
} from '../chains/sui/navi-withdraw'
import { ChainActionRefused, type ChainActionRequest } from '../chains/types'
import {
  callNamed,
  inputOf,
  NAVI_WITHDRAW,
  NAVI_WITHDRAW_SENDER,
  OTHER_ADDRESS,
  OTHER_OBJECT,
  pointAt,
  tampered,
} from './sui-lending-captured'

const USDT = '0x375f70cf2ae4c00bf37117d0c85a2c71545e6ee05c4a5c7d282cd66a4504b068::usdt::USDT'
const ME = '0x0000000000000000000000000000000000000000000000000000000000000abc'
const OTHER_ASSET = 3

function check(transaction: string, account = NAVI_WITHDRAW_SENDER): void {
  naviVenue.assertSafe({ family: 'sui', transaction }, account)
}

function withdraw(amount = '1'): ChainActionRequest {
  return { kind: 'withdraw', amount, tokenIn: 'USDC' }
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

  it.each(['withdraw_v2', 'entry_borrow_v2', 'borrow_v2'])(
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

  it('uses a token other than USDC', async () => {
    const tx = await tampered(NAVI_WITHDRAW, (t) => {
      callNamed(t, 'entry_withdraw').typeArguments = [USDT]
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

describe('assertWithdrawableHoldings', () => {
  it('passes a USDC-only position', () => {
    expect(() =>
      assertWithdrawableHoldings({ collaterals: [NAVI_USDC_ASSET_ID], loans: [] })
    ).not.toThrow()
  })

  it('refuses a wallet with no USDC in NAVI', () => {
    expect(() => assertWithdrawableHoldings(undefined)).toThrow(/no USDC in NAVI/)
    expect(() => assertWithdrawableHoldings({ collaterals: [OTHER_ASSET], loans: [] })).toThrow(
      /no USDC in NAVI/
    )
  })

  it('sends a position with more in it to NAVI, rather than build what would abort', () => {
    const others = { collaterals: [NAVI_USDC_ASSET_ID, OTHER_ASSET], loans: [] }
    const loan = { collaterals: [NAVI_USDC_ASSET_ID], loans: [OTHER_ASSET] }
    expect(() => assertWithdrawableHoldings(others)).toThrow(/app\.naviprotocol\.io/)
    expect(() => assertWithdrawableHoldings(loan)).toThrow(/app\.naviprotocol\.io/)
  })
})

describe('prepareNaviWithdraw refuses before anything is built', () => {
  const holdsUsdc = async () => ({ collaterals: [NAVI_USDC_ASSET_ID], loans: [] })

  it('a token other than USDC', async () => {
    await expect(
      prepareNaviWithdraw({ ...withdraw(), tokenIn: 'SUI' }, ME, holdsUsdc)
    ).rejects.toThrow(/takes USDC here, not SUI/)
  })

  it('a malformed account', async () => {
    await expect(prepareNaviWithdraw(withdraw(), 'nope', holdsUsdc)).rejects.toThrow(
      /not a Sui address/
    )
  })

  it('more decimals than USDC has', async () => {
    await expect(prepareNaviWithdraw(withdraw('0.0000001'), ME, holdsUsdc)).rejects.toThrow(
      /decimal places/
    )
  })

  it('a wallet with nothing in NAVI', async () => {
    await expect(prepareNaviWithdraw(withdraw(), ME, async () => undefined)).rejects.toThrow(
      /no USDC in NAVI/
    )
  })
})

describe('the venue', () => {
  it('offers supply and withdraw', () => {
    expect(naviVenue.kinds).toEqual(['supply', 'withdraw'])
  })
})
