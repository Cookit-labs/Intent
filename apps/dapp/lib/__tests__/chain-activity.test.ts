import { describe, expect, it } from 'vitest'

import {
  activityRecords,
  askedByHash,
  chainPositionsSource,
  composeInviteShown,
  mergeHistory,
  txExplorerLink,
  withPayouts,
  type ActivityEntry,
} from '../chains/activity'
import { positionRows, type PositionsReport } from '../chains/positions-reply'
import { evmExplorerUrl } from '../chains/evm/tokens'
import { explorerUrl as nearExplorerUrl } from '../chains/near/tokens'
import type { SwapRecord } from '../swap/history'
import type { WeaveOrderView } from '../weave/orders'

const AT = '2026-11-07T10:00:00.000Z'

function entry(over: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    hash: 'H1',
    kind: 'lend',
    action: 'supply',
    venue: 'NAVI',
    assetIn: 'USDC',
    assetOut: null,
    amountIn: '5',
    confirmed: true,
    at: AT,
    ...over,
  }
}

describe('a recorded transaction as a history row', () => {
  it('names what it did and where', () => {
    const [row] = activityRecords([entry()], 'sui')
    expect(row).toMatchObject({
      title: 'Deposit on NAVI',
      kind: 'other',
      txHash: 'H1',
      sentAmount: '5',
      sentAsset: 'USDC',
      receivedAsset: '',
      settledAt: AT,
      explorerUrl: 'https://suiscan.xyz/mainnet/tx/H1',
    })
  })

  it.each([
    ['supply', 'Deposit'],
    ['stake', 'Stake'],
    ['repay', 'Repayment'],
    ['withdraw', 'Withdrawal'],
    ['unstake', 'Unstake'],
    ['borrow', 'Borrow'],
    ['claim', 'Claim'],
    ['swap', 'Swap'],
    ['limit', 'Limit order'],
    ['stream', 'Stream'],
  ])('calls a %s a %s', (action, title) => {
    expect(activityRecords([entry({ action })], 'sui')[0]?.title).toBe(`${title} on NAVI`)
  })

  it('says a send without a venue, since a transfer has none worth naming', () => {
    const [row] = activityRecords([entry({ kind: 'send', action: 'send', venue: 'Wallet' })], 'sui')
    expect(row?.title).toBe('Send')
  })

  it('falls back to the kind for a row from before the action was recorded', () => {
    const rows = activityRecords(
      [
        entry({ kind: 'lend', action: null, venue: null }),
        entry({ hash: 'H2', kind: 'swap', action: null, venue: null, assetOut: 'SUI' }),
      ],
      'sui'
    )
    expect(rows[0]?.title).toBe('Lending')
    expect(rows[1]?.title).toBe('Swap')
    expect(rows[1]?.kind).toBe('swap')
    expect(rows[1]?.receivedAsset).toBe('SUI')
  })

  it('never calls an unread transaction anything but a transaction', () => {
    const [row] = activityRecords(
      [entry({ kind: 'unknown', action: null, venue: null, assetIn: null, amountIn: null })],
      'near'
    )
    expect(row?.title).toBeUndefined()
    expect(row?.kind).toBe('other')
    expect(row?.sentAmount).toBe('')
    expect(row?.explorerUrl).toBe(nearExplorerUrl('H1'))
  })

  it('marks a transaction sent with no outcome yet', () => {
    expect(activityRecords([entry({ confirmed: false })], 'sui')[0]?.unconfirmed).toBe(true)
    expect(activityRecords([entry()], 'sui')[0]?.unconfirmed).toBeUndefined()
    expect(activityRecords([entry()], 'sui')[0]?.recorded).toBe(true)
  })

  it('keeps a cash-out a cash-out, and a bundle a bundle', () => {
    const rows = activityRecords(
      [
        entry({ kind: 'offramp', action: null, venue: null }),
        entry({ hash: 'H2', kind: 'plan', action: null, venue: null }),
        entry({ hash: 'H3', kind: 'offer', action: null, venue: null }),
      ],
      'avalanche'
    )
    expect(rows.map((r) => r.kind)).toEqual(['cashout', 'bundle', 'limit'])
    expect(rows.map((r) => r.title)).toEqual([undefined, undefined, undefined])
  })
})

describe('the link to a transaction', () => {
  it('uses the explorer each chain already links to', () => {
    expect(txExplorerLink('solana', 'S')).toBe('https://solscan.io/tx/S')
    expect(txExplorerLink('sui', 'S')).toBe('https://suiscan.xyz/mainnet/tx/S')
    expect(txExplorerLink('near', 'S')).toBe(nearExplorerUrl('S'))
    expect(txExplorerLink('avalanche', '0xa')).toBe(evmExplorerUrl('avalanche', '0xa'))
    expect(txExplorerLink('monad', '0xa')).toBe(evmExplorerUrl('monad', '0xa'))
    expect(txExplorerLink('stellar', 'S')).toMatch(/stellar\.expert\/explorer\/.+\/tx\/S$/)
  })

  it('sends a cow order uid to cow, where it exists, and not to a chain explorer', () => {
    const uid = `0x${'a'.repeat(112)}`
    expect(txExplorerLink('avalanche', uid)).toBe(`https://explorer.cow.fi/avax/orders/${uid}`)
  })
})

function record(over: Partial<SwapRecord>): SwapRecord {
  return {
    txHash: 'H1',
    settledAt: AT,
    sentAmount: '1',
    sentAsset: 'XLM',
    receivedAmount: '1',
    receivedAsset: 'USDC',
    hops: 0,
    kind: 'swap',
    fromThisApp: true,
    explorerUrl: 'x',
    ...over,
  }
}

describe('merging the chain with the app record', () => {
  it('shows each transaction once, the richer source winning, newest first', () => {
    const merged = mergeHistory(
      [record({ txHash: 'A', settledAt: '2026-11-01T00:00:00.000Z', hops: 2 })],
      [
        record({ txHash: 'A', settledAt: '2026-11-01T00:00:00.000Z', hops: 0 }),
        record({ txHash: 'B', settledAt: '2026-11-05T00:00:00.000Z' }),
      ]
    )
    expect(merged.map((r) => r.txHash)).toEqual(['B', 'A'])
    expect(merged[1]?.hops).toBe(2)
  })
})

function order(over: Partial<WeaveOrderView> = {}): WeaveOrderView {
  return {
    id: 'o',
    chain: 'sui',
    status: 'paid',
    currency: 'NGN',
    amount: '5',
    estimatedDest: '7000',
    institutionName: 'Opay',
    accountName: 'A B',
    accountMask: '••••1234',
    depositAddress: 'd',
    depositMemo: undefined,
    depositHash: 'H1',
    expiresAt: undefined,
    createdAt: AT,
    ...over,
  }
}

describe('a cash-out row with its payout', () => {
  const [row] = activityRecords([entry({ kind: 'offramp', action: null, venue: null })], 'sui')
  const base = row as SwapRecord

  it('joins the order by its deposit hash, on this chain only', () => {
    const [joined] = withPayouts([base], [order()], 'sui')
    expect(joined).toMatchObject({
      receivedAmount: '7000',
      receivedAsset: 'NGN',
      payout: {
        status: 'paid',
        statusLabel: 'Paid',
        bankName: 'Opay',
        accountMask: '••••1234',
      },
    })
    expect(withPayouts([base], [order({ chain: 'solana' })], 'sui')[0]?.payout).toBeUndefined()
  })

  it('prefers what was actually paid over the estimate', () => {
    expect(withPayouts([base], [order({ paidDest: '6900' })], 'sui')[0]?.receivedAmount).toBe(
      '6900'
    )
  })

  it('leaves a swap alone even if an order shares nothing with it', () => {
    const [swap] = activityRecords([entry({ kind: 'swap', action: 'swap', hash: 'H9' })], 'sui')
    expect(withPayouts([swap as SwapRecord], [order()], 'sui')[0]?.payout).toBeUndefined()
  })
})

describe('what was typed, for rows that recorded nothing else', () => {
  it('finds the words by the hash of the turn or of any of its steps', () => {
    const byHash = askedByHash([
      { text: 'deposit 5 usdc on navi', txHash: 'H1' },
      { text: 'swap then stake', bundle: [{ hash: 'H2' }, {}] },
      { text: 'nothing settled' },
    ])
    expect(byHash.get('H1')).toBe('deposit 5 usdc on navi')
    expect(byHash.get('H2')).toBe('swap then stake')
    expect(byHash.size).toBe(2)
  })
})

describe('inviting a wallet to compose its first intent', () => {
  it('only when every read answered and nothing is there', () => {
    expect(composeInviteShown({ rows: 0, settled: true })).toBe(true)
  })

  it('not once it has any past transaction', () => {
    expect(composeInviteShown({ rows: 1, settled: true })).toBe(false)
  })

  it('not while the answer is unknown, because "first" would be a guess', () => {
    expect(composeInviteShown({ rows: 0, settled: false })).toBe(false)
  })
})

describe('which positions a chain has', () => {
  it('reads Blend on Stellar and the chain venues everywhere else', () => {
    expect(chainPositionsSource('stellar')).toBe('blend')
    for (const chain of ['solana', 'sui', 'near', 'avalanche', 'monad'] as const) {
      expect(chainPositionsSource(chain)).toBe('venues')
    }
    expect(chainPositionsSource('arc')).toBe('none')
  })
})

describe('position rows', () => {
  const report: PositionsReport = {
    venues: [
      {
        id: 'navi',
        name: 'NAVI',
        kinds: ['supply', 'withdraw', 'borrow', 'repay'],
        positions: [
          { slot: 'supplied', symbol: 'USDC', amount: '5.1' },
          { slot: 'borrowed', symbol: 'SUI', amount: '2' },
        ],
      },
      {
        id: 'staker',
        name: 'Staker',
        kinds: ['stake', 'unstake', 'claim'],
        positions: [
          { slot: 'staked', symbol: 'SUI', amount: '1' },
          { slot: 'cooling', symbol: 'SUI', amount: '3', readyInHours: 30 },
          { slot: 'claimable', symbol: 'SUI', amount: '4' },
        ],
      },
      {
        id: 'readonly',
        name: 'Readonly',
        kinds: ['supply'],
        positions: [{ slot: 'supplied', symbol: 'USDC', amount: '9' }],
      },
    ],
    unread: [],
  }

  it('name the venue the money is at, and the way back out', () => {
    const rows = positionRows(report)
    expect(rows[0]).toMatchObject({
      title: 'Supplied to NAVI',
      note: 'earning',
      symbol: 'USDC',
      amount: '5.1',
      exit: { label: 'Withdraw', words: 'withdraw all USDC from NAVI' },
    })
    expect(rows[1]).toMatchObject({
      title: 'Borrowed from NAVI',
      note: 'owed',
      exit: { label: 'Repay', words: 'repay all SUI on NAVI' },
    })
    expect(rows[2]).toMatchObject({
      title: 'Staked on Staker',
      exit: { label: 'Unstake', words: 'unstake all SUI from Staker' },
    })
    expect(rows[3]).toMatchObject({
      title: 'Cooling down on Staker',
      note: 'ready in about 30 hours',
    })
    expect(rows[4]).toMatchObject({
      title: 'Ready to claim on Staker',
      exit: { label: 'Claim', words: 'claim SUI from Staker' },
    })
  })

  it('offers no way out that no sentence would do', () => {
    expect(positionRows(report)[5]?.exit).toBeUndefined()
  })
})
