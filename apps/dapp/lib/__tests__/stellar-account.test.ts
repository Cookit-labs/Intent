import { afterEach, describe, expect, it, vi } from 'vitest'

import { UNFUNDED_ACCOUNT, fetchStellarBalances, fundWithFriendbot } from '../stellar-account'

const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'

function mockFetch(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    })
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchStellarBalances', () => {
  it('treats a 404 as an unfunded account rather than an error', async () => {
    // Horizon returns 404 for a valid keypair that has never been funded.
    // Verified against live testnet: this is the normal pre-funding state.
    mockFetch(404, {})
    await expect(fetchStellarBalances('GABC')).resolves.toEqual(UNFUNDED_ACCOUNT)
  })

  it('reads the native XLM balance', async () => {
    mockFetch(200, {
      balances: [{ balance: '10000.0000000', asset_type: 'native' }],
    })
    const result = await fetchStellarBalances('GABC')
    expect(result.xlm).toBe('10000.0000000')
    expect(result.exists).toBe(true)
    expect(result.hasUsdcTrustline).toBe(false)
  })

  it('detects a USDC trustline only for the correct issuer', async () => {
    mockFetch(200, {
      balances: [
        { balance: '1.0', asset_type: 'native' },
        {
          balance: '250.5',
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: USDC_ISSUER,
        },
      ],
    })
    const result = await fetchStellarBalances('GABC')
    expect(result.hasUsdcTrustline).toBe(true)
    expect(result.usdc).toBe('250.5')
  })

  it('ignores a USDC asset from an impostor issuer', async () => {
    // Anyone can issue an asset called USDC on Stellar, so matching on the
    // code alone would show a fake balance as real.
    mockFetch(200, {
      balances: [
        { balance: '1.0', asset_type: 'native' },
        {
          balance: '999999',
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: 'GFAKEISSUERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        },
      ],
    })
    const result = await fetchStellarBalances('GABC')
    expect(result.hasUsdcTrustline).toBe(false)
    expect(result.usdc).toBeUndefined()
  })

  it('throws on a genuine Horizon failure', async () => {
    mockFetch(500, {})
    await expect(fetchStellarBalances('GABC')).rejects.toThrow('Horizon 500')
  })
})

describe('fundWithFriendbot', () => {
  it('throws when friendbot rejects the request', async () => {
    mockFetch(400, {})
    await expect(fundWithFriendbot('GABC')).rejects.toThrow('Friendbot failed')
  })
})
