import { describe, expect, it } from 'vitest'

import { appendLiveTurn, loadLiveSession } from '../chat/live-session'
import { chainTurnCard, payoutLine, toTurnCard, type TurnCard } from '../chat/turn-card'
import type { PreparedAction } from '../chains/types'
import type { CashoutOrderView } from '../weave/cashout-view'

/**
 * A finished card stays in the chat as its last screen once the next message is sent, and after a
 * reload. What is kept is only what that screen shows, rebuilt field by field when read back.
 */

const prepared: PreparedAction = {
  venueId: 'rnear',
  venueName: 'rNEAR',
  kind: 'stake',
  summary: 'Stake 0.18 NEAR with Rhea and receive rNEAR.',
  pay: { amount: '0.18', symbol: 'NEAR' },
  receive: { amount: '0.17', symbol: 'rNEAR', approximate: true },
  notes: ['Leaving takes about 30 hours.'],
  signing: { family: 'near', transactions: [] },
  context: { requestId: 'r1' },
  receipt: 'signed-receipt',
}

const order: CashoutOrderView = {
  id: 'ord_1',
  chain: 'avalanche',
  status: 'paid',
  currency: 'NGN',
  amount: '5.053499',
  estimatedDest: '6747',
  paidDest: '6700',
  provider: 'weave',
  institutionName: 'Moniepoint MFB',
  accountName: 'ADA OBI',
  accountMask: '••3682',
  depositAddress: '0xabc',
  depositHash: '0xhash',
}

describe('chainTurnCard', () => {
  it.each(['idle', 'building', 'review', 'signing', 'submitting'] as const)(
    'keeps nothing while the card is %s',
    (phase) => {
      expect(chainTurnCard({ phase, prepared })).toBeUndefined()
    }
  )

  it('keeps a sent card without anything that could be signed again', () => {
    const card = chainTurnCard({
      phase: 'settled',
      prepared,
      hash: 'abc123',
      explorerUrl: 'https://nearblocks.io/txns/abc123',
    })
    expect(card).toEqual({
      kind: 'chain',
      phase: 'settled',
      prepared: {
        venueId: 'rnear',
        venueName: 'rNEAR',
        kind: 'stake',
        summary: 'Stake 0.18 NEAR with Rhea and receive rNEAR.',
        pay: { amount: '0.18', symbol: 'NEAR' },
        receive: { amount: '0.17', symbol: 'rNEAR', approximate: true },
        notes: ['Leaving takes about 30 hours.'],
      },
      hash: 'abc123',
      explorerUrl: 'https://nearblocks.io/txns/abc123',
    })
    expect(JSON.stringify(card)).not.toMatch(/signing|requestId|signed-receipt/)
  })

  it('keeps a refusal, which has nothing built, as its words', () => {
    expect(chainTurnCard({ phase: 'failed', error: "You don't hold that much NEAR." })).toEqual({
      kind: 'chain',
      phase: 'failed',
      error: "You don't hold that much NEAR.",
    })
  })

  it('keeps a transfer whose outcome is not known yet', () => {
    expect(
      chainTurnCard({ phase: 'pending', prepared, error: 'Not confirmed yet.' })
    ).toMatchObject({ kind: 'chain', phase: 'pending', error: 'Not confirmed yet.' })
  })
})

describe('toTurnCard', () => {
  const weave: TurnCard = {
    kind: 'weave',
    order,
    bank: { code: 'MONINGPC', name: 'Moniepoint MFB', logo: '/bank-logos/moniepoint.png' },
    hash: '0xhash',
    explorerUrl: 'https://snowtrace.io/tx/0xhash',
  }

  it('reads back a payout card as it was kept', () => {
    expect(toTurnCard(JSON.parse(JSON.stringify(weave)))).toEqual(weave)
  })

  it('drops a link that is not https, and a logo from anywhere but this app', () => {
    const card = toTurnCard({
      ...weave,
      explorerUrl: 'javascript:alert(1)',
      bank: { ...weave.bank, logo: 'https://evil.example/x.png' },
    })
    expect(card).toMatchObject({ kind: 'weave' })
    expect(card).not.toHaveProperty('explorerUrl')
    expect((card as { bank: object }).bank).not.toHaveProperty('logo')
  })

  it('never keeps a whole account number, only its last four', () => {
    const card = toTurnCard({ ...weave, order: { ...order, accountMask: '8080063682' } })
    expect(JSON.stringify(card)).not.toContain('8080063682')
    expect(JSON.stringify(card)).toContain('3682')
  })

  it('refuses what is not one of the cards, or is missing what its screen needs', () => {
    expect(toTurnCard({ kind: 'other' })).toBeUndefined()
    expect(toTurnCard({ kind: 'weave', order: { id: 'x' } })).toBeUndefined()
    expect(toTurnCard({ kind: 'chain', phase: 'review' })).toBeUndefined()
    expect(toTurnCard('weave')).toBeUndefined()
  })

  it('reads back a Linq naira card and a chain card', () => {
    const linq: TurnCard = {
      kind: 'linq',
      status: 'paid',
      order: {
        amount: '5',
        coin: 'usdc',
        amountNgn: '7000',
        accountName: 'ADA OBI',
        bankName: 'Moniepoint MFB',
        accountMask: '••3682',
        paymentHash: 'abc',
      },
    }
    expect(toTurnCard(JSON.parse(JSON.stringify(linq)))).toEqual(linq)
    const chain = chainTurnCard({
      phase: 'settled',
      prepared,
      hash: 'h',
      explorerUrl: 'https://x.io/h',
    })
    expect(toTurnCard(JSON.parse(JSON.stringify(chain)))).toEqual(chain)
  })
})

describe('the saved chat', () => {
  function memory(): Pick<Storage, 'getItem' | 'setItem'> {
    const data = new Map<string, string>()
    return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) }
  }

  it('keeps a card with the line it belongs to, and drops only a bad card', () => {
    const storage = memory()
    const card = chainTurnCard({ phase: 'failed', error: 'No.' })
    appendLiveTurn(storage, 'near', 'a.near', {
      role: 'agent',
      text: 'No.',
      at: 1,
      card: card as TurnCard,
    })
    appendLiveTurn(storage, 'near', 'a.near', {
      role: 'agent',
      text: 'Still here.',
      at: 2,
      card: { kind: 'bogus' } as unknown as TurnCard,
    })
    const turns = loadLiveSession(storage, 'near', 'a.near')
    expect(turns[0]?.card).toEqual(card)
    expect(turns[1]).toEqual({ role: 'agent', text: 'Still here.', at: 2 })
  })
})

describe('payoutLine', () => {
  it('says a finished payout in one line, and nothing while it runs', () => {
    const weave = { kind: 'weave' as const, order }
    expect(payoutLine(weave)).toBe('Payout complete: 6700 NGN paid to Moniepoint MFB ••3682.')
    expect(payoutLine({ ...weave, order: { ...order, status: 'processing' } })).toBeUndefined()
    expect(payoutLine({ ...weave, order: { ...order, status: 'expired' } })).toBe(
      'Payout stopped: the order expired.'
    )
    const linq = {
      kind: 'linq' as const,
      status: 'paid' as const,
      order: {
        amount: '5',
        coin: 'usdc',
        amountNgn: '7000',
        accountName: 'ADA OBI',
        bankName: 'Moniepoint MFB',
        accountMask: '••3682',
      },
    }
    expect(payoutLine(linq)).toBe('Payout complete: 7000 NGN paid to Moniepoint MFB ••3682.')
    expect(payoutLine({ ...linq, status: 'waiting' })).toBeUndefined()
    expect(payoutLine(chainTurnCard({ phase: 'failed', error: 'No.' }) as TurnCard)).toBeUndefined()
  })
})
