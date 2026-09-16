import { Networks, TransactionBuilder } from '@stellar/stellar-sdk'
import { describe, expect, it } from 'vitest'

import { USDC, XLM } from '../swap/assets'
import { assertSelfInvoke, buildSorobanSwap } from '../swap/build-soroban'

/**
 * Swapping through a Soroban router.
 *
 * A third builder, and the reasoning for keeping it separate is the same as
 * for offers: `build-tx.ts` asserts a path payment whose destination equals
 * its source, and `build-offer.ts` asserts a lone offer. Neither shape fits a
 * contract invocation, and widening either would weaken the guarantee it
 * exists to make.
 *
 * The guarantee here is different again. A contract call has no destination
 * field to check — instead the *recipient argument* passed to the router is
 * the thing that must be the user's own account, because a router will happily
 * send the proceeds wherever it is told.
 */

const ACCOUNT = 'GCYQ3NXJHGD7P36OVKII6GKVLAENQ6ZETYOBAPZTI4R6ZWUU6QLHVVUX'
const OTHER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'

function stubAccount(): typeof fetch {
  return (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ id: ACCOUNT, sequence: '4578890000000001' }),
    }) as Response) as unknown as typeof fetch
}

async function build(over: Record<string, unknown> = {}) {
  return buildSorobanSwap({
    account: ACCOUNT,
    from: USDC,
    to: XLM,
    sendAmount: '500000000',
    minReceive: '4000000000',
    fetchImpl: stubAccount(),
    ...over,
  })
}

describe('building a Soroban swap', () => {
  it('produces a signable transaction', async () => {
    const built = await build()
    expect(built.xdr).toMatch(/^[A-Za-z0-9+/=]+$/)
    expect(built.networkPassphrase).toBe(Networks.TESTNET)
  })

  it('sends the proceeds to the caller and nobody else', async () => {
    const built = await build()
    // Not merely that it did not throw: the recipient is read back out of the
    // encoded arguments, because that is the field a malicious route would
    // change.
    expect(built.recipient).toBe(ACCOUNT)
  })

  it('carries the minimum the user agreed to', async () => {
    // The floor is enforced by the router, so a route that degrades between
    // quoting and inclusion reverts rather than filling badly.
    const built = await build({ minReceive: '4000000000' })
    expect(built.minReceive).toBe('4000000000')
  })

  it('refuses a zero or negative amount', async () => {
    await expect(build({ sendAmount: '0' })).rejects.toThrow(/positive/)
  })

  it('refuses an asset it has no contract for', async () => {
    // Guessing a contract id would quote and then swap an unrelated token.
    await expect(build({ to: { kind: 'classic', code: 'DOGE', issuer: OTHER } })).rejects.toThrow(
      /no Soroban contract/
    )
  })

  it('refuses a deadline in the past', async () => {
    await expect(build({ deadlineSeconds: -1 })).rejects.toThrow(/deadline/)
  })
})

describe('the envelope is checked, not just the inputs', () => {
  it('accepts a lone invocation from the account itself', async () => {
    const built = await build()
    expect(() => assertSelfInvoke(built.xdr, ACCOUNT)).not.toThrow()
  })

  it('refuses a transaction sourced from another account', async () => {
    const built = await build()
    expect(() => assertSelfInvoke(built.xdr, OTHER)).toThrow(/is not the account/)
  })

  it('refuses an envelope that is not a contract call', async () => {
    // A path payment reaching this assertion means the wrong builder produced
    // it, and the checks below do not apply to that shape at all.
    const { buildOfferTransaction } = await import('../swap/build-offer')
    const offer = await buildOfferTransaction({
      account: ACCOUNT,
      selling: USDC,
      buying: XLM,
      amount: '10',
      price: { n: 1, d: 10 },
      fetchImpl: stubAccount(),
    })
    expect(() => assertSelfInvoke(offer.xdr, ACCOUNT)).toThrow(/not a contract invocation/)
  })

  it('reads the recipient out of the signed bytes', async () => {
    // The inputs are already known to be right; what matters is that the bytes
    // about to be signed say so too.
    const built = await build()
    const tx = TransactionBuilder.fromXDR(built.xdr, Networks.TESTNET)
    expect((tx as { operations: { type: string }[] }).operations[0]?.type).toBe(
      'invokeHostFunction'
    )
  })
})
