import { stellarNetwork } from '@intent/config'
import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk'
import { describe, expect, it } from 'vitest'

import { USDC } from '../swap/assets'
import { assertNairaPayment, buildNairaPayment } from '../naira/build-payment'

const PAYER = Keypair.random().publicKey()
const DEPOSIT = Keypair.random().publicKey()
const OTHER = Keypair.random().publicKey()

const expectation = { destination: DEPOSIT, coin: 'xlm' as const, amount: '6.0000000' }
const usdcExpectation = { destination: DEPOSIT, coin: 'usdc' as const, amount: '29.8731234' }

function envelope(
  overrides: { destination?: string; amount?: string; asset?: Asset; ops?: number } = {}
): string {
  const builder = new TransactionBuilder(new Account(PAYER, '100'), {
    fee: BASE_FEE,
    networkPassphrase: stellarNetwork.networkPassphrase,
  })
  for (let i = 0; i < (overrides.ops ?? 1); i += 1) {
    builder.addOperation(
      Operation.payment({
        destination: overrides.destination ?? DEPOSIT,
        asset: overrides.asset ?? Asset.native(),
        amount: overrides.amount ?? '6',
      })
    )
  }
  return builder.setTimeout(180).build().toXDR()
}

describe('assertNairaPayment', () => {
  it('admits exactly the payment the order asked for', () => {
    expect(() => assertNairaPayment(envelope(), PAYER, expectation)).not.toThrow()
    // 6 and 6.0000000 are one amount.
    expect(() =>
      assertNairaPayment(envelope({ amount: '6.0000000' }), PAYER, expectation)
    ).not.toThrow()
  })

  it('refuses another destination', () => {
    expect(() => assertNairaPayment(envelope({ destination: OTHER }), PAYER, expectation)).toThrow(
      /destination/
    )
  })

  it('refuses another amount, up or down', () => {
    expect(() => assertNairaPayment(envelope({ amount: '6.0000001' }), PAYER, expectation)).toThrow(
      /amount/
    )
    expect(() => assertNairaPayment(envelope({ amount: '5' }), PAYER, expectation)).toThrow(
      /amount/
    )
  })

  it('refuses a payment in anything but native XLM', () => {
    const usdc = new Asset('USDC', Keypair.random().publicKey())
    expect(() => assertNairaPayment(envelope({ asset: usdc }), PAYER, expectation)).toThrow(/asset/)
  })

  it('refuses extra operations riding along with the payment', () => {
    expect(() => assertNairaPayment(envelope({ ops: 2 }), PAYER, expectation)).toThrow(/operations/)
  })

  it('refuses a transaction signed for a different account', () => {
    expect(() => assertNairaPayment(envelope(), OTHER, expectation)).toThrow(/source/)
  })
})

describe('assertNairaPayment in USDC', () => {
  const usdc = new Asset(USDC.code, USDC.issuer as string)
  const lookAlike = new Asset(USDC.code, Keypair.random().publicKey())

  it('admits the app’s USDC for the exact amount', () => {
    expect(() =>
      assertNairaPayment(envelope({ asset: usdc, amount: '29.8731234' }), PAYER, usdcExpectation)
    ).not.toThrow()
  })

  it('refuses a look-alike USDC from another issuer', () => {
    expect(() =>
      assertNairaPayment(
        envelope({ asset: lookAlike, amount: '29.8731234' }),
        PAYER,
        usdcExpectation
      )
    ).toThrow(/asset/)
  })

  it('refuses native XLM for a USDC order, and USDC for an XLM order', () => {
    expect(() =>
      assertNairaPayment(envelope({ amount: '29.8731234' }), PAYER, usdcExpectation)
    ).toThrow(/asset/)
    expect(() => assertNairaPayment(envelope({ asset: usdc }), PAYER, expectation)).toThrow(/asset/)
  })

  it('refuses a different USDC amount', () => {
    expect(() =>
      assertNairaPayment(envelope({ asset: usdc, amount: '29.8731235' }), PAYER, usdcExpectation)
    ).toThrow(/amount/)
  })
})

describe('buildNairaPayment', () => {
  it('builds a payment that passes its own assertion', async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ sequence: '12345' }), { status: 200 })
      )) as unknown as typeof fetch
    const built = await buildNairaPayment({ account: PAYER, expectation, fetchImpl })
    expect(() => assertNairaPayment(built.xdr, PAYER, expectation)).not.toThrow()
  })

  it('says so when the account is not funded', async () => {
    const fetchImpl = (() =>
      Promise.resolve(new Response('{}', { status: 404 }))) as unknown as typeof fetch
    await expect(buildNairaPayment({ account: PAYER, expectation, fetchImpl })).rejects.toThrow(
      /not funded/
    )
  })
})
