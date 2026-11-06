import { describe, expect, it } from 'vitest'

import { chainHelp } from '../chains/explain'
import { looksLikeChainAction, parseChainAction, racesFirst } from '../chains/parse-action'
import { assertValidAmount, prepareChainAction } from '../chains/prepare'
import {
  ChainActionRefused,
  type ChainActionKind,
  type ChainModule,
  type ChainToken,
  type ChainVenue,
  type PreparedAction,
} from '../chains/types'

const ADDRESS = '0xAbC0000000000000000000000000000000000001'
const TOKEN: ChainToken = { symbol: 'USDC', id: '0xusdc', decimals: 6 }
const OTHER: ChainToken = { symbol: 'WAL', id: '0xwal', decimals: 9 }

function venueNamed(id: string, kinds: readonly ChainActionKind[]): ChainVenue {
  return {
    id,
    name: id,
    kinds,
    prepare: async (request): Promise<PreparedAction> => ({
      venueId: id,
      venueName: id,
      kind: request.kind,
      summary: id,
      pay: { amount: request.amount, symbol: request.tokenIn },
      notes: [],
      signing: { family: 'sui', transaction: 'AA==' },
    }),
    assertSafe: () => undefined,
  }
}

function moduleWith(overrides: Partial<ChainModule> = {}): ChainModule {
  return {
    chain: 'sui',
    tokens: [TOKEN, OTHER],
    venues: [],
    defaultVenue: {},
    priceUsd: async () => undefined,
    submit: async () => ({ ok: false, error: 'unused' }),
    balances: async () => ({ tokens: [], complete: true }),
    ...overrides,
  }
}

describe('reading position actions', () => {
  it.each([
    [
      'withdraw 25 USDC from Aave',
      { kind: 'withdraw', amount: '25', tokenIn: 'USDC', venue: 'Aave' },
    ],
    ['redeem 1,000 USDC', { kind: 'withdraw', amount: '1000', tokenIn: 'USDC' }],
    [
      'unstake 1 sSUI from SpringSui',
      { kind: 'unstake', amount: '1', tokenIn: 'sSUI', venue: 'SpringSui' },
    ],
    ['borrow 50 USDT0 on Aave', { kind: 'borrow', amount: '50', tokenIn: 'USDT0', venue: 'Aave' }],
    ['repay 50 USDT0 on Aave', { kind: 'repay', amount: '50', tokenIn: 'USDT0', venue: 'Aave' }],
    ['please pay back 5 USDC', { kind: 'repay', amount: '5', tokenIn: 'USDC' }],
  ])('reads %s', (text, expected) => {
    expect(parseChainAction(text)).toMatchObject(expected)
  })

  it('reads a chain’s name as its token', () => {
    expect(parseChainAction('unstake 2 monad')).toMatchObject({ kind: 'unstake', tokenIn: 'MON' })
  })
})

describe('reading payment actions', () => {
  it('reads a stream in days, with the address as typed', () => {
    expect(parseChainAction(`stream 500 USDC to ${ADDRESS} over 30 days`)).toEqual({
      kind: 'stream',
      amount: '500',
      tokenIn: 'USDC',
      recipient: ADDRESS,
      durationDays: '30',
      venue: undefined,
    })
  })

  it('reads a month as 30 days', () => {
    expect(parseChainAction(`pay 500 USDC to ${ADDRESS} over 2 months`)).toMatchObject({
      kind: 'stream',
      durationDays: '60',
    })
  })

  it('reads a stream to a name and through a named venue', () => {
    expect(parseChainAction('stream 5 USDC to ada.sol over 7 days with Streamflow')).toMatchObject({
      recipient: 'ada.sol',
      venue: 'Streamflow',
    })
  })

  it.each([
    `stream 500 USDC to ${ADDRESS}`,
    `stream 500 USDC to ${ADDRESS} over 0 days`,
    `stream 500 USDC to ${ADDRESS} over soon`,
    `pay 500 USDC to ${ADDRESS}`,
  ])('reads no stream from %s, since nothing is left to a default', (text) => {
    expect(parseChainAction(text)).toBeNull()
  })

  it('reads an invoice', () => {
    expect(parseChainAction(`invoice ${ADDRESS} 500 USDC due 2026-12-01`)).toMatchObject({
      kind: 'invoice',
      recipient: ADDRESS,
      amount: '500',
      tokenIn: 'USDC',
      dueDate: '2026-12-01',
    })
  })

  it('needs a due date on an invoice', () => {
    expect(parseChainAction(`invoice ${ADDRESS} 500 USDC`)).toBeNull()
  })

  it('reads paying an invoice, and needs its amount said', () => {
    expect(parseChainAction('pay invoice #12 with 500 USDC')).toMatchObject({
      kind: 'pay_invoice',
      invoiceId: '12',
      amount: '500',
      tokenIn: 'USDC',
    })
    expect(parseChainAction('pay invoice 12')).toBeNull()
  })

  it('still reads a plain send as a send', () => {
    expect(parseChainAction(`send 5 USDC to ${ADDRESS}`)).toMatchObject({ kind: 'send' })
  })
})

describe('choosing a venue when none is named', () => {
  const chainApi = moduleWith({
    venues: [venueNamed('general', ['stake']), venueNamed('only-wal', ['stake'])],
    defaultVenue: { stake: 'general' },
    venueForToken: { stake: { WAL: 'only-wal' } },
    priceUsd: async () => 1,
  })

  it('sends a token only one venue takes to that venue, in any case', async () => {
    const built = await prepareChainAction(
      chainApi,
      { kind: 'stake', amount: '1', tokenIn: 'wal' },
      ADDRESS
    )
    expect(built.venueId).toBe('only-wal')
  })

  it('leaves every other token on the default', async () => {
    const built = await prepareChainAction(
      chainApi,
      { kind: 'stake', amount: '1', tokenIn: 'USDC' },
      ADDRESS
    )
    expect(built.venueId).toBe('general')
  })

  it('still lets the person name another venue', async () => {
    const built = await prepareChainAction(
      chainApi,
      { kind: 'stake', amount: '1', tokenIn: 'WAL', venue: 'general' },
      ADDRESS
    )
    expect(built.venueId).toBe('general')
  })
})

describe('the amount', () => {
  it.each(['1', '1000000', '0.000001'])('takes %s, whatever it is worth', (amount) => {
    expect(() => assertValidAmount({ amount })).not.toThrow()
  })

  it.each(['0', '-1', 'lots', ''])('refuses %j, which is not an amount', (amount) => {
    expect(() => assertValidAmount({ amount })).toThrow(ChainActionRefused)
  })
})

describe('what these kinds do around the chat', () => {
  it('races only a choice between venues', () => {
    expect(racesFirst({ kind: 'swap' })).toBe(true)
    expect(racesFirst({ kind: 'supply' })).toBe(true)
    expect(racesFirst({ kind: 'stake' })).toBe(true)
    for (const kind of [
      'send',
      'withdraw',
      'unstake',
      'borrow',
      'repay',
      'stream',
      'invoice',
      'pay_invoice',
    ] as const) {
      expect(racesFirst({ kind })).toBe(false)
    }
  })

  it('tells someone what works when it can’t read the verbs', () => {
    for (const verb of ['withdraw', 'unstake', 'repay', 'stream', 'invoice', 'redeem']) {
      expect(looksLikeChainAction(`${verb} something`)).toBe(true)
    }
  })

  it('offers each kind as words someone can copy', () => {
    const help = chainHelp('Monad', [
      { kind: 'withdraw', venue: 'Aave', symbol: 'USDC' },
      { kind: 'stream', venue: 'Sablier', symbol: 'USDC' },
    ])
    expect(help).toContain('withdraw 25 USDC from Aave')
    expect(help).toContain('stream 100 USDC to an address over 30 days')
  })
})
