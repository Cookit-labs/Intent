import { describe, expect, it } from 'vitest'

import { parseChainAction } from '../chains/parse-action'
import { prepareChainAction } from '../chains/prepare'
import {
  ChainActionRefused,
  type ChainActionRequest,
  type ChainModule,
  type ChainVenue,
  type PreparedAction,
  type VenuePosition,
} from '../chains/types'

const USDC = { symbol: 'USDC', id: 'usdc', decimals: 6, name: 'USD Coin' }

function venue(
  id: string,
  positions: VenuePosition[] | 'unread' | 'none',
  seen: ChainActionRequest[] = []
): ChainVenue {
  return {
    id,
    name: id,
    kinds: ['withdraw', 'repay', 'unstake', 'claim', 'cancel'],
    ...(positions === 'none'
      ? {}
      : {
          positions: async () => {
            if (positions === 'unread') throw new Error('rpc down')
            return positions
          },
        }),
    prepare: async (request) => {
      seen.push(request)
      return { venueId: id, venueName: id, kind: request.kind } as unknown as PreparedAction
    },
    assertSafe: () => undefined,
  }
}

function moduleWith(venues: ChainVenue[]): ChainModule {
  return {
    chain: 'sui',
    tokens: [USDC],
    venues,
    defaultVenue: { withdraw: 'a' },
    priceUsd: async () => 1,
    submit: async () => ({ ok: true, hash: 'h', explorerUrl: 'u' }),
    balances: async () => ({ tokens: [] }),
  } as unknown as ChainModule
}

const held = (amount: string): VenuePosition[] => [{ slot: 'supplied', symbol: 'USDC', amount }]
const withdraw = (amount: string, name?: string): ChainActionRequest => ({
  kind: 'withdraw',
  amount,
  tokenIn: 'USDC',
  ...(name !== undefined ? { venue: name } : {}),
})

describe('reading an exit', () => {
  it.each([
    ['withdraw all USDC', 'withdraw', undefined],
    ['withdraw all my USDC from Aave', 'withdraw', 'Aave'],
    ['withdraw my USDC', 'withdraw', undefined],
    ['take out all USDC on morpho', 'withdraw', 'morpho'],
    ['unstake all sSUI', 'unstake', undefined],
    ['repay all USDC on Aave', 'repay', 'Aave'],
    ['pay off my USDC', 'repay', undefined],
    ['claim my USDC', 'claim', undefined],
    ['collect USDC from solayer', 'claim', 'solayer'],
  ])('reads %j as the whole of it', (text, kind, named) => {
    expect(parseChainAction(text)).toMatchObject({ kind, amount: 'all', venue: named })
  })

  it('keeps a number a number', () => {
    expect(parseChainAction('withdraw 25 USDC')).toMatchObject({ kind: 'withdraw', amount: '25' })
  })

  it('keeps the case of a stream id', () => {
    expect(parseChainAction('cancel stream AbC123 on streamflow')).toMatchObject({
      kind: 'cancel',
      streamId: 'AbC123',
      venue: 'streamflow',
    })
  })
})

describe('where an exit goes', () => {
  it('goes to the one venue holding it, whatever the default is', async () => {
    const out = await prepareChainAction(
      moduleWith([venue('a', []), venue('b', held('5'))]),
      withdraw('5'),
      'me'
    )
    expect(out.venueId).toBe('b')
  })

  it('asks when two hold it, and says what each holds', async () => {
    await expect(
      prepareChainAction(
        moduleWith([venue('a', held('1')), venue('b', held('2'))]),
        withdraw('1'),
        'me'
      )
    ).rejects.toThrow(/1 on a and 2 on b/)
  })

  it('says so when it can read every venue and none holds it', async () => {
    const attempt = prepareChainAction(
      moduleWith([venue('a', []), venue('b', [])]),
      withdraw('1'),
      'me'
    )
    await expect(attempt).rejects.toThrow(ChainActionRefused)
    await expect(attempt).rejects.toThrow(/don't see any USDC/)
  })

  it.each(['unread', 'none'] as const)(
    'falls back to the default, not a refusal, when a venue reads as %s',
    async (other) => {
      const out = await prepareChainAction(
        moduleWith([venue('a', []), venue('b', other)]),
        withdraw('1'),
        'me'
      )
      expect(out.venueId).toBe('a')
    }
  )

  it('never reads positions to overrule a venue the person named', async () => {
    const out = await prepareChainAction(
      moduleWith([venue('a', held('9')), venue('b', [])]),
      withdraw('1', 'b'),
      'me'
    )
    expect(out.venueId).toBe('b')
  })
})

describe('an exit already under way', () => {
  const cooling: VenuePosition = {
    slot: 'cooling',
    symbol: 'USDC',
    amount: '4',
    readyInHours: 11.2,
  }
  const ready: VenuePosition = { slot: 'claimable', symbol: 'USDC', amount: '6' }
  const unstake = (amount: string): ChainActionRequest => ({
    kind: 'unstake',
    amount,
    tokenIn: 'USDC',
  })

  it.each([
    ['cooling', cooling],
    ['ready', ready],
  ])('sends an unstake to the venue holding what is %s, not "none anywhere"', async (_, held) => {
    const out = await prepareChainAction(
      moduleWith([venue('a', []), venue('b', [held])]),
      unstake('4'),
      'me'
    )
    expect(out.venueId).toBe('b')
  })

  it('sends a claim to the venue still cooling, so it can say how long is left', async () => {
    const out = await prepareChainAction(
      moduleWith([venue('a', []), venue('b', [cooling])]),
      { kind: 'claim', amount: 'all', tokenIn: 'USDC' },
      'me'
    )
    expect(out.venueId).toBe('b')
  })

  it('still does not send a withdraw to a venue only cooling', async () => {
    await expect(
      prepareChainAction(moduleWith([venue('a', []), venue('b', [cooling])]), withdraw('1'), 'me')
    ).rejects.toThrow(/don't see any USDC/)
  })

  it('says what is ready and what is on its way when "all" finds nothing left to start', async () => {
    const attempt = prepareChainAction(
      moduleWith([venue('a', [ready, cooling])]),
      unstake('all'),
      'me'
    )
    await expect(attempt).rejects.toThrow(/6 USDC is ready, so say "claim my USDC"/)
    await expect(attempt).rejects.toThrow(/4 USDC is on its way, ready in about 12 hours/)
  })

  it('offers a claim in words that read as one, when two venues hold it', async () => {
    await expect(
      prepareChainAction(
        moduleWith([venue('a', [ready]), venue('b', [ready])]),
        { kind: 'claim', amount: 'all', tokenIn: 'USDC' },
        'me'
      )
    ).rejects.toThrow(/"claim my USDC from a"/)
  })
})

describe('all of it', () => {
  it('reaches the venue as the live figure, marked whole', async () => {
    const seen: ChainActionRequest[] = []
    await prepareChainAction(
      moduleWith([venue('a', held('12.5'), seen), venue('b', [])]),
      withdraw('all'),
      'me'
    )
    expect(seen[0]).toMatchObject({ amount: '12.5', wholePosition: true })
  })

  it('refuses when the figure can\u2019t be read, rather than guessing', async () => {
    await expect(
      prepareChainAction(moduleWith([venue('a', 'unread')]), withdraw('all'), 'me')
    ).rejects.toThrow(/couldn't read how much/)
  })

  it('refuses when there is none', async () => {
    await expect(
      prepareChainAction(moduleWith([venue('a', [])]), withdraw('all', 'a'), 'me')
    ).rejects.toThrow(/no USDC to withdraw/)
  })

  it('refuses "all" on a kind with no position behind it', async () => {
    await expect(
      prepareChainAction(
        moduleWith([venue('a', [])]),
        { kind: 'swap', amount: 'all', tokenIn: 'USDC', tokenOut: 'USDC' },
        'me'
      )
    ).rejects.toThrow(ChainActionRefused)
  })
})

describe('a claim and a cancel', () => {
  it('leaves a claim for the venue to size', async () => {
    const seen: ChainActionRequest[] = []
    await prepareChainAction(
      moduleWith([venue('a', [{ slot: 'claimable', symbol: 'USDC', amount: '3' }], seen)]),
      { kind: 'claim', amount: 'all', tokenIn: 'USDC' },
      'me'
    )
    expect(seen[0]).toMatchObject({ kind: 'claim', amount: 'all' })
  })

  it('takes a cancel with no token to check', async () => {
    const out = await prepareChainAction(
      moduleWith([venue('a', [])]),
      { kind: 'cancel', amount: 'all', tokenIn: 'STREAM', streamId: '12', venue: 'a' },
      'me'
    )
    expect(out.kind).toBe('cancel')
  })
})
