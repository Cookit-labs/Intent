import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Contract,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk'
import { describe, expect, it } from 'vitest'

import { USDC, XLM } from '../swap/assets'
import { sacFor } from '../swap/build-soroban'
import { AQUARIUS_ROUTER, SOROSWAP_ROUTER } from '../swap/contract-registry'
import { assertSelfSubmission, builderFor, type VenueKind } from '../swap/venue-routing'

/**
 * Choosing which builder signs a quote.
 *
 * Three builders now exist and they are not interchangeable. A path payment
 * asserts its destination equals its source; an offer asserts a lone offer
 * operation; a router call asserts the recipient argument. Sending a quote to
 * the wrong one either throws — the good case — or, worse, would build a
 * transaction whose guarantee does not match the shape being signed.
 *
 * So the venue on the quote decides, and it decides in one place rather than
 * at each call site. The build endpoint previously hardcoded Horizon, which
 * meant a Soroswap route could never be signed however good its price.
 */

const horizonQuote = {
  source: 'horizon' as const,
  kind: 'strict_send' as const,
  from: USDC,
  to: XLM,
  sendAmount: '500000000',
  destAmount: '1279739438',
  path: [],
  quotedAt: new Date().toISOString(),
}

const soroswapQuote = { ...horizonQuote, source: 'soroswap' as const, destAmount: '4737844000' }

describe('the venue on the quote picks the builder', () => {
  it('sends a Horizon route to the classic path-payment builder', () => {
    expect(builderFor(horizonQuote)).toBe<VenueKind>('classic')
  })

  it('sends a Soroswap route to the Soroban builder', () => {
    // The whole point of the phase: this route quotes 473 XLM against
    // Horizon's 128 for the same assets, and was unreachable.
    expect(builderFor(soroswapQuote)).toBe<VenueKind>('soroban')
  })

  it('sends an aggregator route to the aggregator builder, not the Soroban one', () => {
    // Same vendor, different contract and different argument layout. The
    // Soroban builder asserts a router call with the recipient fourth; the
    // aggregator puts it sixth, or builds a path payment instead. Sharing a
    // builder would mean sharing an assertion that fits neither.
    expect(builderFor({ ...horizonQuote, source: 'soroswap-aggregator' as const })).toBe<VenueKind>(
      'aggregator'
    )
  })

  it('refuses a venue it has no builder for', () => {
    // Guessing would sign the wrong transaction shape. A new source must add a
    // builder before it can be executed, not inherit one by accident.
    expect(() =>
      builderFor({ ...horizonQuote, source: 'uniswap' as unknown as 'horizon' })
    ).toThrow(/no builder/)
  })

  it('refuses a route that settles in a different asset than it names', () => {
    // A Soroban route through a non-canonical contract delivers a token that
    // merely shares a ticker. The builder must never be reached: the user
    // would receive something they did not choose.
    expect(() =>
      builderFor({
        ...soroswapQuote,
        deliversAsset: { kind: 'contract', code: 'USDC', contract: 'CB3TLW74' },
      })
    ).toThrow(/different asset/)
  })
})

/**
 * Re-checking a signed envelope before it is broadcast.
 *
 * The submit route used to try the path-payment assertion and fall back to
 * the Soroswap one, which checks the source and the operation type and
 * nothing else. An Aquarius envelope passed that fallback whoever its first
 * argument named — so the builder's "the router pays the signer" guarantee
 * held at build time and was dropped at the one moment it mattered, after
 * the bytes had been through a browser and a wallet extension.
 */

const ME = 'GAJ74DIC3252BKBTDCEYTDA2ZYDRDBDT3QMZU5IW2HOZQBYVXMRZZEFA'
const STRANGER = 'GAWWM4J4W3ZNGFQR4ULIQCNY44EHLBLVARBHM5CSXOGJYGZVDIBFGVC5'
const POOL = 'b2e02fcfca6c96f8ad5cbd84e7784a777b36d9c96a2459402c4f458462aab7f0'

function envelope(op: xdr.Operation, source = ME): string {
  return new TransactionBuilder(new Account(source, '1'), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(op)
    .setTimeout(180)
    .build()
    .toXDR()
}

/** An Aquarius `swap` with each argument substitutable. */
function aquariusCall(opts: { user?: string; fn?: string } = {}): string {
  const from = sacFor(XLM)
  const to = sacFor(USDC)
  const pair = from < to ? [from, to] : [to, from]
  return envelope(
    new Contract(AQUARIUS_ROUTER).call(
      opts.fn ?? 'swap',
      new Address(opts.user ?? ME).toScVal(),
      xdr.ScVal.scvVec(pair.map((c) => new Address(c).toScVal())),
      new Address(from).toScVal(),
      new Address(to).toScVal(),
      xdr.ScVal.scvBytes(Buffer.from(POOL, 'hex')),
      nativeToScVal(BigInt('100000000'), { type: 'u128' }),
      nativeToScVal(BigInt('1'), { type: 'u128' })
    )
  )
}

function soroswapCall(): string {
  return envelope(
    new Contract(SOROSWAP_ROUTER).call(
      'swap_exact_tokens_for_tokens',
      nativeToScVal(BigInt('100000000'), { type: 'i128' }),
      nativeToScVal(BigInt('1'), { type: 'i128' }),
      nativeToScVal([new Address(sacFor(XLM)).toScVal(), new Address(sacFor(USDC)).toScVal()]),
      new Address(ME).toScVal(),
      nativeToScVal(BigInt(1_900_000_000), { type: 'u64' })
    )
  )
}

function pathPayment(destination: string): string {
  return envelope(
    Operation.pathPaymentStrictSend({
      sendAsset: Asset.native(),
      sendAmount: '10',
      destination,
      destAsset: new Asset(USDC.code, USDC.issuer as string),
      destMin: '1',
      path: [],
    })
  )
}

describe('a signed envelope is re-asserted by the shape it actually has', () => {
  it('accepts an Aquarius swap that pays the signer', () => {
    expect(() => assertSelfSubmission(aquariusCall(), ME)).not.toThrow()
  })

  it('refuses an Aquarius swap that pays somebody else', () => {
    // The substitution the fallback never saw. Source and operation type are
    // exactly right; only the recipient argument is wrong, and that is the
    // argument the router pays.
    expect(() => assertSelfSubmission(aquariusCall({ user: STRANGER }), ME)).toThrow(
      /pays .* not the signing account/
    )
  })

  it('refuses a chained Aquarius call narrated as a swap', () => {
    // Same router, different argument layout. The registry labels it for a
    // plan that might one day build it; a single-swap submission never does.
    expect(() => assertSelfSubmission(aquariusCall({ fn: 'swap_chained' }), ME)).toThrow(
      /not an Aquarius swap/
    )
  })

  it('still accepts a Soroswap router call from the signer', () => {
    expect(() => assertSelfSubmission(soroswapCall(), ME)).not.toThrow()
  })

  it('still accepts a path payment back to the sender', () => {
    expect(() => assertSelfSubmission(pathPayment(ME), ME)).not.toThrow()
  })

  it('still refuses a path payment to a third party, in the classic words', () => {
    // The common failure keeps its message: a malformed path payment should
    // not be reported in a router call's vocabulary.
    expect(() => assertSelfSubmission(pathPayment(STRANGER), ME)).toThrow(
      /destination .* is not the sending account/
    )
  })

  it('refuses an envelope whose source is not the account, whatever its shape', () => {
    expect(() =>
      assertSelfSubmission(envelope(new Contract(AQUARIUS_ROUTER).call('swap'), STRANGER), ME)
    ).toThrow(/transaction source/)
  })
})
