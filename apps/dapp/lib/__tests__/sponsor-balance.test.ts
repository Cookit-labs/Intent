import { describe, expect, it } from 'vitest'

import { readSponsorBalance } from '../sponsor/balance'

/**
 * Reading what the sponsor holds.
 *
 * Shared by the health endpoint and the low-balance alert, so both agree on
 * what "funded" means: the account exists on the ledger and this is its
 * native balance, as Horizon states it. An account Horizon has never seen
 * holds nothing, which is a fact; a Horizon that cannot answer is not, and
 * must not be read as an empty account by anything deciding whether to page
 * someone.
 */

const ACCOUNT = 'G'.padEnd(56, 'A')

function horizon(status: number, body: unknown, calls: string[] = []): typeof fetch {
  return ((url: string) => {
    calls.push(url)
    return Promise.resolve(new Response(JSON.stringify(body), { status }))
  }) as unknown as typeof fetch
}

describe('readSponsorBalance', () => {
  it('reads the native balance of a funded account', async () => {
    const calls: string[] = []
    const out = await readSponsorBalance(ACCOUNT, {
      horizonUrl: 'https://horizon.test',
      fetchImpl: horizon(
        200,
        {
          balances: [
            { asset_type: 'credit_alphanum4', asset_code: 'USDC', balance: '10.0000000' },
            { asset_type: 'native', balance: '41.5000000' },
          ],
        },
        calls
      ),
    })

    expect(out).toEqual({ funded: true, balanceXlm: '41.5000000' })
    expect(calls).toEqual([`https://horizon.test/accounts/${ACCOUNT}`])
  })

  it('treats an account Horizon has never seen as unfunded', async () => {
    const out = await readSponsorBalance(ACCOUNT, {
      horizonUrl: 'https://horizon.test',
      fetchImpl: horizon(404, { status: 404 }),
    })

    expect(out).toEqual({ funded: false, balanceXlm: '0' })
  })

  it('refuses a balance it cannot read as a number', async () => {
    // A balance that is not a number must not reach a comparison: NaN fails
    // every guard, and the alert that follows would be a false one.
    await expect(
      readSponsorBalance(ACCOUNT, {
        horizonUrl: 'https://horizon.test',
        fetchImpl: horizon(200, { balances: [{ asset_type: 'native', balance: 'lots' }] }),
      })
    ).rejects.toThrow(/unreadable balance/)
  })

  it('does not guess when Horizon fails', async () => {
    await expect(
      readSponsorBalance(ACCOUNT, {
        horizonUrl: 'https://horizon.test',
        fetchImpl: horizon(503, {}),
      })
    ).rejects.toThrow(/Horizon 503/)
  })
})
