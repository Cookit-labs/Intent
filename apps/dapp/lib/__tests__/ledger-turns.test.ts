import { describe, expect, it } from 'vitest'

import { ledgerTurns } from '../chat/ledger-turns'
import type { SwapRecord } from '../swap/history'

function rec(over: Partial<SwapRecord> = {}): SwapRecord {
  return {
    txHash: 'h1',
    settledAt: '2026-10-15T10:00:00.000Z',
    sentAmount: '5',
    sentAsset: 'XLM',
    receivedAmount: '0.9',
    receivedAsset: 'USDC',
    hops: 0,
    kind: 'swap',
    fromThisApp: true,
    explorerUrl: 'https://x/tx/h1',
    ...over,
  }
}

describe('past intents from the ledger', () => {
  it("lists this app's swaps, limit orders and bundles as intents", () => {
    const rows = ledgerTurns(
      [
        rec(),
        rec({ txHash: 'h2', kind: 'limit' }),
        rec({
          txHash: 'h3',
          bundledWith: [{ label: 'Supply USDC', hash: 'h4', explorerUrl: 'https://x/tx/h4' }],
        }),
      ],
      'stellar',
      new Set()
    )
    expect(rows.map((r) => r.text)).toEqual([
      'Swap 5 XLM to USDC',
      'Limit order: 5 XLM for USDC',
      'Swap 5 XLM to USDC, then supply it',
    ])
    expect(rows[2]?.bundle?.map((s) => s.hash)).toEqual(['h3', 'h4'])
    expect(rows[0]?.outcome).toBe('Completed: sent 5 XLM, received 0.9 USDC.')
  })

  it("leaves out other apps' trades, cash-outs and what a chat already carries", () => {
    const rows = ledgerTurns(
      [
        rec({ fromThisApp: false }),
        rec({ txHash: 'c', kind: 'cashout' }),
        rec({ txHash: 'known' }),
      ],
      'stellar',
      new Set(['known'])
    )
    expect(rows).toEqual([])
  })
})
