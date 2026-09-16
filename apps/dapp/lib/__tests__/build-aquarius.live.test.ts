import { describe, expect, it } from 'vitest'

import { resolveAsset } from '../swap/assets'
import { buildAquariusSwap } from '../swap/build-aquarius'
import { prepareSorobanSwap } from '../swap/build-soroban'
import { createAquariusQuoter } from '../swap/sources/aquarius-quoter'
import { AQUARIUS_ROUTER, lookupContract } from '../swap/contract-registry'

/**
 * An Aquarius swap, simulated against the live router.
 *
 * The only check that catches a `u128` encoded as `i128`, an unsorted token
 * vector, or a pool index the router does not recognise — each of which
 * fails in simulation with an error that names none of those things. Nothing
 * here signs; the router's simulated acceptance is the evidence.
 */

const SKIP = process.env['SKIP_LIVE'] === '1'
const ME = 'GAJ74DIC3252BKBTDCEYTDA2ZYDRDBDT3QMZU5IW2HOZQBYVXMRZZEFA'

const XLM = resolveAsset('XLM')
const USDC = resolveAsset('USDC')
if (XLM === undefined || USDC === undefined) throw new Error('registry missing XLM or USDC')

describe.skipIf(SKIP)('an Aquarius swap the router accepts', () => {
  it('quotes, builds against the quoted pool, and simulates clean', async () => {
    const quote = await createAquariusQuoter().quote({
      kind: 'strict_send',
      from: USDC,
      to: XLM,
      sendAmount: '200000000',
    })
    if (!quote.ok) throw new Error(`no quote: ${quote.failure.reason}`)
    if (quote.quote.poolIndex === undefined) throw new Error('quote carried no pool index')

    // A floor well under the quote, so the simulation tests the call shape
    // and not the price having moved between the two calls.
    const minReceive = (BigInt(quote.quote.destAmount) / BigInt(2)).toString()

    const built = await buildAquariusSwap({
      account: ME,
      from: USDC,
      to: XLM,
      sendAmount: '200000000',
      minReceive,
      poolIndex: quote.quote.poolIndex,
    })

    const prepared = await prepareSorobanSwap(built.xdr)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) throw new Error(prepared.reason)
  }, 120_000)

  it('is refused by the router when the floor is above what the pool pays', async () => {
    // The floor is enforced on-chain, and simulation is where it shows.
    // Asking for more XLM than the pool would deliver must fail here, before
    // a wallet prompt, rather than on-chain after one.
    const quote = await createAquariusQuoter().quote({
      kind: 'strict_send',
      from: USDC,
      to: XLM,
      sendAmount: '200000000',
    })
    if (!quote.ok || quote.quote.poolIndex === undefined) throw new Error('no quote')

    const tooHigh = (BigInt(quote.quote.destAmount) * BigInt(10)).toString()
    const built = await buildAquariusSwap({
      account: ME,
      from: USDC,
      to: XLM,
      sendAmount: '200000000',
      minReceive: tooHigh,
      poolIndex: quote.quote.poolIndex,
    })

    const prepared = await prepareSorobanSwap(built.xdr)
    expect(prepared.ok).toBe(false)
  }, 120_000)
})

describe.skipIf(SKIP)('the router is one this app will sign for', () => {
  it('is in the contract registry with its swap function labelled', () => {
    const entry = lookupContract(AQUARIUS_ROUTER)
    expect(entry?.functions['swap']).toBe('Swap via Aquarius')
  })
})
