import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
} from '@stellar/stellar-sdk'
import { describe, expect, it } from 'vitest'

import { assertPerpOrder } from '../perps/assert-order'

/**
 * Admitting a Noether order envelope only when every field is the user's.
 *
 * The envelope is built by the gateway, not by this app, which is the whole
 * reason this file exists: nothing signed here was built here, so the bytes
 * are read back and compared with what the user asked for. The argument
 * layout below is the market contract's `open_position(trader, asset,
 * collateral, leverage, direction, acceptable_price)` as read from its source
 * and from a real envelope decoded on 2026-09-23; `Direction` is a u32 with
 * Long = 0 and Short = 1.
 */

const ACCOUNT = 'GDA4JVVUE6CTF7FEGOFMKA3YE4E5J7SAAK7RACZLNIMXYF24OLLR3KZO'
const OTHER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
const MARKET = 'CBHHWFAYLB3SXJCE232DC6WNSK74IBEOROAGCI2AFBA2H5NQOH2KYKNN'
const ROUTER = 'CBDVQKYEN6QMRGQZC77DFYEQXQHDMCVJ3TPBJKNERJVMIESA6GQT44LG'
const STRANGER = 'CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD'

const EXPECT = {
  account: ACCOUNT,
  contracts: { market: MARKET, router: ROUTER },
  asset: 'XLM',
  collateral: '500000000',
  leverage: 10,
  side: 'long' as const,
}

interface Tweak {
  source?: string
  contract?: string
  fn?: string
  trader?: string
  asset?: string
  collateral?: string
  leverage?: number
  direction?: number
  acceptable?: string
  extraOp?: boolean
  payment?: boolean
  args?: import('@stellar/stellar-sdk').xdr.ScVal[]
}

function marketArgs(t: Tweak): import('@stellar/stellar-sdk').xdr.ScVal[] {
  return [
    new Address(t.trader ?? ACCOUNT).toScVal(),
    nativeToScVal(t.asset ?? 'XLM', { type: 'symbol' }),
    nativeToScVal(BigInt(t.collateral ?? '500000000'), { type: 'i128' }),
    nativeToScVal(t.leverage ?? 10, { type: 'u32' }),
    nativeToScVal(t.direction ?? 0, { type: 'u32' }),
    nativeToScVal(BigInt(t.acceptable ?? '0'), { type: 'i128' }),
  ]
}

function envelope(t: Tweak = {}): string {
  const b = new TransactionBuilder(new Account(t.source ?? ACCOUNT, '100'), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
  if (t.payment === true) {
    b.addOperation(Operation.payment({ destination: OTHER, asset: Asset.native(), amount: '1' }))
  } else {
    b.addOperation(
      new Contract(t.contract ?? MARKET).call(t.fn ?? 'open_position', ...(t.args ?? marketArgs(t)))
    )
  }
  if (t.extraOp === true) {
    b.addOperation(Operation.payment({ destination: OTHER, asset: Asset.native(), amount: '1' }))
  }
  return b.setTimeout(300).build().toXDR()
}

describe('assertPerpOrder on the market contract', () => {
  it('admits an open_position that matches the request', () => {
    const read = assertPerpOrder(envelope(), EXPECT)
    expect(read).toEqual({
      contract: 'market',
      functionName: 'open_position',
      acceptablePrice: '0',
    })
  })

  it('reads the acceptable price the gateway set', () => {
    expect(assertPerpOrder(envelope({ acceptable: '2121791' }), EXPECT).acceptablePrice).toBe(
      '2121791'
    )
  })

  it('admits a short when a short was asked for', () => {
    expect(() =>
      assertPerpOrder(envelope({ direction: 1 }), { ...EXPECT, side: 'short' })
    ).not.toThrow()
  })

  it.each<[string, Tweak, RegExp]>([
    ['sourced by another account', { source: OTHER }, /source/],
    ['calling a contract that is not Noether', { contract: STRANGER }, /not the Noether/],
    ['calling a function other than open_position', { fn: 'close_position' }, /close_position/],
    ['naming another trader', { trader: OTHER }, /trader/],
    ['naming another market', { asset: 'BTC' }, /BTC/],
    ['with different collateral', { collateral: '600000000' }, /collateral/],
    ['with different leverage', { leverage: 5 }, /leverage/],
    ['on the other side', { direction: 1 }, /short/],
    ['with a negative acceptable price', { acceptable: '-1' }, /acceptable/],
    ['carrying a second operation', { extraOp: true }, /one operation/],
    ['that is a payment', { payment: true }, /invocation/],
  ])('refuses an envelope %s', (_, tweak, message) => {
    expect(() => assertPerpOrder(envelope(tweak), EXPECT)).toThrow(message)
  })

  it('refuses an argument list of the wrong length', () => {
    expect(() => assertPerpOrder(envelope({ args: marketArgs({}).slice(0, 5) }), EXPECT)).toThrow(
      /six arguments/
    )
  })

  it('refuses a fee bump', () => {
    const inner = TransactionBuilder.fromXDR(envelope(), Networks.TESTNET)
    const bump = TransactionBuilder.buildFeeBumpTransaction(
      Keypair.random(),
      '200',
      inner as import('@stellar/stellar-sdk').Transaction,
      Networks.TESTNET
    )
    expect(() => assertPerpOrder(bump.toXDR(), EXPECT)).toThrow(/fee bump/)
  })

  it('refuses a cross-margin open, which this slice does not offer', () => {
    // A cross position has no liquidation price of its own and is liquidated
    // at account level. The review card cannot describe that honestly yet.
    expect(() => assertPerpOrder(envelope({ fn: 'open_position_cross' }), EXPECT)).toThrow(
      /open_position_cross/
    )
  })
})

describe('assertPerpOrder on the router', () => {
  /**
   * `open_with_price(trader, collateral, leverage, direction, acceptable_price,
   * attestation)`: the form the venue's own web app submits, decoded from a
   * real transaction. The asset lives inside the attestation map.
   */
  function routerArgs(t: Tweak = {}): import('@stellar/stellar-sdk').xdr.ScVal[] {
    return [
      new Address(t.trader ?? ACCOUNT).toScVal(),
      nativeToScVal(BigInt(t.collateral ?? '500000000'), { type: 'i128' }),
      nativeToScVal(t.leverage ?? 10, { type: 'u32' }),
      nativeToScVal(t.direction ?? 0, { type: 'u32' }),
      nativeToScVal(BigInt(t.acceptable ?? '2121791'), { type: 'i128' }),
      nativeToScVal(
        {
          asset: nativeToScVal(t.asset ?? 'XLM', { type: 'symbol' }),
          prices: nativeToScVal([BigInt('2132453')], { type: 'i128' }),
          pubkeys: nativeToScVal([Buffer.alloc(32, 1)]),
          round_id: nativeToScVal(BigInt(3580335013), { type: 'u64' }),
          sigs: nativeToScVal([Buffer.alloc(64, 2)]),
          timestamp: nativeToScVal(BigInt(1790167506), { type: 'u64' }),
        },
        {
          type: {
            asset: ['symbol', null],
            prices: ['symbol', null],
            pubkeys: ['symbol', null],
            round_id: ['symbol', null],
            sigs: ['symbol', null],
            timestamp: ['symbol', null],
          },
        }
      ),
    ]
  }

  it('admits an open_with_price that matches the request', () => {
    const read = assertPerpOrder(
      envelope({ contract: ROUTER, fn: 'open_with_price', args: routerArgs() }),
      EXPECT
    )
    expect(read).toEqual({
      contract: 'router',
      functionName: 'open_with_price',
      acceptablePrice: '2121791',
    })
  })

  it('reads the asset from the attestation and refuses a mismatch', () => {
    expect(() =>
      assertPerpOrder(
        envelope({ contract: ROUTER, fn: 'open_with_price', args: routerArgs({ asset: 'BTC' }) }),
        EXPECT
      )
    ).toThrow(/BTC/)
  })

  it('refuses a router function other than open_with_price', () => {
    expect(() =>
      assertPerpOrder(
        envelope({ contract: ROUTER, fn: 'close_with_price', args: routerArgs() }),
        EXPECT
      )
    ).toThrow(/close_with_price/)
  })
})
