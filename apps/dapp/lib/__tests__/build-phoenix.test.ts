import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resolveAsset } from '../swap/assets'
import { assertSelfPhoenixSwap, buildPhoenixSwap } from '../swap/build-phoenix'
import { sacFor } from '../swap/build-soroban'

/**
 * Building a Phoenix swap, without a network.
 *
 * What is pinned is the assertion, because that is what stands between a
 * built envelope and a signature. The pool pays `sender` whatever the ask
 * asset's amount is, so the assertion has to prove that argument is the
 * signer — read back out of the bytes, not trusted from the inputs — and,
 * unlike Aquarius's single router, also prove the call *target itself* is
 * the one pool this quote priced, since Phoenix has no router argument to
 * pin instead.
 */

const ME = 'GAJ74DIC3252BKBTDCEYTDA2ZYDRDBDT3QMZU5IW2HOZQBYVXMRZZEFA'
const STRANGER = 'GAWWM4J4W3ZNGFQR4ULIQCNY44EHLBLVARBHM5CSXOGJYGZVDIBFGVC5'
const POOL = 'CBHCRSVX3ZZ7EGTSYMKPEFGZNWRVCSESQR3UABET4MIW52N4EVU6BIZX'
const OTHER_POOL = 'CBCZGGNOEUZG4CAAE7TGTQQHETZMKUT4OIPFHHPKEUX46U4KXBBZ3GLH'

const XLM = resolveAsset('XLM')
const USDC = resolveAsset('USDC')
if (XLM === undefined || USDC === undefined) throw new Error('registry missing XLM or USDC')

// Phoenix is mainnet-only (see contract-registry.ts's phoenixFactory), and
// assertVenueOn checks that before anything else build-phoenix.ts does.
// Every test below is about what happens after that check, so the network
// is stubbed to the one network Phoenix is actually on.
beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORK', 'mainnet')
})
afterEach(() => {
  vi.unstubAllEnvs()
})

/** Horizon answering with a sequence number and nothing else. */
const sequenceOnly: typeof fetch = (async () =>
  new Response(JSON.stringify({ sequence: '12345' }), { status: 200 })) as unknown as typeof fetch

/**
 * A `swap` envelope built by hand, so each argument — and the call target —
 * can be substituted independently of the builder that would have refused.
 */
function handBuilt(opts: {
  pool?: string
  source?: string
  sender?: string
  fn?: string
  argCount?: number
}): string {
  const source = opts.source ?? ME
  const sender = opts.sender ?? ME
  const pool = opts.pool ?? POOL
  const offerAsset = sacFor(XLM as NonNullable<typeof XLM>)

  const args: xdr.ScVal[] = [
    new Address(sender).toScVal(),
    new Address(offerAsset).toScVal(),
    nativeToScVal(BigInt('10000000'), { type: 'i128' }),
    nativeToScVal(BigInt('1'), { type: 'i128' }),
    xdr.ScVal.scvVoid(),
    xdr.ScVal.scvVoid(),
    xdr.ScVal.scvVoid(),
  ].slice(0, opts.argCount ?? 7)

  return new TransactionBuilder(new Account(source, '1'), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(new Contract(pool).call(opts.fn ?? 'swap', ...args))
    .setTimeout(180)
    .build()
    .toXDR()
}

describe('building a swap', () => {
  it('refuses on testnet, where Phoenix has no deployment', async () => {
    vi.unstubAllEnvs()
    vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORK', 'testnet')
    await expect(
      buildPhoenixSwap({
        account: ME,
        from: XLM,
        to: USDC,
        sendAmount: '10000000',
        minReceive: '1',
        poolAddress: POOL,
        fetchImpl: sequenceOnly,
      })
    ).rejects.toThrow(/not on testnet/)
  })

  it('produces an envelope that passes its own assertion', async () => {
    const built = await buildPhoenixSwap({
      account: ME,
      from: XLM,
      to: USDC,
      sendAmount: '10000000',
      minReceive: '1',
      poolAddress: POOL,
      fetchImpl: sequenceOnly,
    })

    expect(built.recipient).toBe(ME)
    expect(built.poolAddress).toBe(POOL)
    expect(() => assertSelfPhoenixSwap(built.xdr, ME, POOL)).not.toThrow()
  })

  it('refuses to build without a pool address', async () => {
    // "Whichever pool is best" at signing time is not the pool the agent
    // chose. The builder does not get to decide.
    await expect(
      buildPhoenixSwap({
        account: ME,
        from: XLM,
        to: USDC,
        sendAmount: '10000000',
        minReceive: '1',
        poolAddress: '',
        fetchImpl: sequenceOnly,
      })
    ).rejects.toThrow(/pool address/)
  })

  it('refuses a zero amount', async () => {
    await expect(
      buildPhoenixSwap({
        account: ME,
        from: XLM,
        to: USDC,
        sendAmount: '0',
        minReceive: '1',
        poolAddress: POOL,
        fetchImpl: sequenceOnly,
      })
    ).rejects.toThrow(/positive amount/)
  })

  it('refuses a negative minimum received', async () => {
    await expect(
      buildPhoenixSwap({
        account: ME,
        from: XLM,
        to: USDC,
        sendAmount: '10000000',
        minReceive: '-1',
        poolAddress: POOL,
        fetchImpl: sequenceOnly,
      })
    ).rejects.toThrow(/minimum received/)
  })
})

describe('the swap must hit the quoted pool and pay the account that funds it', () => {
  it('accepts an envelope against the quoted pool, signed by the sender', () => {
    expect(() => assertSelfPhoenixSwap(handBuilt({}), ME, POOL)).not.toThrow()
  })

  it('refuses a call to a different pool than the one quoted', () => {
    // The one check Aquarius's own assertion has no equivalent of: Phoenix
    // has no router argument naming the pool, so the call target itself is
    // the only place a substitution could hide.
    expect(() => assertSelfPhoenixSwap(handBuilt({ pool: OTHER_POOL }), ME, POOL)).toThrow(
      /not the.*pool.*this quote priced/
    )
  })

  it('refuses one that pays somebody else', () => {
    expect(() => assertSelfPhoenixSwap(handBuilt({ sender: STRANGER }), ME, POOL)).toThrow(
      /pays .* not the signing account/
    )
  })

  it('refuses one whose source is somebody else', () => {
    expect(() => assertSelfPhoenixSwap(handBuilt({ source: STRANGER }), ME, POOL)).toThrow(
      /transaction source/
    )
  })

  it('refuses a function that is not swap', () => {
    // `withdraw_liquidity` and `provide_liquidity` share the pool contract
    // and are not swaps.
    expect(() => assertSelfPhoenixSwap(handBuilt({ fn: 'withdraw_liquidity' }), ME, POOL)).toThrow(
      /not a Phoenix swap/
    )
  })

  it('refuses the wrong number of arguments', () => {
    expect(() => assertSelfPhoenixSwap(handBuilt({ argCount: 6 }), ME, POOL)).toThrow(
      /seven arguments/
    )
  })

  it('checks only shape, not pool identity, when no pool address is given', () => {
    // The re-check `venue-routing.ts` runs after signing has no quote to
    // compare against — see assertSelfPhoenixSwap's own doc comment. A call
    // to any pool, with the right shape, passes; only the function and
    // recipient are checked.
    expect(() => assertSelfPhoenixSwap(handBuilt({ pool: OTHER_POOL }), ME)).not.toThrow()
    expect(() => assertSelfPhoenixSwap(handBuilt({ sender: STRANGER }), ME)).toThrow(
      /pays .* not the signing account/
    )
  })
})
