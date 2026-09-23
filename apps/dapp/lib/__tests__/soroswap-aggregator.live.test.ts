import { describe, expect, it } from 'vitest'

import { resolveAggregatorProtocols } from '../swap/aggregator-protocols'
import { USDC, XLM } from '../swap/assets'
import { SOROSWAP_AGGREGATOR, SOROSWAP_ROUTER } from '../swap/contract-registry'
import { createSoroswapApi, SOROSWAP_API_URL } from '../swap/soroswap-api'
import { createSoroswapAggregatorQuoter } from '../swap/sources/soroswap-aggregator-quoter'

/**
 * The aggregator, live on testnet, without a key.
 *
 * What can be verified against the real thing without an API key is exactly
 * what this file verifies: that the ids the API publishes are the ids the
 * registry allows, that the contract's adapter list reads as expected, and
 * that the ledger still lacks the Phoenix adapter the list names. The quote
 * and build paths need a key and are covered by the unit tests against
 * recorded shapes; a deployment that registers one should run those live
 * before trusting the first signature.
 *
 * Skipped cleanly when the API is unreachable, and with `SKIP_LIVE=1`.
 */

const SKIP = process.env['SKIP_LIVE'] === '1'

async function reachable(): Promise<boolean> {
  if (SKIP) return false
  try {
    const res = await fetch(`${SOROSWAP_API_URL}/api/testnet/router`, {
      signal: AbortSignal.timeout(8_000),
    })
    return res.ok
  } catch {
    return false
  }
}

const live = (await reachable()) ? describe : describe.skip

live('the ids the API publishes are the ids the registry allows', () => {
  const api = createSoroswapApi({ apiKey: '' })

  it('names the router the registry lists', async () => {
    // No auth on this endpoint. If the two ever disagree, the registry is
    // stale and every router-platform build would be refused — by design,
    // and loudly, rather than signed against a contract nobody reviewed.
    expect(await api.contractAddress('router')).toBe(SOROSWAP_ROUTER)
  }, 20_000)

  it('names the aggregator the registry lists', async () => {
    expect(await api.contractAddress('aggregator')).toBe(SOROSWAP_AGGREGATOR)
  }, 20_000)
})

live('the adapters, read from the contract and the ledger', () => {
  it('offers Soroswap, Aquarius and the classic DEX, and never Phoenix', async () => {
    const got = await resolveAggregatorProtocols({ aggregatorId: SOROSWAP_AGGREGATOR })

    expect(got).toBeDefined()
    if (got === undefined) return
    expect(got.protocols).toEqual(['soroswap', 'aqua', 'sdex'])
    expect(got.protocols).not.toContain('phoenix')
  }, 60_000)

  it('finds the Phoenix adapter named but not deployed', async () => {
    // Measured on 2026-09-23: three unpaused adapters, and the ledger had
    // no instance at the second one's address. If this starts failing,
    // Phoenix has been redeployed on testnet — which changes nothing above
    // until a swap through it has been verified by hand.
    const got = await resolveAggregatorProtocols({ aggregatorId: SOROSWAP_AGGREGATOR })
    if (got === undefined) throw new Error('adapters could not be read')

    expect(got.adapters).toHaveLength(3)
    const phoenix = got.adapters.find((a) => a.protocol === 'phoenix')
    expect(phoenix?.deployed).toBe(false)
    expect(got.adapters.find((a) => a.protocol === 'soroswap')?.router).toBe(SOROSWAP_ROUTER)
  }, 60_000)
})

live('the key gate, against the real API', () => {
  it('reports a bad key as unavailable rather than as a market answer', async () => {
    // The one failure mode reachable without registering: the API's 403.
    // It must not read as "no route" for XLM/USDC, which is the most liquid
    // pair on testnet.
    const quoter = createSoroswapAggregatorQuoter({ apiKey: 'sk_not_a_real_key' })
    const out = await quoter.quote({
      kind: 'strict_send',
      from: XLM,
      to: USDC,
      sendAmount: '100000000',
    })

    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.failure.reason).toBe('unavailable')
  }, 60_000)
})
