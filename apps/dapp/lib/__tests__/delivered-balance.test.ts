import { describe, expect, it } from 'vitest'

import { balanceOf, deliveredByBalanceChange } from '../swap/delivered-balance'
import type { StellarBalances } from '../stellar-account'

/**
 * Measuring what a swap delivered from the account rather than the receipt.
 *
 * Reading the transaction result works only for a classic path payment. A
 * Soroban router reports its output as a contract return value, which lives in
 * `result_meta_xdr` — and Horizon's transaction endpoint does not return that
 * field. So a sequence whose agent picked Soroswap settled its swap and then
 * stopped, unable to size the step that followed, even though the swap had
 * succeeded.
 *
 * The account is the same whichever venue executed, which is what makes this
 * the venue-independent answer.
 */

function balances(over: Partial<StellarBalances> = {}): StellarBalances {
  return {
    xlm: '0',
    usdc: undefined,
    hasUsdcTrustline: false,
    exists: true,
    trustlines: {},
    ...over,
  }
}

function stub(result: StellarBalances): typeof import('../stellar-account').fetchStellarBalances {
  return (async () => result) as never
}

const NO_WAIT = { waitMs: 0 }

describe('reading a balance', () => {
  it('reads native XLM in base units', async () => {
    const got = await balanceOf('G...', 'XLM', {
      fetchBalances: stub(balances({ xlm: '189.4812911' })),
    })
    expect(got).toBe(BigInt('1894812911'))
  })

  it('reads an issued asset by its code', async () => {
    const got = await balanceOf('G...', 'USDC', {
      fetchBalances: stub(
        balances({ trustlines: { USDC: { balance: '20.0000000', issuer: 'G1' } } })
      ),
    })
    expect(got).toBe(BigInt('200000000'))
  })

  it('reports nothing for an unfunded account', async () => {
    const got = await balanceOf('G...', 'XLM', {
      fetchBalances: stub(balances({ exists: false })),
    })
    expect(got).toBeUndefined()
  })

  it('reports nothing for an asset the account cannot hold', async () => {
    // Absent rather than zero: no trustline is a different state from an empty
    // balance, and a caller must not supply against either.
    const got = await balanceOf('G...', 'CETES', { fetchBalances: stub(balances()) })
    expect(got).toBeUndefined()
  })
})

describe('what a settled swap delivered', () => {
  it('is the growth in the balance', async () => {
    const delivered = await deliveredByBalanceChange('G...', 'XLM', BigInt('1000000000'), {
      fetchBalances: stub(balances({ xlm: '289.4812911' })),
      ...NO_WAIT,
    })
    expect(delivered).toBe('1894812911')
  })

  it('reports nothing when the balance did not grow', async () => {
    // A swap that reverted leaves the balance where it was. Reporting a figure
    // here would supply against a trade that never happened.
    const delivered = await deliveredByBalanceChange('G...', 'XLM', BigInt('1000000000'), {
      fetchBalances: stub(balances({ xlm: '100.0000000' })),
      ...NO_WAIT,
    })
    expect(delivered).toBeUndefined()
  })

  it('reports nothing when the balance shrank', async () => {
    // Fees can exceed a tiny delivery on XLM. Negative is not a supply amount.
    const delivered = await deliveredByBalanceChange('G...', 'XLM', BigInt('1000000000'), {
      fetchBalances: stub(balances({ xlm: '99.0000000' })),
      ...NO_WAIT,
    })
    expect(delivered).toBeUndefined()
  })

  it('is net of fees, which is what the account can actually supply', async () => {
    // The network charges XLM from the same balance the swap credits, so the
    // delta is slightly under what the venue quoted. That is the correct
    // figure: supplying the quoted amount would fail for insufficient balance.
    const quoted = BigInt('1894812911')
    const delivered = await deliveredByBalanceChange('G...', 'XLM', BigInt('1000000000'), {
      // 100 XLM before, plus the swap, minus a 0.00001 XLM fee.
      fetchBalances: stub(balances({ xlm: '289.4812811' })),
      ...NO_WAIT,
    })
    expect(BigInt(delivered as string)).toBeLessThan(quoted)
  })

  it('reports nothing for an account that vanished', async () => {
    const delivered = await deliveredByBalanceChange('G...', 'XLM', BigInt('0'), {
      fetchBalances: stub(balances({ exists: false })),
      ...NO_WAIT,
    })
    expect(delivered).toBeUndefined()
  })
})
