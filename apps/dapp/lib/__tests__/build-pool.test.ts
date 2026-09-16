import { Networks, TransactionBuilder } from '@stellar/stellar-sdk'
import { describe, expect, it } from 'vitest'

import { USDC, XLM } from '../swap/assets'
import { assertSelfPoolOp, buildPoolDeposit, buildPoolWithdraw } from '../swap/build-pool'

/**
 * Depositing into and withdrawing from a Stellar liquidity pool.
 *
 * A fourth transaction shape, and the same reasoning as the other three: each
 * builder asserts one operation type, because widening any of them to admit
 * another would weaken the guarantee it exists to make.
 *
 * The guarantee here is inherent rather than asserted, and worth stating for
 * that reason. A pool deposit has no destination and no recipient argument —
 * the shares go to the account that signs, and there is nowhere in the
 * operation to say otherwise. What must still be checked is the envelope: a
 * deposit sharing a transaction with a payment would move funds anywhere.
 *
 * The real risk in a deposit is not theft but *price*. Depositing into a pool
 * whose ratio has moved since you looked means buying the worse side at a bad
 * rate, so the operation takes explicit price bounds and the network rejects
 * anything outside them.
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

async function deposit(over: Record<string, unknown> = {}) {
  return buildPoolDeposit({
    account: ACCOUNT,
    assetA: XLM,
    assetB: USDC,
    maxAmountA: '100',
    maxAmountB: '10',
    // The pool's current ratio, with tolerance either side.
    minPrice: { n: 9, d: 100 },
    maxPrice: { n: 11, d: 100 },
    fetchImpl: stubAccount(),
    ...over,
  })
}

describe('depositing into a pool', () => {
  it('produces a signable transaction', async () => {
    const built = await deposit()
    expect(built.xdr).toMatch(/^[A-Za-z0-9+/=]+$/)
    expect(built.networkPassphrase).toBe(Networks.TESTNET)
  })

  it('commits to a price range the network enforces', async () => {
    // Without bounds a deposit into a pool that moved is a bad trade dressed
    // as a deposit. The network rejects rather than filling.
    const built = await deposit()
    expect(built.minPrice).toEqual({ n: 9, d: 100 })
    expect(built.maxPrice).toEqual({ n: 11, d: 100 })
  })

  it('orders the assets the way Stellar requires', async () => {
    // A pool is identified by its assets in a canonical order, so passing them
    // reversed addresses a different pool — or none. Handled rather than
    // pushed onto the caller.
    const forward = await deposit()
    const reversed = await deposit({
      assetA: USDC,
      assetB: XLM,
      maxAmountA: '10',
      maxAmountB: '100',
    })
    expect(forward.poolId).toBe(reversed.poolId)
  })

  it('refuses a zero deposit', async () => {
    await expect(deposit({ maxAmountA: '0' })).rejects.toThrow(/positive/)
  })

  it('refuses an inverted price range', async () => {
    // A minimum above the maximum accepts nothing, so the transaction could
    // only ever fail — better to say so before a wallet prompt.
    await expect(
      deposit({ minPrice: { n: 11, d: 100 }, maxPrice: { n: 9, d: 100 } })
    ).rejects.toThrow(/price range/)
  })

  it('refuses an unverified asset', async () => {
    await expect(
      deposit({ assetB: { kind: 'classic', code: 'SCAMCOIN', issuer: OTHER } })
    ).rejects.toThrow(/not a verified asset/)
  })
})

describe('withdrawing from a pool', () => {
  it('produces a signable transaction', async () => {
    const built = await buildPoolWithdraw({
      account: ACCOUNT,
      assetA: XLM,
      assetB: USDC,
      shares: '100',
      minAmountA: '90',
      minAmountB: '9',
      fetchImpl: stubAccount(),
    })
    expect(built.xdr).toMatch(/^[A-Za-z0-9+/=]+$/)
  })

  it('commits to a floor on both assets', async () => {
    // The same protection as a swap's destMin: shares are worth whatever the
    // pool holds now, so a withdrawal into a drained pool must revert rather
    // than return dust.
    const built = await buildPoolWithdraw({
      account: ACCOUNT,
      assetA: XLM,
      assetB: USDC,
      shares: '100',
      minAmountA: '90',
      minAmountB: '9',
      fetchImpl: stubAccount(),
    })
    expect(built.minAmountA).toBe('90')
    expect(built.minAmountB).toBe('9')
  })

  it('refuses withdrawing nothing', async () => {
    await expect(
      buildPoolWithdraw({
        account: ACCOUNT,
        assetA: XLM,
        assetB: USDC,
        shares: '0',
        minAmountA: '0',
        minAmountB: '0',
        fetchImpl: stubAccount(),
      })
    ).rejects.toThrow(/positive/)
  })
})

describe('the envelope is checked, not just the inputs', () => {
  it('accepts a lone pool operation from the account itself', async () => {
    const built = await deposit()
    expect(() => assertSelfPoolOp(built.xdr, ACCOUNT)).not.toThrow()
  })

  it('refuses a transaction sourced from another account', async () => {
    const built = await deposit()
    expect(() => assertSelfPoolOp(built.xdr, OTHER)).toThrow(/is not the account/)
  })

  it('refuses an envelope that is not a pool operation', async () => {
    const { buildOfferTransaction } = await import('../swap/build-offer')
    const offer = await buildOfferTransaction({
      account: ACCOUNT,
      selling: USDC,
      buying: XLM,
      amount: '10',
      price: { n: 1, d: 10 },
      fetchImpl: stubAccount(),
    })
    expect(() => assertSelfPoolOp(offer.xdr, ACCOUNT)).toThrow(/not a liquidity pool operation/)
  })

  it('builds exactly one operation', async () => {
    const built = await deposit()
    const tx = TransactionBuilder.fromXDR(built.xdr, Networks.TESTNET)
    expect((tx as { operations: unknown[] }).operations).toHaveLength(1)
  })
})
