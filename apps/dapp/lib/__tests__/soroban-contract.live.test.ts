import { Asset, Networks } from '@stellar/stellar-sdk'
import { describe, expect, it } from 'vitest'

import { USDC, XLM } from '../swap/assets'
import { buildSorobanSwap, prepareSorobanSwap, sacFor } from '../swap/build-soroban'

/**
 * Tests that talk to the real Soroswap router on testnet.
 *
 * Everything else in this suite stubs the network, which is right for logic
 * and useless for the question that actually matters here: does the contract
 * accept what we build? A method name, an argument order, or a type can all be
 * wrong in a way no amount of local testing reveals — the transaction encodes
 * perfectly and the router rejects it.
 *
 * That gap is not hypothetical. The quoter spent this whole project pointing at
 * a contract that calls itself "USDCoin" and shares the USDC ticker, and every
 * stubbed test passed the entire time.
 *
 * Marked `.live` and skippable: they need network, they are slow, and a
 * testnet reset can wipe the pools out from under them. `SKIP_LIVE=1` turns
 * them off.
 */

const live = process.env['SKIP_LIVE'] === '1' ? describe.skip : describe

/** A funded testnet account. Only ever read, never signed with. */
const FUNDED = 'GCYQ3NXJHGD7P36OVKII6GKVLAENQ6ZETYOBAPZTI4R6ZWUU6QLHVVUX'
const STRANGER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'

live('the contract ids we derive are the ones Stellar means', () => {
  it('derives XLM to the canonical native SAC', () => {
    // Not a fixture: the SDK derives this from the asset, and Soroswap's own
    // token list agrees. If these ever disagree, one of them is quoting a
    // different asset than it claims.
    expect(sacFor(XLM)).toBe(Asset.native().contractId(Networks.TESTNET))
  })

  it('derives USDC to Circle’s SAC, not a lookalike', () => {
    const derived = sacFor(USDC)
    expect(derived).toBe(new Asset('USDC', USDC.issuer as string).contractId(Networks.TESTNET))
    // The token the quoter used to point at. Named explicitly so a future edit
    // reintroducing it fails loudly rather than quietly repricing every swap.
    expect(derived).not.toBe('CB3TLW74NBIOT3BUWOZ3TUM6RFDF6A4GVIRUQRQZABG5KPOUL4JJOV2F')
  })

  it('derives a different contract for every asset', () => {
    expect(sacFor(XLM)).not.toBe(sacFor(USDC))
  })
})

live('the router accepts what we build', () => {
  it('simulates a real swap without error', async () => {
    // The whole point of this file: the method name, the five arguments, and
    // their types are all correct only if the contract says so.
    const built = await buildSorobanSwap({
      account: FUNDED,
      from: USDC,
      to: XLM,
      sendAmount: '10000000',
      minReceive: '1',
    })

    const prepared = await prepareSorobanSwap(built.xdr)
    expect(prepared.ok, prepared.ok ? '' : `router rejected: ${prepared.reason}`).toBe(true)
  }, 30_000)

  it('returns a transaction the network has costed', async () => {
    // Soroban will not accept an unprepared transaction: simulation attaches
    // the resource footprint. A prepared envelope differs from the built one,
    // and signing the wrong one fails at submission with an opaque error.
    const built = await buildSorobanSwap({
      account: FUNDED,
      from: USDC,
      to: XLM,
      sendAmount: '10000000',
      minReceive: '1',
    })
    const prepared = await prepareSorobanSwap(built.xdr)

    if (!prepared.ok) throw new Error(prepared.reason)
    expect(prepared.xdr).not.toBe(built.xdr)
  }, 30_000)
})

live('the price floor is the router’s promise, not ours', () => {
  it('refuses a swap that cannot clear the minimum', async () => {
    // `minReceive` is enforced on-chain rather than by this app, which is what
    // makes it a real protection: a route that degrades between quoting and
    // inclusion reverts instead of filling badly.
    //
    // One USDC will not buy a thousand XLM. If this ever passes, the floor is
    // not being enforced and every swap is unprotected.
    const built = await buildSorobanSwap({
      account: FUNDED,
      from: USDC,
      to: XLM,
      sendAmount: '10000000',
      minReceive: '10000000000',
    })

    const prepared = await prepareSorobanSwap(built.xdr)
    expect(prepared.ok).toBe(false)
  }, 30_000)
})

live('an unverified asset never reaches the router', () => {
  it('refuses before building anything', async () => {
    // The guard is local and deliberately so: asking the router about a
    // squatted token would be a network round trip to learn something the
    // allowlist already knows.
    await expect(
      buildSorobanSwap({
        account: FUNDED,
        from: USDC,
        to: { kind: 'classic', code: 'USDCoin', issuer: STRANGER },
        sendAmount: '10000000',
        minReceive: '1',
      })
    ).rejects.toThrow(/not a verified asset/)
  })
})
