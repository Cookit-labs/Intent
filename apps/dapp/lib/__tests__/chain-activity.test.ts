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
import { parseChainAction } from '../chains/parse-action'
import {
  asksToManagePosition,
  positionRequest,
  positionRows,
  rowsAt,
  type PositionRow,
  type PositionsReport,
} from '../chains/positions-reply'
import { typedAmount } from '../../components/intents/position-card'
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

  it('name the venue the money is at', () => {
    const rows = positionRows(report)
    expect(rows.map((r) => r.title)).toEqual([
      'Supplied to NAVI',
      'Borrowed from NAVI',
      'Staked on Staker',
      'Cooling down on Staker',
      'Ready to claim on Staker',
      'Supplied to Readonly',
    ])
    expect(rows[3]?.note).toBe('ready in about 30 hours')
  })

  it('offer withdrawing some, all, or topping up, where the venue can', () => {
    const [supplied] = positionRows(report)
    expect(supplied).toMatchObject({
      symbol: 'USDC',
      amount: '5.1',
      venueId: 'navi',
      out: { kind: 'withdraw', label: 'Withdraw' },
      into: { kind: 'supply', label: 'Top up' },
    })
    expect(supplied?.whole?.label).toBe('Withdraw all')
  })

  it('build all of it the way the chat reads "withdraw all USDC from NAVI"', () => {
    const [supplied] = positionRows(report)
    expect(supplied?.whole?.request).toEqual(parseChainAction('withdraw all USDC from NAVI'))
    expect(supplied?.whole?.request).toMatchObject({ kind: 'withdraw', amount: 'all' })
  })

  it('build some of it as the same request a typed amount makes', () => {
    const [supplied] = positionRows(report)
    expect(
      positionRequest(supplied as PositionRow, { kind: 'withdraw', label: 'Withdraw' }, '2')
    ).toEqual({
      kind: 'withdraw',
      amount: '2',
      tokenIn: 'USDC',
      venue: 'navi',
    })
    expect(
      positionRequest(supplied as PositionRow, { kind: 'supply', label: 'Top up' }, '3')
    ).toEqual({
      kind: 'supply',
      amount: '3',
      tokenIn: 'USDC',
      venue: 'navi',
    })
  })

  it('repay a loan, or borrow more', () => {
    const debt = positionRows(report)[1]
    expect(debt).toMatchObject({
      out: { kind: 'repay', label: 'Repay' },
      into: { kind: 'borrow', label: 'Borrow more' },
    })
    expect(debt?.whole?.label).toBe('Repay all')
  })

  it('unstake or stake more', () => {
    const stake = positionRows(report)[2]
    expect(stake).toMatchObject({
      out: { kind: 'unstake', label: 'Unstake' },
      into: { kind: 'stake', label: 'Top up' },
    })
    expect(stake?.whole?.request).toEqual(parseChainAction('unstake all SUI from Staker'))
  })

  it('offer nothing on an exit still cooling, and only the claim once ready', () => {
    const rows = positionRows(report)
    expect(rows[3]?.out).toBeUndefined()
    expect(rows[3]?.into).toBeUndefined()
    expect(rows[3]?.whole).toBeUndefined()
    expect(rows[4]?.out).toBeUndefined()
    expect(rows[4]?.into).toBeUndefined()
    expect(rows[4]?.whole?.label).toBe('Claim')
  })

  it('offer no way out a venue does not have, and keep what it does', () => {
    const readonly = positionRows(report)[5]
    expect(readonly?.out).toBeUndefined()
    expect(readonly?.whole).toBeUndefined()
    expect(readonly?.into).toMatchObject({ kind: 'supply' })
  })

  it('only cancel a stream, which has no amount to choose', () => {
    const [stream] = positionRows({
      venues: [
        {
          id: 'sablier',
          name: 'Sablier',
          kinds: ['stream', 'cancel'],
          positions: [{ slot: 'claimable', symbol: 'USDC', amount: '1', id: '77' }],
        },
      ],
      unread: [],
    })
    expect(stream?.out).toBeUndefined()
    expect(stream?.into).toBeUndefined()
    expect(stream?.whole?.label).toBe('Cancel stream')
    expect(stream?.whole?.request).toMatchObject({ kind: 'cancel', streamId: '77' })
  })

  it('narrow to a venue named in chat, or show everything if it matches none', () => {
    const rows = positionRows(report)
    expect(rowsAt(rows, 'navi').map((r) => r.venueId)).toEqual(['navi', 'navi'])
    expect(rowsAt(rows, 'nowhere')).toHaveLength(rows.length)
    expect(rowsAt(rows, undefined)).toHaveLength(rows.length)
  })
})

describe('an amount typed on a position', () => {
  it('is a plain positive number', () => {
    expect(typedAmount('5')).toBe('5')
    expect(typedAmount(' 5.5 ')).toBe('5.5')
    expect(typedAmount('.5')).toBe('.5')
    for (const bad of ['', '0', '-1', 'abc', '1,000', '1e3', 'Infinity']) {
      expect(typedAmount(bad)).toBeUndefined()
    }
  })

  it('is no more than is held, where that is a limit', () => {
    expect(typedAmount('5.1', { atMost: '5.1' })).toBe('5.1')
    expect(typedAmount('5.2', { atMost: '5.1' })).toBeUndefined()
  })

  it('has no more places than the chain can hold', () => {
    expect(typedAmount('1.1234567', { maxPlaces: 7 })).toBe('1.1234567')
    expect(typedAmount('1.12345678', { maxPlaces: 7 })).toBeUndefined()
  })
})

describe('asking to manage a position in chat', () => {
  it.each([
    ['withdraw from my position', {}],
    ['manage my positions', {}],
    ['i want to withdraw from my position', {}],
    ['close my position', {}],
    ['top up my position', {}],
    ['please top up my deposit', {}],
    ['withdraw from my navi position', { venue: 'navi' }],
    ['top up my navi position', { venue: 'navi' }],
    ['can you manage my jito stake', { venue: 'jito' }],
    ['repay my aave loan', { venue: 'aave' }],
    ['withdraw from navi', { venue: 'navi' }],
    ['take my money out of kamino lend', null],
    ['take out my funds from kamino lend', { venue: 'kamino lend' }],
    ['pull out of suilend', { venue: 'suilend' }],
  ])('"%s"', (text, expected) => {
    expect(asksToManagePosition(text)).toEqual(expected)
  })

  it.each([
    'withdraw 5 usdc from navi',
    'withdraw all usdc from navi',
    'withdraw usdc',
    'deposit 5 usdc',
    'what can you do',
    'swap 5 usdc to sol',
  ])('"%s" is a request of its own', (text) => {
    expect(asksToManagePosition(text)).toBeNull()
  })
})
