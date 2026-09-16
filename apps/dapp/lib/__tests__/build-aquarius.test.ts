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
import { describe, expect, it } from 'vitest'

import { resolveAsset } from '../swap/assets'
import { assertSelfAquariusSwap, buildAquariusSwap } from '../swap/build-aquarius'
import { sacFor } from '../swap/build-soroban'
import { AQUARIUS_ROUTER } from '../swap/sources/aquarius-quoter'

/**
 * Building an Aquarius swap, without a network.
 *
 * What is pinned is the assertion, because that is what stands between a
 * built envelope and a signature. The router pays `token_out` to whatever
 * address is passed first, so the assertion has to prove that argument is
 * the signer — read back out of the bytes, not trusted from the inputs.
 */

const ME = 'GAJ74DIC3252BKBTDCEYTDA2ZYDRDBDT3QMZU5IW2HOZQBYVXMRZZEFA'
const STRANGER = 'GAWWM4J4W3ZNGFQR4ULIQCNY44EHLBLVARBHM5CSXOGJYGZVDIBFGVC5'
const POOL = 'b2e02fcfca6c96f8ad5cbd84e7784a777b36d9c96a2459402c4f458462aab7f0'

const XLM = resolveAsset('XLM')
const USDC = resolveAsset('USDC')
if (XLM === undefined || USDC === undefined) throw new Error('registry missing XLM or USDC')

/** Horizon answering with a sequence number and nothing else. */
const sequenceOnly: typeof fetch = (async () =>
  new Response(JSON.stringify({ sequence: '12345' }), { status: 200 })) as unknown as typeof fetch

/**
 * A `swap` envelope built by hand, so each argument can be substituted
 * independently of the builder that would have refused to.
 */
function handBuilt(opts: {
  source?: string
  user?: string
  fn?: string
  poolIndex?: Buffer | undefined
  argCount?: number
}): string {
  const source = opts.source ?? ME
  const user = opts.user ?? ME
  const from = sacFor(USDC as NonNullable<typeof USDC>)
  const to = sacFor(XLM as NonNullable<typeof XLM>)
  const pair = from < to ? [from, to] : [to, from]

  const args: xdr.ScVal[] = [
    new Address(user).toScVal(),
    xdr.ScVal.scvVec(pair.map((c) => new Address(c).toScVal())),
    new Address(from).toScVal(),
    new Address(to).toScVal(),
    opts.poolIndex === undefined
      ? xdr.ScVal.scvBytes(Buffer.from(POOL, 'hex'))
      : xdr.ScVal.scvBytes(opts.poolIndex),
    nativeToScVal(BigInt('200000000'), { type: 'u128' }),
    nativeToScVal(BigInt('1'), { type: 'u128' }),
  ].slice(0, opts.argCount ?? 7)

  return new TransactionBuilder(new Account(source, '1'), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(new Contract(AQUARIUS_ROUTER).call(opts.fn ?? 'swap', ...args))
    .setTimeout(180)
    .build()
    .toXDR()
}

describe('building a swap', () => {
  it('produces an envelope that passes its own assertion', async () => {
    const built = await buildAquariusSwap({
      account: ME,
      from: USDC,
      to: XLM,
      sendAmount: '200000000',
      minReceive: '400000000',
      poolIndex: POOL,
      fetchImpl: sequenceOnly,
    })

    expect(built.recipient).toBe(ME)
    expect(built.poolIndex).toBe(POOL)
    expect(() => assertSelfAquariusSwap(built.xdr, ME)).not.toThrow()
  })

  it('refuses to build without a pool index', async () => {
    // "Whichever pool is best" at signing time is not the pool the agent
    // chose. The builder does not get to decide.
    await expect(
      buildAquariusSwap({
        account: ME,
        from: USDC,
        to: XLM,
        sendAmount: '200000000',
        minReceive: '1',
        poolIndex: '',
        fetchImpl: sequenceOnly,
      })
    ).rejects.toThrow(/pool index/)
  })

  it('refuses a malformed pool index', async () => {
    await expect(
      buildAquariusSwap({
        account: ME,
        from: USDC,
        to: XLM,
        sendAmount: '200000000',
        minReceive: '1',
        poolIndex: 'not-hex',
        fetchImpl: sequenceOnly,
      })
    ).rejects.toThrow(/pool index/)
  })

  it('refuses a zero amount', async () => {
    await expect(
      buildAquariusSwap({
        account: ME,
        from: USDC,
        to: XLM,
        sendAmount: '0',
        minReceive: '1',
        poolIndex: POOL,
        fetchImpl: sequenceOnly,
      })
    ).rejects.toThrow(/positive amount/)
  })
})

describe('the swap must pay the account that funds it', () => {
  it('accepts an envelope whose user is the signer', () => {
    expect(() => assertSelfAquariusSwap(handBuilt({}), ME)).not.toThrow()
  })

  it('refuses one that pays somebody else', () => {
    // The substitution that matters. Everything else about this envelope is
    // exactly right, and it would hand the proceeds to a stranger.
    expect(() => assertSelfAquariusSwap(handBuilt({ user: STRANGER }), ME)).toThrow(
      /pays .* not the signing account/
    )
  })

  it('refuses one whose source is somebody else', () => {
    expect(() => assertSelfAquariusSwap(handBuilt({ source: STRANGER }), ME)).toThrow(
      /transaction source/
    )
  })

  it('refuses a function that is not swap', () => {
    // `swap_chained` exists on the same router with a different argument
    // layout. Narrating it as a swap would be signing one thing while reading
    // another.
    expect(() => assertSelfAquariusSwap(handBuilt({ fn: 'swap_chained' }), ME)).toThrow(
      /not an Aquarius swap/
    )
  })

  it('refuses the wrong number of arguments', () => {
    expect(() => assertSelfAquariusSwap(handBuilt({ argCount: 6 }), ME)).toThrow(/seven arguments/)
  })

  it('refuses a pool index that is not 32 bytes', () => {
    expect(() =>
      assertSelfAquariusSwap(handBuilt({ poolIndex: Buffer.from('short') }), ME)
    ).toThrow(/32-byte pool index/)
  })
})
