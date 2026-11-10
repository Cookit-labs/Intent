import { describe, expect, it } from 'vitest'

import { linearVenue } from '../chains/near/stake'
import type { NearFunctionCall, NearTransaction } from '../chains/types'

/**
 * LiNEAR on NEAR mainnet: what a stake would build for a real account, read from the deployed
 * contract. Nothing is signed or sent.
 */

const SKIP = process.env['SKIP_LIVE'] === '1'
const ACCOUNT = 'intent-demo.near'

describe.skipIf(SKIP)('LiNEAR on mainnet', () => {
  it('builds a stake that passes its own check, at the price the contract reports', async () => {
    const prepared = await linearVenue.prepare(
      { kind: 'stake', amount: '1', tokenIn: 'NEAR' },
      ACCOUNT
    )
    const tx = (prepared.signing as { transactions: NearTransaction[] })
      .transactions[0] as NearTransaction
    expect(tx.receiverId).toBe('linear-protocol.near')
    expect(tx.actions.map((a) => (a as NearFunctionCall).params.methodName).at(-1)).toBe(
      'deposit_and_stake'
    )
    // LiNEAR only gains value against NEAR, so a stake always gets back less than it paid.
    const got = Number(prepared.receive?.amount)
    expect(got).toBeGreaterThan(0.3)
    expect(got).toBeLessThan(1)
    expect(() => linearVenue.assertSafe(prepared.signing, ACCOUNT)).not.toThrow()
  }, 30_000)

  it('reads an account with nothing staked as no positions', async () => {
    expect(await linearVenue.positions?.(ACCOUNT)).toEqual([])
  }, 30_000)
})
