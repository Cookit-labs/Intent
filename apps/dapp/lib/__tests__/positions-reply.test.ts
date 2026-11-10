import { describe, expect, it, vi } from 'vitest'

import { fixVerbTypo } from '../chat/typos'
import { parseChainAction } from '../chains/parse-action'
import { readChainMessage } from '../chains/parse-sequence'
import {
  asksForPositions,
  blendPositionsReply,
  positionsReply,
  readPositionsReply,
  type PositionsReport,
  type VenueHoldings,
} from '../chains/positions-reply'
import type { BlendPositions } from '../lend/position'
import type { ChainActionKind, VenuePosition } from '../chains/types'
import { parseCashout } from '../weave/parse-cashout'

const ASKED = [
  'what have I deposited',
  'What have I deposited?',
  'where is my money',
  "where's my money?",
  'where’s my money',
  'wheres my money',
  'where are my funds',
  'where did my money go',
  'my positions',
  'My Positions.',
  'show my positions',
  'show me my positions',
  'can you show me my positions please',
  'tell me my positions',
  'tell me where my money is',
  'what can I withdraw',
  'what can I withdraw from Aave',
  'how much can I withdraw',
  'how much USDC can I withdraw',
  'what could I unstake',
  'what can I claim',
  "what's ready to claim",
  'anything to claim',
  'is anything ready to claim?',
  'what is available to withdraw',
  'how much have I deposited',
  'how much USDC did I supply',
  'what did I deposit',
  'what do I have staked',
  'how much do I have staked right now',
  'show me what I have deposited so far',
  "show me what I've supplied",
  'show me what I deposited',
  'what have I borrowed',
  'what do I owe',
  'how much do I owe on Aave',
  'do I have any deposits',
  'do I have anything staked',
  'do I have USDC staked',
  "what's staked",
  "what's cooling",
  'my deposits',
  'my staked SOL',
  'my loans',
  "what's my position",
  'what are my open positions',
  'open positions',
  'positions',
]

const NOT_ASKED = [
  // Plain balance questions, which the model answers from the wallet.
  'what is my balance',
  "what's my balance",
  'my balance',
  'show my balance',
  'show me my tokens',
  'my tokens',
  'my assets',
  'show my assets',
  'my holdings',
  'my portfolio',
  'what do I have',
  'what do I hold',
  'what have I got',
  'how much do I have',
  'how much USDC do I have',
  'how much money do I have',
  "what's in my wallet",
  'what tokens do I have',
  'where is my wallet',
  // Instructions, which must stay instructions.
  'withdraw all USDC from Aave',
  'withdraw my USDC',
  'withdraw 5 USDC to my bank',
  'deposit 5 USDC on Aave',
  'stake 5 SOL',
  'unstake all SOL',
  'repay all USDC on Aave',
  'claim SOL from Marinade',
  'close my positions',
  'get my deposits',
  'give me my deposit',
  'sell me my positions',
  'what can I withdraw to my bank',
  'what have I deposited and swap 5 USDC to SOL',
  // Other questions.
  'how do I withdraw',
  'what can I do',
  'what can I swap',
  'what can I stake',
  'how much can I borrow',
  'how much should I stake',
  'how much will I save',
  'what is staking',
  'what is staked SOL',
  'what is a deposit',
  "what's the price of SOL",
  'I want to go jogging',
  '',
]

describe('a warning on a position', () => {
  it('reads after what to type, in the same line', () => {
    const reply = positionsReply(
      {
        venues: [
          {
            id: 'rhea-lend',
            name: 'Rhea Lend',
            positions: [
              { slot: 'borrowed', symbol: 'USDC', amount: '40', warning: 'Mind the level.' },
            ],
            kinds: ['repay'],
          },
        ],
        unread: [],
      } as unknown as Parameters<typeof positionsReply>[0],
      'NEAR'
    )
    expect(reply).toMatch(/• 40 USDC on Rhea Lend.* Mind the level\./)
  })
})

describe('asksForPositions', () => {
  it.each(ASKED)('hears %j', (text) => {
    expect(asksForPositions(text)).toBe(true)
  })

  it.each(NOT_ASKED)('leaves %j alone', (text) => {
    expect(asksForPositions(text)).toBe(false)
  })

  it.each(ASKED)('nothing that runs first takes %j as an instruction', (text) => {
    expect(parseCashout(text)).toBeNull()
    expect(readChainMessage(text, 'avalanche', 'Avalanche')).toEqual({ kind: 'model' })
  })

  it('leaves "tell" alone, since one letter from "sell" is not a typo of it', () => {
    expect(fixVerbTypo('tell me my positions')).toBe('tell me my positions')
  })
})

const position = (over: Partial<VenuePosition> & Pick<VenuePosition, 'slot'>): VenuePosition => ({
  symbol: 'USDC',
  amount: '100.5',
  ...over,
})

const EXITS: readonly ChainActionKind[] = ['withdraw', 'unstake', 'repay', 'claim', 'cancel']

const venue = (name: string, positions: VenuePosition[], kinds = EXITS): VenueHoldings => ({
  id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  name,
  kinds,
  positions,
})

const report = (venues: VenueHoldings[], unread: string[] = []): PositionsReport => ({
  venues,
  unread: unread.map((name) => ({ id: name.toLowerCase(), name })),
})

/** The sentences a reply offers, read back out of it. */
const offered = (reply: string): string[] =>
  [...reply.matchAll(/type "([^"]+)"/g)].map((m) => m[1] as string)

describe('positionsReply', () => {
  it('says what is supplied, staked, borrowed, cooling and ready, each with the words to type', () => {
    const reply = positionsReply(
      report([
        venue('Aave', [
          position({ slot: 'supplied' }),
          position({ slot: 'borrowed', amount: '20', symbol: 'USDT' }),
        ]),
        venue('Benqi', [
          position({ slot: 'staked', amount: '5', symbol: 'sAVAX' }),
          position({ slot: 'cooling', amount: '1', symbol: 'AVAX', readyInHours: 30 }),
          position({ slot: 'claimable', amount: '2', symbol: 'AVAX' }),
        ]),
      ]),
      'Avalanche'
    )
    expect(reply).toContain('• 100.5 USDC on Aave: type "withdraw all USDC from Aave"')
    expect(reply).toContain('• 5 sAVAX on Benqi: type "unstake all sAVAX from Benqi"')
    expect(reply).toContain('• 20 USDT on Aave: type "repay all USDT on Aave"')
    expect(reply).toContain(
      '• 1 AVAX on Benqi, ready in about 30 hours. Then type "claim AVAX from Benqi"'
    )
    expect(reply).toContain('• 2 AVAX on Benqi: type "claim AVAX from Benqi"')
    const order = ['Supplied', 'Staked', 'Borrowed', 'Cooling down', 'Ready to claim']
    const at = order.map((heading) => reply.indexOf(`\n${heading}\n`))
    expect(at.every((index) => index > 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
  })

  it('offers only sentences the chat reads back as that exit, at that venue', () => {
    const reply = positionsReply(
      report([
        venue('Jupiter Lend Earn', [
          position({ slot: 'supplied', symbol: 'USDC.e' }),
          position({ slot: 'staked', symbol: 'JitoSOL' }),
          position({ slot: 'borrowed', symbol: 'USDT' }),
          position({ slot: 'claimable', symbol: 'SOL' }),
          position({ slot: 'supplied', symbol: 'USDC', id: 'abc123' }),
        ]),
      ]),
      'Solana'
    )
    const parsed = offered(reply).map(parseChainAction)
    expect(parsed).toMatchObject([
      { kind: 'withdraw', amount: 'all', tokenIn: 'USDC.e', venue: 'Jupiter Lend Earn' },
      { kind: 'cancel', streamId: 'abc123', venue: 'Jupiter Lend Earn' },
      { kind: 'unstake', amount: 'all', tokenIn: 'JitoSOL', venue: 'Jupiter Lend Earn' },
      { kind: 'repay', amount: 'all', tokenIn: 'USDT', venue: 'Jupiter Lend Earn' },
      { kind: 'claim', amount: 'all', tokenIn: 'SOL', venue: 'Jupiter Lend Earn' },
    ])
    for (const words of offered(reply)) expect(parseCashout(words)).toBeNull()
  })

  it('offers no sentence a venue could not run', () => {
    const reply = positionsReply(
      report([
        venue('Supply Only', [position({ slot: 'supplied' })], ['supply']),
        venue('No Cancel', [position({ slot: 'supplied', id: 'abc' })], ['withdraw']),
      ]),
      'Monad'
    )
    expect(offered(reply)).toEqual([])
    expect(reply).toContain("• 100.5 USDC on Supply Only. I can't act on this one from here yet.")
    expect(reply).toContain("• 100.5 USDC on No Cancel. I can't act on this one from here yet.")
  })

  it('falls back to the id, then to no venue, when a name could not be typed', () => {
    const symbols = positionsReply(
      report([venue('Odd (Name)', [position({ slot: 'supplied' })])]),
      'Sui'
    )
    expect(offered(symbols)).toEqual(['withdraw all USDC from odd-name-'])
    const nameless = positionsReply(
      report([
        { id: '#', name: '(?)', kinds: ['withdraw'], positions: [position({ slot: 'supplied' })] },
      ]),
      'Sui'
    )
    expect(offered(nameless)).toEqual(['withdraw all USDC'])
  })

  it.each([
    [0.5, 'ready in under an hour'],
    [1.2, 'ready in about an hour'],
    [6, 'ready in about 6 hours'],
    [120, 'ready in about 5 days'],
  ])('says when a cooling exit of %d hours is ready', (readyInHours, said) => {
    const reply = positionsReply(
      report([venue('Benqi', [position({ slot: 'cooling', readyInHours })])]),
      'Avalanche'
    )
    expect(reply).toContain(said)
  })

  it('says so when the chain gives no time', () => {
    const reply = positionsReply(report([venue('Benqi', [position({ slot: 'cooling' })])]), 'Sui')
    expect(reply).toContain(`doesn't say when it's ready`)
    expect(reply).toContain('Then type "claim USDC from Benqi"')
  })

  it('names what it could not read beside what it could', () => {
    const reply = positionsReply(
      report([venue('Aave', [position({ slot: 'supplied' })])], ['Morpho', 'Euler']),
      'Avalanche'
    )
    expect(reply).toContain('on Aave')
    expect(reply).toContain("I couldn't read Morpho, Euler, so I can't say what you have there.")
  })

  it('says nothing is there only when everything was read', () => {
    const empty = positionsReply(report([venue('Aave', [])]), 'Avalanche')
    expect(empty).toContain('You have nothing deposited')
    expect(empty).not.toContain("couldn't")

    const partly = positionsReply(report([venue('Aave', [])], ['Morpho']), 'Avalanche')
    expect(partly).not.toContain('You have nothing')
    expect(partly).toContain('Nothing shows on the apps I could read on Avalanche.')
    expect(partly).toContain("I couldn't read Morpho")

    const none = positionsReply(report([], ['Morpho']), 'Avalanche')
    expect(none).not.toMatch(/nothing/i)
    expect(none).toContain("I couldn't read Morpho")
  })

  it('never reads a failed or empty answer as nothing held', () => {
    for (const reply of [positionsReply(undefined, 'Sui'), positionsReply(report([]), 'Sui')]) {
      expect(reply).toContain("I couldn't read your positions")
      expect(reply).not.toContain('You have nothing')
    }
  })

  it('says the wallet is a separate question, in words that reach the balance path', () => {
    const reply = positionsReply(report([venue('Aave', [])]), 'Sui')
    expect(reply).toContain(`Ask "what's my balance"`)
    expect(asksForPositions("what's my balance")).toBe(false)
  })
})

const blendBalance = (symbol: string, display: string) => ({
  assetId: 'C',
  symbol,
  tokens: '1',
  amount: '1',
  display,
  reserveIndex: 0,
})

const blend = (over: Partial<BlendPositions>): BlendPositions => ({
  supplied: [],
  collateral: [],
  borrowed: [],
  health: { collateralBase: 0, liabilityBase: 0, healthFactor: undefined, liquidatable: false },
  liquidationPrice: undefined,
  ...over,
})

describe('blendPositionsReply', () => {
  it('keeps supply and collateral apart, and points at where they are acted on', () => {
    const reply = blendPositionsReply(
      blend({
        supplied: [blendBalance('XLM', '100.5000000')],
        collateral: [blendBalance('XLM', '50.0000000')],
        borrowed: [blendBalance('CABC…WXYZ', '10.0000001')],
      })
    )
    expect(reply).toContain('Supplied\n• 100.5 XLM on Blend\n')
    expect(reply).toContain('Collateral\n• 50 XLM on Blend. It can be liquidated')
    expect(reply).toContain('Borrowed\n• 10.0000001 CABC…WXYZ on Blend\n')
    expect(reply).toContain('open the History tab')
    expect(reply).not.toContain('can be liquidated now')
  })

  it('warns when the position can be liquidated', () => {
    const reply = blendPositionsReply(
      blend({
        collateral: [blendBalance('XLM', '50.0000000')],
        health: { collateralBase: 1, liabilityBase: 2, healthFactor: 0.5, liquidatable: true },
      })
    )
    expect(reply).toContain('Your Blend position can be liquidated now.')
  })

  it('says nothing is in Blend when it was read, and not that nothing is on Stellar', () => {
    const reply = blendPositionsReply(blend({}))
    expect(reply).toContain('You have nothing supplied or borrowed on Blend.')
    expect(reply).toContain('Blend is the one place I can read on Stellar.')
    expect(reply).not.toContain('History tab')
  })

  it('says it could not read Blend when the read failed', () => {
    const reply = blendPositionsReply(undefined)
    expect(reply).toContain("I couldn't read Blend")
    expect(reply).not.toMatch(/nothing/i)
  })
})

describe('readPositionsReply', () => {
  const answering = (body: unknown, status = 200) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

  it('asks for a wallet, and reads nothing without one', async () => {
    const fetchImpl = answering({})
    expect(await readPositionsReply('sui', 'Sui', undefined, fetchImpl)).toContain(
      'Connect your wallet'
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reads a chain through its positions route, with the account escaped', async () => {
    const fetchImpl = answering(report([venue('Aave', [position({ slot: 'supplied' })])]))
    const reply = await readPositionsReply('avalanche', 'Avalanche', 'a b', fetchImpl)
    expect(reply).toContain('withdraw all USDC from Aave')
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/chain/avalanche/positions?account=a%20b',
      expect.objectContaining({ cache: 'no-store' })
    )
  })

  it('reads Stellar through the Blend route', async () => {
    const fetchImpl = answering({
      position: null,
      positions: blend({ supplied: [blendBalance('XLM', '1.0000000')] }),
    })
    expect(await readPositionsReply('stellar', 'Stellar', 'G', fetchImpl)).toContain(
      '• 1 XLM on Blend'
    )
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/lend/position?account=G',
      expect.objectContaining({ cache: 'no-store' })
    )
  })

  it.each([
    ['a 503', answering({ error: 'x' }, 503)],
    ['a malformed body', answering({ venues: [] })],
    [
      'a dropped connection',
      vi.fn(async () => {
        throw new Error('network')
      }) as unknown as typeof fetch,
    ],
  ])('never shows %s as nothing held', async (_, fetchImpl) => {
    const chain = await readPositionsReply('sui', 'Sui', '0x', fetchImpl)
    expect(chain).toContain("I couldn't read your positions")
    const stellar = await readPositionsReply('stellar', 'Stellar', 'G', fetchImpl)
    expect(stellar).toContain("I couldn't read Blend")
    expect(stellar).not.toContain('You have nothing')
  })
})
