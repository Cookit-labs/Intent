import { describe, expect, it } from 'vitest'

import { SOROSWAP_AGGREGATOR, labelForCall, lookupContract } from '../swap/contract-registry'

/**
 * The aggregator in the allowlist.
 *
 * A plan step or a built swap that calls a contract absent from the registry
 * is refused, so adding the aggregator here is what lets its transactions be
 * signed at all. The entry names its two swap entrypoints and nothing else:
 * the contract also exposes `update_adapters`, `set_pause` and `upgrade`, and
 * a review screen that labelled any of those "Swap" would be lying.
 *
 * Function names are from the contract's source (`swap_exact_tokens_for_tokens`
 * and `swap_tokens_for_exact_tokens` on the `SoroswapAggregatorTrait`), and the
 * id is the one `GET /api/testnet/aggregator` returned on 2026-09-23.
 */

describe('the Soroswap aggregator is a contract this app calls', () => {
  it('is listed under its live testnet id', () => {
    expect(SOROSWAP_AGGREGATOR).toBe('CC74XDT7UVLUZCELKBIYXFYIX6A6LGPWURJVUXGRPQO745RWX7WEURMA')
    expect(lookupContract(SOROSWAP_AGGREGATOR)?.label).toMatch(/aggregator/i)
  })

  it('labels its swap entrypoints as swaps, and says which venue', () => {
    const exactIn = labelForCall(SOROSWAP_AGGREGATOR, 'swap_exact_tokens_for_tokens')
    expect(exactIn).toEqual({ ok: true, label: 'Swap via Soroswap aggregator' })

    const exactOut = labelForCall(SOROSWAP_AGGREGATOR, 'swap_tokens_for_exact_tokens')
    expect(exactOut.ok).toBe(true)
  })

  it('refuses its admin entrypoints', () => {
    for (const fn of ['update_adapters', 'set_pause', 'upgrade', 'set_admin', 'remove_adapter']) {
      const got = labelForCall(SOROSWAP_AGGREGATOR, fn)
      expect(got.ok, `${fn} must not be labelled as anything`).toBe(false)
    }
  })
})
