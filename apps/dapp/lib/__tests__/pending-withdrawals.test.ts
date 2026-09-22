import { describe, expect, it } from 'vitest'

import type { ChatTurn } from '../chat-history'
import { pendingWithdrawals } from '../offramp/pending-withdrawals'

/**
 * Which withdrawals are still the anchor's to finish.
 *
 * A withdrawal whose payment is on-chain is not done: the anchor still has
 * to move the money, which can take days and can end in a refund. Those are
 * open positions, and this picks them out of history.
 */
function turn(over: Partial<ChatTurn>): ChatTurn {
  return {
    id: 't1',
    chain: 'stellar',
    text: 'Withdraw 5 USDC to my bank',
    createdAt: '2026-09-18T00:00:00Z',
    proposals: {},
    winner: null,
    ...over,
  }
}

describe('pendingWithdrawals', () => {
  it('lists a withdrawal the anchor has not completed', () => {
    const rows = pendingWithdrawals([
      turn({
        bundle: [
          {
            label: 'Withdraw 5 USDC',
            hash: 'abc',
            anchor: { id: 'testanchor', transactionId: 'tx-1', lastStatus: 'pending_external' },
          },
        ],
      }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.anchor.transactionId).toBe('tx-1')
  })

  it('lists one whose status was never read after the payment', () => {
    const rows = pendingWithdrawals([
      turn({
        bundle: [{ label: 'w', hash: 'abc', anchor: { id: 'testanchor', transactionId: 'tx-1' } }],
      }),
    ])
    expect(rows).toHaveLength(1)
  })

  it('omits a completed withdrawal', () => {
    const rows = pendingWithdrawals([
      turn({
        bundle: [
          {
            label: 'w',
            hash: 'abc',
            anchor: { id: 'testanchor', transactionId: 'tx-1', lastStatus: 'completed' },
          },
        ],
      }),
    ])
    expect(rows).toHaveLength(0)
  })

  it('omits a refunded or errored withdrawal', () => {
    for (const lastStatus of ['refunded', 'error', 'expired']) {
      const rows = pendingWithdrawals([
        turn({
          bundle: [
            {
              label: 'w',
              hash: 'abc',
              anchor: { id: 'testanchor', transactionId: 'tx-1', lastStatus },
            },
          ],
        }),
      ])
      expect(rows, lastStatus).toHaveLength(0)
    }
  })

  it('ignores steps with no anchor and turns with no bundle', () => {
    expect(
      pendingWithdrawals([turn({}), turn({ bundle: [{ label: 'swap', hash: 'x' }] })])
    ).toHaveLength(0)
  })
})
