import { describe, expect, it } from 'vitest'

import { NameNotFound } from '../names/errors'
import { resolveSorobanDomain } from '../names/soroban-domains'

/**
 * The registry, read live on mainnet.
 *
 * Live because the two things most likely to be wrong — the node hash and the
 * record key's shape — both fail as "not found", which the unit test's fake
 * registry cannot distinguish from a name that does not exist. Only the real
 * registry can say that `sorobandomains.xlm` resolves.
 */

const SKIP = process.env['SKIP_LIVE'] === '1'

describe.skipIf(SKIP)('the live SorobanDomains registry', () => {
  it('resolves the registry’s own name', async () => {
    const resolved = await resolveSorobanDomain('sorobandomains.xlm')
    expect(resolved.address).toBe('GBGFEZ5QZFLQJTTCQUYWTJBGZN6QEVFF57F3LVD2MF7MRYWUNKFBJWIV')
    expect(resolved.expiresAt).toBeGreaterThan(0)
  }, 60_000)

  it('reports an unregistered name as not found', async () => {
    // Fifteen letters at most, so the registry is actually asked rather than
    // the validator refusing the name first.
    await expect(resolveSorobanDomain('zzqxnotexistzz.xlm')).rejects.toThrow(NameNotFound)
  }, 60_000)
})
