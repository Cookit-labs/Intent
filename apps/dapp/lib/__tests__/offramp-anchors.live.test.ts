import { describe, expect, it } from 'vitest'

import { ALL_ANCHORS, ANCHORS } from '../offramp/anchors'
import { readAnchorToml } from '../offramp/toml'
import { readWithdrawInfo } from '../offramp/sep24'

/**
 * Both anchors, against the real network.
 *
 * The unit tests pin behaviour against a TOML captured once. Only this
 * catches the anchor changing underneath it — a rotated key, a moved
 * endpoint, or a testnet deployment that has been taken down. Each is a
 * refusal in production, and it is better found here.
 */
const SKIP = process.env['SKIP_LIVE'] === '1'

describe.skipIf(SKIP)('the live anchors', () => {
  for (const id of ALL_ANCHORS) {
    it(`${id} serves a TOML matching its pinned key`, async () => {
      const toml = await readAnchorToml(ANCHORS[id])
      expect(toml.signingKey).toBe(ANCHORS[id].signingKey)
      expect(toml.transferServerSep24).toMatch(/^https:\/\//)
      expect(toml.webAuthEndpoint).toMatch(/^https:\/\//)
    }, 20_000)
  }

  for (const id of ALL_ANCHORS) {
    it(`${id} withdraws USDC`, async () => {
      const toml = await readAnchorToml(ANCHORS[id])
      const limits = await readWithdrawInfo(toml, 'USDC')
      expect(limits?.enabled).toBe(true)
      expect(limits?.minAmount).toBe(1)
    }, 20_000)
  }
})
