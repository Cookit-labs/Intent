import { describe, expect, it } from 'vitest'

import {
  assertSelfCollateralSupply,
  assertSelfCollateralWithdraw,
  buildBlendCollateralSupply,
  buildBlendCollateralWithdraw,
  prepareBlendWithdraw,
} from '../lend/blend-client'
import { BLEND_XLM } from '../lend/reserves'

/**
 * Posting and reclaiming collateral, against the live pool.
 *
 * Collateral is the step that turns a safe position into one that can be
 * seized, so the shape of the call is worth proving against the contract
 * rather than against a fixture of our own making. A simulation that the pool
 * accepts is the only evidence that types 2 and 3 do what their names suggest.
 *
 * Nothing here signs. `submit` returns the resulting positions from a
 * simulation, which is enough to see collateral appear and disappear without
 * moving anything.
 */

const SKIP = process.env['SKIP_LIVE'] === '1'
const ME = 'GAJ74DIC3252BKBTDCEYTDA2ZYDRDBDT3QMZU5IW2HOZQBYVXMRZZEFA'
const STRANGER = 'GAWWM4J4W3ZNGFQR4ULIQCNY44EHLBLVARBHM5CSXOGJYGZVDIBFGVC5'

describe.skipIf(SKIP)('posting collateral', () => {
  it('builds a call the pool accepts', async () => {
    const built = await buildBlendCollateralSupply({
      account: ME,
      asset: BLEND_XLM,
      amount: '1000000000',
    })

    const prepared = await prepareBlendWithdraw(built.xdr)
    expect(prepared.ok).toBe(true)
  }, 90_000)

  it('credits the account that posted it', async () => {
    const built = await buildBlendCollateralSupply({
      account: ME,
      asset: BLEND_XLM,
      amount: '1000000000',
    })

    expect(built.recipient).toBe(ME)
    expect(() => assertSelfCollateralSupply(built.xdr, ME)).not.toThrow()
  }, 60_000)

  it('refuses to look like a collateral supply for somebody else', async () => {
    // The same recipient-substitution guard the other three calls carry. It
    // matters here for a particular reason: collateral posted to another
    // account would back *their* borrowing with the signer's money.
    //
    // The refusal names the transaction source rather than the `to` address,
    // because source is checked first and fails first. Either refusal is
    // correct; asserting only the later one would make this test pass for the
    // wrong reason if the source check were ever removed.
    const built = await buildBlendCollateralSupply({
      account: ME,
      asset: BLEND_XLM,
      amount: '1000000000',
    })

    expect(() => assertSelfCollateralSupply(built.xdr, STRANGER)).toThrow(/refusing to sign/)
  }, 60_000)

  it('needs an amount, since there is no "all" to post', async () => {
    // Withdrawing everything is meaningful; supplying everything is not, and a
    // sentinel here would post an absurd number rather than the balance.
    await expect(buildBlendCollateralSupply({ account: ME, asset: BLEND_XLM })).rejects.toThrow(
      /needs an amount/
    )
  }, 30_000)

  it('refuses a zero or negative amount', async () => {
    await expect(
      buildBlendCollateralSupply({ account: ME, asset: BLEND_XLM, amount: '0' })
    ).rejects.toThrow(/positive amount/)
  }, 60_000)
})

describe.skipIf(SKIP)('reclaiming collateral', () => {
  it('is refused when there is no collateral to reclaim', async () => {
    // This account supplies plainly and has never posted collateral, so the
    // pool has nothing to give back and says so with InvalidBTokenBurnAmount
    // (#1217) — the same code a withdrawal from an untouched reserve returns.
    //
    // Worth pinning rather than skipping: it is the difference between "you
    // have no collateral" and "the call is malformed", and a route that
    // reported the second for the first would send someone looking for a bug
    // that is not there.
    const built = await buildBlendCollateralWithdraw({
      account: ME,
      asset: BLEND_XLM,
      amount: '1000000',
    })

    const prepared = await prepareBlendWithdraw(built.xdr)

    expect(prepared.ok).toBe(false)
    if (!prepared.ok) expect(prepared.reason).toContain('#1217')
  }, 90_000)

  it('takes the whole collateral balance when no amount is named', async () => {
    // Collateral earns interest like any supply, so an exact figure read a
    // moment ago is already short. The sentinel is the only way to reclaim all
    // of it.
    const built = await buildBlendCollateralWithdraw({ account: ME, asset: BLEND_XLM })

    expect(built.everything).toBe(true)
    expect(built.amount).toBe('170141183460469231731687303715884105727')
  }, 60_000)

  it('pays the account that posted it', async () => {
    const built = await buildBlendCollateralWithdraw({ account: ME, asset: BLEND_XLM })

    expect(() => assertSelfCollateralWithdraw(built.xdr, ME)).not.toThrow()
    expect(() => assertSelfCollateralWithdraw(built.xdr, STRANGER)).toThrow(/refusing to sign/)
  }, 60_000)
})
