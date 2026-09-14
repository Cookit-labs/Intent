import { describe, expect, it } from 'vitest'

import { buildBlendSupply, prepareBlendSupply } from '../lend/blend-client'
import { readReserveList } from '../lend/reserves'

/**
 * A supply simulated against the real pool.
 *
 * This is the test that proves the call shape is right. The unit tests check
 * that the arguments say what they should; only the pool can confirm it can
 * *read* them — and the way a struct with mis-ordered fields fails is an opaque
 * simulation error, not anything that names field order.
 */

const SKIP = process.env['SKIP_LIVE'] === '1'

/** A funded testnet account. Simulation never spends from it. */
const FUNDED = 'GCYQ3NXJHGD7P36OVKII6GKVLAENQ6ZETYOBAPZTI4R6ZWUU6QLHVVUX'

describe.skipIf(SKIP)('supplying to the live Blend pool', () => {
  it('builds a supply the pool accepts', async () => {
    const [xlm] = await readReserveList()
    expect(xlm).toBeDefined()

    const built = await buildBlendSupply({
      account: FUNDED,
      asset: xlm as string,
      amount: '10000000',
    })

    const prepared = await prepareBlendSupply(built.xdr)
    if (!prepared.ok) throw new Error(`the pool refused the supply: ${prepared.reason}`)

    // Proves the struct was readable: a mis-ordered `Request` fails here.
    expect(prepared.xdr.length).toBeGreaterThan(0)
    expect(prepared.bTokens).toBeDefined()
    expect(BigInt(prepared.bTokens as string)).toBeGreaterThan(BigInt(0))
  }, 45_000)

  it('mints fewer bTokens than the amount supplied', async () => {
    // bTokens accrue value against the asset, so one is worth more than one
    // stroop. Getting this backwards would mean the rate is inverted.
    const [xlm] = await readReserveList()
    const built = await buildBlendSupply({
      account: FUNDED,
      asset: xlm as string,
      amount: '10000000',
    })

    const prepared = await prepareBlendSupply(built.xdr)
    if (!prepared.ok) throw new Error(prepared.reason)
    expect(BigInt(prepared.bTokens as string)).toBeLessThan(BigInt('10000000'))
  }, 45_000)

  it('refuses an asset the pool has no reserve for', async () => {
    // Blend's USDC is a different issuer from Circle's, so Circle's SAC names
    // an asset this pool has never heard of. A simulation is the check.
    const circleUsdc = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
    const built = await buildBlendSupply({
      account: FUNDED,
      asset: circleUsdc,
      amount: '10000000',
    })

    const prepared = await prepareBlendSupply(built.xdr)
    expect(prepared.ok).toBe(false)
  }, 45_000)

  it('catches an unaffordable supply before asking for a signature', async () => {
    // The reason simulating is worth doing beyond estimating: this fails here
    // rather than on-chain, after the user has paid a fee.
    const [xlm] = await readReserveList()
    const built = await buildBlendSupply({
      account: FUNDED,
      asset: xlm as string,
      // Far beyond any testnet balance.
      amount: '100000000000000000',
    })

    const prepared = await prepareBlendSupply(built.xdr)
    expect(prepared.ok).toBe(false)
  }, 45_000)
})
