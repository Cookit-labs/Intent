import { describe, expect, it } from 'vitest'

import {
  assertSelfBorrow,
  assertSelfRepay,
  buildBlendBorrow,
  buildBlendRepay,
  prepareBlendWithdraw,
} from '../lend/blend-client'
import { explainPoolError, poolErrorCode } from '../lend/pool-errors'
import { BLEND_XLM } from '../lend/reserves'

/**
 * Opening and closing a liability, against the live pool.
 *
 * The account under test holds a plain supply and no collateral, so every
 * borrow here is *expected to be refused* — and that is worth testing rather
 * than working around. A borrow that succeeded without collateral would mean
 * the health check was not running, which is the single most dangerous thing
 * that could be wrong with this feature.
 *
 * Nothing signs. The refusals come from simulation.
 */

const SKIP = process.env['SKIP_LIVE'] === '1'
const ME = 'GAJ74DIC3252BKBTDCEYTDA2ZYDRDBDT3QMZU5IW2HOZQBYVXMRZZEFA'
const STRANGER = 'GAWWM4J4W3ZNGFQR4ULIQCNY44EHLBLVARBHM5CSXOGJYGZVDIBFGVC5'
const WBTC = 'CAP5AMC2OHNVREO66DFIN6DHJMPOBAJ2KCDDIMFBR7WWJH5RZBFM3UEI'

describe.skipIf(SKIP)('borrowing without collateral', () => {
  it('is refused by the pool, not by this app', async () => {
    // The health check living in the contract is what makes it trustworthy.
    // If this ever passes, the pool stopped checking and every safety claim
    // this feature makes is void.
    const built = await buildBlendBorrow({ account: ME, asset: WBTC, amount: '10000' })
    const prepared = await prepareBlendWithdraw(built.xdr)

    expect(prepared.ok).toBe(false)
  }, 90_000)

  it('is refused for a reason the user can act on', async () => {
    const built = await buildBlendBorrow({ account: ME, asset: WBTC, amount: '10000' })
    const prepared = await prepareBlendWithdraw(built.xdr)

    if (prepared.ok) throw new Error('expected a refusal')

    // Either "not enough collateral" (#1205) or "the reserve is full" (#1207)
    // is a legitimate answer here, and both are translated. What must never
    // reach a user is the raw code.
    const code = poolErrorCode(prepared.reason)
    expect([1205, 1207]).toContain(code)
    expect(explainPoolError(prepared.reason)).not.toMatch(/Error\(Contract/)
  }, 90_000)
})

describe.skipIf(SKIP)('a borrow names its own size', () => {
  it('refuses to borrow without an amount', async () => {
    // "Borrow everything" is not a thing the pool can clamp to: the limit
    // depends on collateral, prices and spare liquidity, none of which are a
    // balance. A sentinel here would ask for i128::MAX of wBTC.
    await expect(buildBlendBorrow({ account: ME, asset: WBTC })).rejects.toThrow(/needs an amount/)
  }, 30_000)

  it('refuses a zero amount', async () => {
    await expect(buildBlendBorrow({ account: ME, asset: WBTC, amount: '0' })).rejects.toThrow(
      /positive amount/
    )
  }, 60_000)
})

describe.skipIf(SKIP)('who receives the borrowed asset', () => {
  it('is the signer, and the envelope says so', async () => {
    const built = await buildBlendBorrow({ account: ME, asset: WBTC, amount: '10000' })

    expect(built.recipient).toBe(ME)
    expect(() => assertSelfBorrow(built.xdr, ME)).not.toThrow()
  }, 60_000)

  it('cannot be anybody else', async () => {
    // The worst substitution in this file. A redirected borrow sends the asset
    // to a stranger while the debt and the liquidation risk stay with the
    // signer — they would owe for money they never saw.
    const built = await buildBlendBorrow({ account: ME, asset: WBTC, amount: '10000' })

    expect(() => assertSelfBorrow(built.xdr, STRANGER)).toThrow(/refusing to sign/)
  }, 60_000)
})

describe.skipIf(SKIP)('repaying', () => {
  it('is refused when nothing is owed', async () => {
    // InvalidDTokenBurnAmount. Distinct from a malformed call, and the
    // difference decides whether someone goes looking for a bug.
    const built = await buildBlendRepay({ account: ME, asset: WBTC, amount: '10000' })
    const prepared = await prepareBlendWithdraw(built.xdr)

    expect(prepared.ok).toBe(false)
    if (!prepared.ok) {
      expect(poolErrorCode(prepared.reason)).toBe(1219)
      expect(explainPoolError(prepared.reason)).toMatch(/nothing borrowed/i)
    }
  }, 90_000)

  it('repays everything when no amount is named', async () => {
    // The sentinel matters more for a debt than for a supply: interest makes a
    // figure read a moment ago too *small*, so an exact repayment leaves a
    // remainder that keeps growing and keeps the position liquidatable.
    const built = await buildBlendRepay({ account: ME, asset: WBTC })

    expect(built.everything).toBe(true)
    expect(built.amount).toBe('170141183460469231731687303715884105727')
  }, 60_000)

  it('pays down the signing account and no other', async () => {
    const built = await buildBlendRepay({ account: ME, asset: BLEND_XLM })

    expect(() => assertSelfRepay(built.xdr, ME)).not.toThrow()
    expect(() => assertSelfRepay(built.xdr, STRANGER)).toThrow(/refusing to sign/)
  }, 60_000)
})
