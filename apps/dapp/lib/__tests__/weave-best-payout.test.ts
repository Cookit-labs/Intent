import { describe, expect, it, vi } from 'vitest'

import { bestNairaOffer, nairaOffers, PAYS_NAIRA } from '../weave/best-payout'

const sources = (linq: number | undefined, weave: number | undefined) => ({
  linqRate: vi.fn(async () => linq),
  weaveNaira: vi.fn(async () => weave),
})

describe('nairaOffers', () => {
  it('asks only the providers that can pay naira from this chain', async () => {
    const onStellar = sources(1368.39, 900)
    expect(await nairaOffers('stellar', '1', onStellar)).toEqual([
      { provider: 'linq', naira: 1368.39, exact: true },
    ])
    expect(onStellar.weaveNaira).not.toHaveBeenCalled()

    const onSui = sources(1368.39, 916.44)
    expect(await nairaOffers('sui', '0.689418', onSui)).toEqual([
      { provider: 'weave', naira: 916.44, exact: false },
    ])
    expect(onSui.linqRate).not.toHaveBeenCalled()
  })

  it('gives no offer for a provider that cannot be read, rather than a guess', async () => {
    const down = {
      linqRate: vi.fn(async () => Promise.reject(new Error('down'))),
      weaveNaira: vi.fn(),
    }
    expect(await nairaOffers('stellar', '1', down)).toEqual([])
    expect(await nairaOffers('sui', '1', sources(undefined, Number.NaN))).toEqual([])
  })

  it('gives nothing for an amount that is not one', async () => {
    expect(await nairaOffers('stellar', '0', sources(1368, 1))).toEqual([])
    expect(await nairaOffers('stellar', 'abc', sources(1368, 1))).toEqual([])
  })

  it('pays naira from Linq on Stellar only, and from Weave nowhere on Stellar or NEAR', () => {
    expect(PAYS_NAIRA.linq).toEqual(['stellar'])
    expect(PAYS_NAIRA.weave).not.toContain('stellar')
    expect(PAYS_NAIRA.weave).not.toContain('near')
  })
})

describe('bestNairaOffer', () => {
  it('picks the most naira', () => {
    expect(
      bestNairaOffer([
        { provider: 'weave', naira: 916.44, exact: false },
        { provider: 'linq', naira: 943.4, exact: true },
      ])?.provider
    ).toBe('linq')
    expect(
      bestNairaOffer([
        { provider: 'linq', naira: 900, exact: true },
        { provider: 'weave', naira: 950, exact: false },
      ])?.provider
    ).toBe('weave')
  })

  it('prefers the exact amount when the two are within half a percent', () => {
    expect(
      bestNairaOffer([
        { provider: 'weave', naira: 1003, exact: false },
        { provider: 'linq', naira: 1000, exact: true },
      ])?.provider
    ).toBe('linq')
  })

  it('has nothing to pick from nothing', () => {
    expect(bestNairaOffer([])).toBeUndefined()
  })
})
