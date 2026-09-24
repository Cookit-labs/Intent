import { Asset, BASE_FEE, Memo, Operation, TransactionBuilder } from '@stellar/stellar-sdk'
import { stellarNetwork } from '@intent/config'
import { describe, expect, it } from 'vitest'

import { assertSelfOffer, buildOfferTransaction, OFFER_MEMO } from '../swap/build-offer'
import { USDC, XLM } from '../swap/assets'

/**
 * Placing and cancelling a resting order.
 *
 * `build-tx.ts` guards its path payments by asserting the destination is the
 * sender, which is what makes "an agent cannot move funds to a third party" a
 * property of the code. An offer needs the same guarantee reached a different
 * way: an offer operation has no destination field at all, so it cannot name a
 * recipient — the proceeds can only return to the account that placed it.
 *
 * That property is free, but it is only true while the transaction contains
 * nothing else. A second operation smuggled alongside could pay anyone, so the
 * assertion is about the whole envelope rather than the offer.
 */

const ACCOUNT = 'GCYQ3NXJHGD7P36OVKII6GKVLAENQ6ZETYOBAPZTI4R6ZWUU6QLHVVUX'
const OTHER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'

/** A funded account response, so the builder can read a sequence number. */
function stubAccount(): typeof fetch {
  return (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({
        id: ACCOUNT,
        account_id: ACCOUNT,
        sequence: '4578890000000001',
        balances: [{ asset_type: 'native', balance: '1000.0000000' }],
      }),
    }) as Response) as unknown as typeof fetch
}

async function build(over: Record<string, unknown> = {}) {
  return buildOfferTransaction({
    account: ACCOUNT,
    selling: USDC,
    buying: XLM,
    amount: '50',
    price: { n: 9, d: 100 },
    fetchImpl: stubAccount(),
    ...over,
  })
}

describe('building an offer', () => {
  it('produces a signable transaction', async () => {
    const built = await build()
    expect(built.xdr).toMatch(/^[A-Za-z0-9+/=]+$/)
    expect(built.networkPassphrase).toBe(stellarNetwork.networkPassphrase)
  })

  it('places a new offer rather than editing one', async () => {
    // Offer id zero is how Stellar is told this is a new order.
    const built = await build()
    expect(built.offerId).toBe('0')
  })

  it('stamps the transaction so history can find it', async () => {
    const built = await build()
    const tx = TransactionBuilder.fromXDR(built.xdr, stellarNetwork.networkPassphrase)
    // The memo is stored as bytes; decode them rather than stringifying the
    // buffer, which yields a comma-separated list of byte values.
    const memo = (tx as { memo: Memo }).memo.value as Buffer
    expect(Buffer.from(memo).toString('utf8')).toBe(OFFER_MEMO)
  })

  it('carries the price without losing precision', async () => {
    // The SDK stores the rational on the ledger and hands back its decimal
    // form when decoding. What matters is that the round trip is exact at the
    // ledger's full seven places, which a float price would not be.
    const built = await build({ price: { n: 1234567, d: 10_000_000 } })
    expect(built.price).toEqual({ n: 1234567, d: 10_000_000 })

    const tx = TransactionBuilder.fromXDR(built.xdr, stellarNetwork.networkPassphrase)
    const op = (tx as { operations: { price?: string }[] }).operations[0]
    expect(Number(op?.price)).toBe(1234567 / 10_000_000)
  })

  it('cancels by setting the amount to zero', async () => {
    // Stellar has no delete operation: an offer at zero size is removed.
    const built = await build({ amount: '0', offerId: '8224' })
    expect(built.offerId).toBe('8224')

    const tx = TransactionBuilder.fromXDR(built.xdr, stellarNetwork.networkPassphrase)
    const op = (tx as { operations: { amount?: string }[] }).operations[0]
    expect(op?.amount).toBe('0.0000000')
  })

  it('refuses an amount finer than the ledger keeps', async () => {
    await expect(build({ amount: '1.123456789' })).rejects.toThrow(/decimal places/)
  })
})

describe('the envelope is checked, not just the inputs', () => {
  function envelope(ops: ReturnType<typeof Operation.manageSellOffer>[], source = ACCOUNT): string {
    const account = {
      accountId: () => source,
      sequenceNumber: () => '1',
      incrementSequenceNumber: () => undefined,
    }
    const builder = new TransactionBuilder(account as never, {
      fee: BASE_FEE,
      networkPassphrase: stellarNetwork.networkPassphrase,
    })
    for (const op of ops) builder.addOperation(op)
    return builder.setTimeout(180).build().toXDR()
  }

  const offerOp = (): ReturnType<typeof Operation.manageSellOffer> =>
    Operation.manageSellOffer({
      selling: Asset.native(),
      buying: new Asset('USDC', OTHER),
      amount: '10',
      price: { n: 1, d: 10 },
      offerId: '0',
    })

  it('accepts a lone offer from the account itself', () => {
    expect(() => assertSelfOffer(envelope([offerOp()]), ACCOUNT)).not.toThrow()
  })

  it('refuses a second operation', () => {
    // The offer is harmless; whatever rides alongside it might not be. A
    // payment bundled here could send funds anywhere.
    expect(() => assertSelfOffer(envelope([offerOp(), offerOp()]), ACCOUNT)).toThrow(
      /exactly one operation/
    )
  })

  it('refuses an operation that is not an offer', () => {
    const payment = Operation.payment({
      destination: OTHER,
      asset: Asset.native(),
      amount: '10',
    })
    expect(() => assertSelfOffer(envelope([payment as never]), ACCOUNT)).toThrow(/is not an offer/)
  })

  it('refuses a transaction sourced from another account', () => {
    expect(() => assertSelfOffer(envelope([offerOp()], OTHER), ACCOUNT)).toThrow(
      /is not the account/
    )
  })
})
