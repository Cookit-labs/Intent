import { describe, expect, it } from 'vitest'

import { resolveFederation } from '../names/federation'

/**
 * A real federation server, read live.
 *
 * LOBSTR publishes one for its own name. Live because the toml parse and the
 * query shape are what a stubbed server cannot vouch for.
 */

const SKIP = process.env['SKIP_LIVE'] === '1'

describe.skipIf(SKIP)('live federation', () => {
  it('resolves lobstr*lobstr.co', async () => {
    const resolved = await resolveFederation('lobstr*lobstr.co')
    expect(resolved.address).toBe('GARSCEEOGZ4MGOTZLQHOKJGOPK455N6SHD7SAEFFHIJDAV445GFWJGHD')
  }, 60_000)
})
