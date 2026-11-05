import { fromBase64 } from '@mysten/sui/utils'
import { describe, expect, it } from 'vitest'

import { suiClient } from '../chains/sui/client'
import { SSUI_TYPE } from '../chains/sui/policies'
import { springsuiVenue } from '../chains/sui/springsui'

/**
 * A real unsigned transaction against mainnet, read-only. Nothing here signs or sends: it is only
 * built and dry-run, for a public address whose key nobody here has. When that address empties
 * this fails on balance, so swap it for another funded one.
 */

const SKIP = process.env['SKIP_LIVE'] === '1'
const SSUI_HOLDER = '0xe4b732379e532578abd81ca8bbc40f213eed36941ab280205654059c8bfab56d'

describe.skipIf(SKIP)('SpringSui unstake against mainnet', () => {
  it('builds an unstake that passes its check, pays out, and dry-runs clean', async () => {
    const prepared = await springsuiVenue.prepare(
      { kind: 'unstake', amount: '2', tokenIn: 'sSUI' },
      SSUI_HOLDER
    )
    if (prepared.signing.family !== 'sui') throw new Error('wrong family')
    expect(() => springsuiVenue.assertSafe(prepared.signing, SSUI_HOLDER)).not.toThrow()
    const result = await suiClient().core.simulateTransaction({
      transaction: fromBase64(prepared.signing.transaction),
      include: { effects: true },
    })
    expect(result.Transaction?.effects?.status.success).toBe(true)
    expect(prepared.receive?.symbol).toBe('SUI')
    expect(Number(prepared.receive?.amount)).toBeGreaterThan(2)
  }, 60_000)

  it('sSUI still has the decimals in its token entry', async () => {
    const { coinMetadata } = await suiClient().core.getCoinMetadata({ coinType: SSUI_TYPE })
    expect(coinMetadata?.symbol).toBe('sSUI')
    expect(coinMetadata?.decimals).toBe(9)
  }, 30_000)
})
