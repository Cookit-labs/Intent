import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { STEP_CARD_EXPIRED, stepErrorMessage } from '../agents/chain-race'
import { chainCapabilities } from '../chains/capabilities'
import { chainHelp, helpForUnread } from '../chains/explain'
import { looksLikeChainAction } from '../chains/parse-action'
import {
  chainRouteFromReading,
  messageStartsAction,
  parseChainSequence,
  readChainMessage,
  requestSaid,
  sequenceFromReading,
  type ReadSwap,
} from '../chains/parse-sequence'
import { followOnRefusal, type ChainSequenceRequest } from '../chains/sequence'
import {
  keepsRun,
  moveOnSecond,
  secondStepLabel,
  stepAmount,
  type SequenceStage,
} from '../chains/sequence-flow'
import { afterSigning, QUOTE_EXPIRED, quoteExpiredBeforeSigning } from '../chains/signing-flow'
import type { ChainWithActions, PreparedAction, SigningPayload } from '../chains/types'
import { fetchOrchestrate } from '../chat/orchestrate-client'
import { readingFromArguments } from '../parse-intent-llm'
import { currencyNamedIn, routeCashout } from '../weave/parse-cashout'

const ADDRESS = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'
const SEND: ChainSequenceRequest = {
  swap: { kind: 'swap', amount: '5', tokenIn: 'SOL', tokenOut: 'USDC', venue: undefined },
  followOn: { kind: 'send', recipient: ADDRESS },
}
const CASHOUT: ChainSequenceRequest = { ...SEND, followOn: { kind: 'cashout' } }

const read = (
  over: Partial<ReadSwap & { action: string }> = {}
): ReadSwap & { action: string } => ({
  action: 'swap',
  tokenIn: 'SOL',
  tokenOut: 'USDC',
  amountUsd: 5,
  amountStated: true,
  amountIsUsd: false,
  followOn: null,
  ...over,
})

describe('1. step 2 card that expired', () => {
  it('sends the person to the button, not to their request, once the swap has settled', () => {
    const said = stepErrorMessage(QUOTE_EXPIRED, true)
    expect(said).toBe(STEP_CARD_EXPIRED)
    expect(said).toBe(
      "This step's card expired. Press the button above for a fresh one. The swap stands, so don't send your request again."
    )
  })

  it('leaves step 1 as it was', () => {
    expect(stepErrorMessage(QUOTE_EXPIRED, false)).toBe(QUOTE_EXPIRED)
  })

  it('has the button there: an expired card proves nothing moved, so the run is back at ready', () => {
    const following = { stage: 'following', settled: true, opened: true } as const
    expect(moveOnSecond(following, 'failed', false, SEND, '5', 'send').stage).toBe('ready')
  })

  it('never tells the person to send a new message after a wallet that did not answer', () => {
    const step = afterSigning({ ok: false, reason: 'rejected' }, 'evm')
    if (step.next !== 'unknown') throw new Error('expected unknown')
    const said = stepErrorMessage(step.error, true) as string
    expect(said).not.toMatch(/new message|Press the button/)
    expect(said).toMatch(/Check your wallet's activity first/)
    expect(said).toMatch(/The swap stands, so don't send your request again\./)
    // No button in this state, which is why this sentence offers none.
    const following = { stage: 'following', settled: true, opened: true } as const
    expect(moveOnSecond(following, 'pending', true, SEND, '5', 'send').stage).toBe('unsettled')
  })

  it('keeps the same wallet sentence on step 1, where a new message is right', () => {
    const step = afterSigning({ ok: false, reason: 'rejected' }, 'evm')
    if (step.next !== 'unknown') throw new Error('expected unknown')
    expect(stepErrorMessage(step.error, false)).toMatch(/send a new message to start again/)
  })
})

describe('2. ordinary words reach the model', () => {
  it.each([
    'swap some sol',
    'i want to swap 5 sol to usdc then cash out',
    'can i cash out here',
    'send my usdc to my friend',
    'swap 5',
    'whats my wallet balance',
  ])('%s goes to the model', (text) => {
    expect(readChainMessage(text, 'solana', 'Solana')).toEqual({ kind: 'model' })
  })

  it('still reads a complete sentence without a model', () => {
    expect(readChainMessage('swap 5 SOL to USDC', 'solana', 'Solana')).toMatchObject({
      kind: 'action',
      action: { amount: '5', tokenIn: 'SOL', tokenOut: 'USDC' },
    })
    expect(readChainMessage('swap 5 SOL to USDC then cash out', 'solana', 'Solana')).toMatchObject({
      kind: 'sequence',
      request: { followOn: { kind: 'cashout' } },
    })
    expect(readChainMessage('swap 5 USDC to SOL then cash out', 'solana', 'Solana')).toMatchObject({
      kind: 'refusal',
    })
  })

  it('answers with what works when the model could not read a sentence with a verb', () => {
    const capabilities = chainCapabilities('solana') ?? []
    const help = chainHelp('Solana', capabilities)
    expect(helpForUnread(['swap some sol'], 'Solana', capabilities)).toBe(help)
    expect(helpForUnread(['how are you'], 'Solana', capabilities)).toBeUndefined()
    expect(looksLikeChainAction('swap some sol')).toBe(true)
  })
})

describe('3. a currency as the token out', () => {
  it.each(['solana', 'sui', 'avalanche'] as const)('is a cash-out sequence on %s', (chain) => {
    expect(readChainMessage('change 5 SOL into naira', chain, chain)).toEqual({
      kind: 'cashout',
      route: { kind: 'sequence', token: 'SOL', amount: '5', currency: 'NGN' },
    })
    expect(readChainMessage('swap 5 SOL to naira', chain, chain)).toMatchObject({
      route: { currency: 'NGN' },
    })
    expect(readChainMessage('convert 5 sol to kes', chain, chain)).toMatchObject({
      route: { kind: 'sequence', currency: 'KES' },
    })
    expect(readChainMessage('convert 5 sol to kenyan shillings', chain, chain)).toMatchObject({
      route: { kind: 'sequence', currency: 'KES' },
    })
    expect(readChainMessage('change my 5 sol into kes', chain, chain)).toMatchObject({
      route: { kind: 'sequence', amount: '5', currency: 'KES' },
    })
  })

  it('opens the form for USDC, since no swap is needed', () => {
    expect(readChainMessage('change 5 USDC into naira', 'solana', 'Solana')).toEqual({
      kind: 'cashout',
      route: { kind: 'open', amount: '5', currency: 'NGN' },
    })
  })

  it('takes a venue off the end, which a cash-out has no use for', () => {
    expect(readChainMessage('swap 5 SOL to naira on jupiter', 'solana', 'Solana')).toMatchObject({
      route: { kind: 'sequence', currency: 'NGN' },
    })
  })

  it('says it for a fiat that is not paid', () => {
    expect(readChainMessage('swap 5 SOL to euros', 'solana', 'Solana')).toEqual({
      kind: 'cashout',
      route: { kind: 'currency', currency: 'EUR' },
    })
  })

  it.each([
    ['near', 'NEAR'],
    ['monad', 'Monad'],
  ] as const)('is refused before anything starts on %s', (chain, name) => {
    const refusal = followOnRefusal(chain, name, { kind: 'cashout' }, [])
    expect(refusal).toBeDefined()
    expect(readChainMessage('change 5 SOL into naira', chain, name)).toEqual({
      kind: 'refusal',
      refusal,
    })
    expect(readChainMessage('swap 5 SOL to euros', chain, name)).toEqual({
      kind: 'refusal',
      refusal,
    })
  })

  it('leaves a real token alone', () => {
    expect(readChainMessage('swap 5 SOL to USDT', 'solana', 'Solana')).toMatchObject({
      kind: 'action',
      action: { tokenOut: 'USDT' },
    })
  })

  it('asks the model when the words give it a fiat on both sides', () => {
    expect(readChainMessage('swap 5 eur to naira', 'solana', 'Solana')).toEqual({ kind: 'model' })
  })
})

describe('4. a follow-on the server cannot honour', () => {
  const lendArgs = {
    action: 'swap',
    tokenIn: 'SOL',
    tokenOut: 'USDC',
    amountUsd: 5,
    amountStated: true,
    followOn: 'lend',
    followOnVenue: '',
  }

  it('is reported off Stellar: no venues, no anchors, an unknown venue', () => {
    const off = { reportRefusedFollowOn: true }
    expect(
      readingFromArguments(lendArgs, { ...off, allowedVenues: [], allowedAnchors: [] })
    ).toMatchObject({ followOn: null, followOnRefused: { kind: 'lend', venue: '' } })
    expect(
      readingFromArguments(
        { ...lendArgs, followOn: 'offramp' },
        { ...off, allowedVenues: [], allowedAnchors: [] }
      )
    ).toMatchObject({ followOn: null, followOnRefused: { kind: 'offramp', venue: '' } })
    expect(
      readingFromArguments(
        { ...lendArgs, followOnVenue: 'aave' },
        { ...off, allowedVenues: ['kamino'], allowedAnchors: [] }
      )
    ).toMatchObject({ followOn: null, followOnRefused: { kind: 'lend', venue: 'aave' } })
  })

  it('leaves the reading as it was on Stellar', () => {
    const reading = readingFromArguments(
      { ...lendArgs, followOnVenue: 'aave' },
      { allowedVenues: ['blend'], allowedAnchors: [] }
    )
    expect(reading?.followOn).toBeNull()
    expect(reading).not.toHaveProperty('followOnRefused')
    expect(
      readingFromArguments(
        { ...lendArgs, followOnVenue: 'de findex' },
        { allowedVenues: ['defindex'], allowedAnchors: [] }
      )?.followOn
    ).toBeNull()
  })

  it('reports nothing when no follow-on was asked for or it can run', () => {
    const off = { reportRefusedFollowOn: true, allowedVenues: [], allowedAnchors: [] }
    expect(readingFromArguments({ ...lendArgs, followOn: 'none' }, off)).not.toHaveProperty(
      'followOnRefused'
    )
    expect(
      readingFromArguments(lendArgs, { ...off, allowedVenues: ['kamino'] })
    ).not.toHaveProperty('followOnRefused')
  })

  it('matches a venue whatever its spaces and hyphens, off Stellar', () => {
    const options = {
      reportRefusedFollowOn: true,
      allowedVenues: ['jupiter-lend', 'kamino'],
      allowedAnchors: [],
    }
    for (const followOnVenue of ['jupiter lend', 'Jupiter-Lend', 'jupiterlend']) {
      expect(readingFromArguments({ ...lendArgs, followOnVenue }, options)?.followOn).toEqual({
        kind: 'lend',
        venue: 'jupiter-lend',
        venueNamed: true,
      })
    }
  })

  it('reaches the chat through the client, and only when the server sent it', async () => {
    const answer = (extra: object): typeof fetch =>
      (async () =>
        new Response(
          JSON.stringify({
            outcome: 'act',
            action: 'swap',
            tokenIn: 'SOL',
            tokenOut: 'USDC',
            instruction: 'swap 5 SOL to USDC',
            followOn: null,
            ...extra,
          })
        )) as unknown as typeof fetch
    const turns = [{ role: 'user' as const, content: 'x' }]
    const refused = await fetchOrchestrate(
      turns,
      [],
      'solana',
      answer({ followOnRefused: { kind: 'lend', venue: 'aave' } })
    )
    expect(refused).toMatchObject({ read: { followOnRefused: { kind: 'lend', venue: 'aave' } } })
    const plain = await fetchOrchestrate(turns, [], 'stellar', answer({}))
    if (plain.outcome !== 'act') throw new Error('expected act')
    expect(plain.read).not.toHaveProperty('followOnRefused')
  })

  it('becomes a sequence, never a plain swap, so the chat refuses it before step 1', () => {
    const said = ['swap 5 sol to usdc then cash out']
    const route = chainRouteFromReading(
      read({ followOnRefused: { kind: 'offramp', venue: '' } }),
      'Swap 5 SOL to USDC',
      said
    )
    expect(route).toMatchObject({ sequence: { followOn: { kind: 'cashout' } } })
    if (route === null || !('sequence' in route)) throw new Error('expected a sequence')
    for (const [chain, name] of [
      ['near', 'NEAR'],
      ['monad', 'Monad'],
    ] as [ChainWithActions, string][]) {
      expect(followOnRefusal(chain, name, route.sequence.followOn, [])).toMatch(
        /Nothing was signed or sent\./
      )
    }
  })

  it('carries a deposit on no venue to the refusal that names the chain', () => {
    const route = chainRouteFromReading(
      read({ followOnRefused: { kind: 'lend', venue: '' } }),
      'Swap 5 SOL to USDC',
      ['swap 5 sol to usdc then deposit']
    )
    if (route === null || !('sequence' in route)) throw new Error('expected a sequence')
    expect(followOnRefusal('monad', 'Monad', route.sequence.followOn, [])).toMatch(/Monad/)
  })

  it('keeps a venue the person named, for the server to refuse, and drops one they did not', () => {
    const named = read({ followOnRefused: { kind: 'lend', venue: 'aave' } })
    expect(
      chainRouteFromReading(named, 'x', ['swap 5 sol to usdc then deposit on aave'])
    ).toMatchObject({ sequence: { followOn: { kind: 'supply', venue: 'aave' } } })
    expect(chainRouteFromReading(named, 'x', ['swap 5 sol to usdc then deposit'])).toEqual({
      sequence: {
        swap: { kind: 'swap', amount: '5', tokenIn: 'SOL', tokenOut: 'USDC', venue: undefined },
        followOn: { kind: 'supply' },
      },
    })
  })

  it('refuses an anchor the person named that cash-outs here do not use', () => {
    const out = chainRouteFromReading(
      read({ followOnRefused: { kind: 'offramp', venue: 'moneygram' } }),
      'x',
      ['swap 5 sol to usdc then cash out with moneygram']
    )
    expect(out).toEqual({
      refusal: "Cash-outs here don't run through moneygram. Nothing was signed or sent.",
    })
  })

  it('is not put off by a "then" with nothing after it', () => {
    expect(
      chainRouteFromReading(read(), 'Swap 5 SOL to USDC', ['swap 5 sol to usdc', 'ok then'])
    ).toMatchObject({
      action: { amount: '5' },
    })
  })

  it('refuses a swap with more after it that nothing here read', () => {
    for (const [instruction, said] of [
      ['Swap 5 SOL to USDC, then send to my friend', 'swap 5 sol to usdc, then send to my friend'],
      ['Swap 5 SOL to USDC', 'i want to swap 5 sol to usdc then send it to my friend'],
    ] as const) {
      const out = chainRouteFromReading(read(), instruction, [said])
      expect(out).toHaveProperty('refusal')
      expect((out as { refusal: string }).refusal).toMatch(/Nothing was signed or sent\.$/)
    }
  })
})

describe('5. a venue the model chose for step 2', () => {
  it('is dropped, and the step kept', () => {
    const sentence = 'Swap 5 SOL to USDC, then deposit on Kamino'
    expect(chainRouteFromReading(read(), sentence, ['swap 5 sol to usdc then deposit'])).toEqual({
      sequence: {
        swap: { kind: 'swap', amount: '5', tokenIn: 'SOL', tokenOut: 'USDC', venue: undefined },
        followOn: { kind: 'supply' },
      },
    })
    const stake = 'Swap 5 SOL to USDC, then stake on Jito'
    expect(chainRouteFromReading(read(), stake, ['swap 5 sol to usdc then stake'])).toMatchObject({
      sequence: { followOn: { kind: 'stake' } },
    })
  })

  it('stays when the person named it', () => {
    const sentence = 'Swap 5 SOL to USDC, then deposit on Jupiter Lend'
    expect(
      chainRouteFromReading(read(), sentence, ['swap 5 sol to usdc then deposit on jupiter-lend'])
    ).toMatchObject({ sequence: { followOn: { kind: 'supply', venue: 'Jupiter Lend' } } })
  })
})

describe('6. offramp on NEAR', () => {
  it('passes the chain, so NEAR is not told to swap first', () => {
    const chat = readFileSync(join(__dirname, '../../components/intents/intent-chat.tsx'), 'utf8')
    expect(chat).toContain('unsupportedTokenReply(route.token, slug)')
    expect(chat).not.toContain('unsupportedTokenReply(route.token)')
  })

  it('reads "offramp 5 near" as that refusal', () => {
    const route = routeCashout({ unsupportedToken: 'NEAR', amount: '5' }, 'near')
    expect(route).toEqual({ kind: 'token', token: 'NEAR' })
  })
})

describe('7. more arriving than the swap should bring', () => {
  const quotedNote = 'More arrived than this swap should bring, so this uses the quoted 5 USDC.'

  it('uses the quoted amount for a send, deposit or stake past 2%', () => {
    expect(stepAmount(SEND, '205', '5')).toEqual({ amount: '5', note: quotedNote })
    for (const followOn of [{ kind: 'supply' }, { kind: 'stake' }] as const) {
      expect(stepAmount({ ...SEND, followOn }, '205', '5')).toEqual({
        amount: '5',
        note: quotedNote,
      })
    }
    expect(stepAmount(SEND, '5.2', '5')).toMatchObject({ amount: '5' })
  })

  it('uses what was measured up to 2% over, and below the quote', () => {
    expect(stepAmount(SEND, '5.1', '5')).toEqual({ amount: '5.1' })
    expect(stepAmount(SEND, '4.9', '5')).toEqual({ amount: '4.9' })
    expect(stepAmount(SEND, '5', '5')).toEqual({ amount: '5' })
  })

  it('uses what was measured with no usable quote', () => {
    expect(stepAmount(SEND, '205', undefined)).toEqual({ amount: '205' })
    expect(stepAmount(SEND, '205', 'about 5')).toEqual({ amount: '205' })
    expect(stepAmount(SEND, '205', '0')).toEqual({ amount: '205' })
  })

  it('leaves a cash-out alone, since its form can be edited', () => {
    expect(stepAmount(CASHOUT, '205', '5')).toEqual({ amount: '205' })
  })

  it('compares at the finer of the two figures', () => {
    expect(stepAmount(SEND, '5.100001', '5')).toMatchObject({ note: expect.any(String) })
    expect(stepAmount(SEND, '5.1', '5.000001')).toEqual({ amount: '5.1' })
  })

  it('makes the button say the amount it will use', () => {
    const { amount } = stepAmount(SEND, '205', '5')
    expect(secondStepLabel(SEND, amount)).toBe('Send 5 USDC')
  })
})

describe('8. a card past its deadline', () => {
  const NOW = Date.parse('2026-11-04T12:00:00.000Z')
  const card = (family: SigningPayload['family']): Pick<PreparedAction, 'signing' | 'context'> => ({
    signing: { family } as SigningPayload,
    context: { deadline: '2026-11-04T11:00:00.000Z' },
  })

  it('stops on a wallet that sends for itself', () => {
    expect(quoteExpiredBeforeSigning(card('near'), NOW)).toBe(true)
    expect(quoteExpiredBeforeSigning(card('evm'), NOW)).toBe(true)
  })

  it('is left to the server where it sends the bytes', () => {
    expect(quoteExpiredBeforeSigning(card('solana'), NOW)).toBe(false)
    expect(quoteExpiredBeforeSigning(card('sui'), NOW)).toBe(false)
  })
})

describe('9. a message and the run', () => {
  const live: SequenceStage[] = ['measuring', 'ready', 'next', 'following']
  const over: SequenceStage[] = ['swap', 'stranded', 'unsettled', 'followed', 'done']

  it('keeps a run with a step still to take, unless the message starts an action', () => {
    for (const stage of live) {
      expect(keepsRun(stage, false)).toBe(true)
      expect(keepsRun(stage, true)).toBe(false)
    }
  })

  it('ends one with nothing left to keep, as before', () => {
    for (const stage of over) expect(keepsRun(stage, false)).toBe(false)
    expect(keepsRun(undefined, false)).toBe(false)
  })

  const of = (text: string): boolean =>
    messageStartsAction({ kind: 'pass' }, readChainMessage(text, 'solana', 'Solana'))

  it('reads what is typed: a question starts nothing, and an instruction does', () => {
    expect(of("what's my balance?")).toBe(false)
    expect(of('what can i do')).toBe(false)
    expect(of('i want to go jogging')).toBe(false)
    expect(of('swap some sol')).toBe(false)
    expect(of('swap 5 SOL to USDC')).toBe(true)
    expect(of('swap 5 SOL to USDC then deposit')).toBe(true)
    expect(of('change 5 SOL into naira')).toBe(true)
  })

  it('reads a refusal as starting nothing, so the button stays', () => {
    expect(of('swap 5 USDC to SOL then cash out')).toBe(false)
    expect(of('swap 5 SOL to euros')).toBe(false)
    expect(messageStartsAction({ kind: 'currency', currency: 'EUR' }, null)).toBe(false)
    expect(messageStartsAction({ kind: 'token', token: 'SOL' }, null)).toBe(false)
  })

  it('reads a cash-out that opens or starts as an action', () => {
    expect(messageStartsAction({ kind: 'ask' }, null)).toBe(true)
    expect(messageStartsAction({ kind: 'open', currency: 'NGN' }, null)).toBe(true)
    expect(messageStartsAction({ kind: 'sequence', token: 'SOL', amount: '5' }, null)).toBe(true)
  })
})

describe('10. the last figure stated', () => {
  const swap = (amount: string) =>
    ({ kind: 'swap', amount, tokenIn: 'SOL', tokenOut: 'USDC', venue: undefined }) as const

  it('takes a correction, and refuses the figure it replaced', () => {
    const said = ['flip 5 SOL to USDC', 'no make it 2']
    expect(requestSaid(swap('2'), said)).toBe(true)
    expect(requestSaid(swap('5'), said)).toBe(false)
  })

  it('takes what is spent over what is held', () => {
    const said = ['I have 5 SOL, flip 3 of it to USDC']
    expect(requestSaid(swap('3'), said)).toBe(true)
    expect(requestSaid(swap('5'), said)).toBe(false)
  })

  it('still reads figures given over several turns', () => {
    expect(requestSaid(swap('5'), ['swap some sol', '5', 'to usdc'])).toBe(true)
    expect(requestSaid(swap('5'), ['swap sol to usdc', '5'])).toBe(true)
  })

  it('still refuses the reverse of what was said, corrected or not', () => {
    const reversed = ['flip 5 USDC to SOL', 'no make it 2']
    expect(requestSaid(swap('2'), reversed)).toBe(false)
    expect(requestSaid({ ...swap('2'), tokenIn: 'USDC', tokenOut: 'SOL' }, reversed)).toBe(true)
    expect(requestSaid(swap('3'), ['I have 5 USDC, flip 3 of it to SOL'])).toBe(false)
  })

  it('takes a correction that names the token, the right way round only', () => {
    expect(requestSaid(swap('3'), ['swap 5 sol to usdc', 'actually 3 sol'])).toBe(true)
    expect(requestSaid(swap('5'), ['swap 5 sol to usdc', 'actually 3 sol'])).toBe(false)
    expect(requestSaid(swap('3'), ['swap 5 usdc to sol', 'actually 3 sol'])).toBe(false)
  })

  it('reads a bare figure backwards as nothing', () => {
    expect(requestSaid(swap('5'), ['swap 5 to sol from usdc'])).toBe(false)
    expect(requestSaid(swap('5'), ['5', 'to sol from usdc'])).toBe(false)
    expect(requestSaid(swap('3'), ['flip 3 of it to sol from usdc'])).toBe(false)
  })

  it('still refuses a figure that stands next to another token', () => {
    expect(requestSaid(swap('5'), ['swap 5 USDT to SOL then USDC'])).toBe(false)
  })

  it('refuses what it cannot decide: a figure spent out of a figure held', () => {
    const said = ['swap 2 of my 5 SOL to USDC']
    expect(requestSaid(swap('2'), said)).toBe(false)
    expect(requestSaid(swap('5'), said)).toBe(false)
  })

  it('does not count a figure for another unit as the last one', () => {
    expect(requestSaid(swap('5'), ['swap 5 SOL to about 800 USDC'])).toBe(true)
    expect(requestSaid(swap('5'), ['swap 5 SOL to USDC with 2% slippage'])).toBe(true)
  })
})

describe('11. sentences that say what is true', () => {
  it('never gives "swap 5 USDC to USDC" as an example', () => {
    const offramp = sequenceFromReading(
      read({ tokenIn: 'USDC', followOn: { kind: 'offramp', venue: 'weave' }, amountStated: false }),
      ['x']
    ) as { refusal: string }
    expect(offramp.refusal).not.toMatch(/USDC to USDC/)
    expect(offramp.refusal).toContain('"cash out 5 USDC"')
    const plain = chainRouteFromReading(
      read({ action: 'supply', tokenIn: 'USDC' }),
      'Supply 5 USDC',
      ['supply it']
    ) as { refusal: string }
    expect(plain.refusal).not.toMatch(/USDC to USDC/)
    expect(plain.refusal).toContain('"5 USDC"')
    const other = sequenceFromReading(
      read({
        tokenIn: 'USDC',
        tokenOut: 'SOL',
        followOn: { kind: 'lend', venue: 'kamino' },
        amountStated: false,
      }),
      ['x']
    ) as { refusal: string }
    expect(other.refusal).toContain('"swap 5 USDC to SOL then deposit"')
  })

  it('labels each follow-on in its example as what it is', () => {
    const typed = ['swap 9 sol to usdc']
    const example = (sentence: string): string =>
      (chainRouteFromReading(read(), sentence, typed) as { refusal: string }).refusal
    expect(example('Swap 5 SOL to USDC, then deposit')).toContain('then deposit"')
    expect(example('Swap 5 SOL to USDC, then stake')).toContain('then stake"')
    expect(example('Swap 5 SOL to USDC, then cash out')).toContain('then cash out"')
    expect(example(`Swap 5 SOL to USDC, then send to ${ADDRESS}`)).toContain(
      'then send to an address"'
    )
  })

  it('says deposit where a person said deposit', () => {
    expect(followOnRefusal('monad', 'Monad', { kind: 'supply' }, [])).toBe(
      'Nothing on Monad can take a deposit yet. Nothing was signed or sent.'
    )
    expect(followOnRefusal('monad', 'Monad', { kind: 'stake' }, [])).toBe(
      'Nothing on Monad can stake yet. Nothing was signed or sent.'
    )
  })
})

describe('12. a currency named in the person words', () => {
  const cash = { kind: 'offramp', venue: 'weave' }

  it('reaches the cash-out, so it is not asked again', () => {
    expect(sequenceFromReading(read({ followOn: cash }), ['turn 5 SOL into naira'])).toMatchObject({
      followOn: { kind: 'cashout', currency: 'NGN' },
    })
  })

  it('reaches it from a written-out sentence too', () => {
    expect(
      chainRouteFromReading(read(), 'Swap 5 SOL to USDC, then cash out', ['turn 5 SOL into kes'])
    ).toMatchObject({ sequence: { followOn: { kind: 'cashout', currency: 'KES' } } })
  })

  it('is asked when none was named, or two were', () => {
    expect(sequenceFromReading(read({ followOn: cash }), ['turn 5 SOL into cash'])).toEqual({
      swap: { kind: 'swap', amount: '5', tokenIn: 'SOL', tokenOut: 'USDC', venue: undefined },
      followOn: { kind: 'cashout' },
    })
    expect(currencyNamedIn(['turn 5 SOL into naira', 'or kes'])).toBeUndefined()
  })

  it('reads whole words, in any turn and any case', () => {
    expect(currencyNamedIn(['turn 5 SOL', 'to my NAIRA'])).toBe('NGN')
    expect(currencyNamedIn(['Kenyan shillings please'])).toBe('KES')
    expect(currencyNamedIn(['bakes a cake'])).toBeUndefined()
    expect(currencyNamedIn(['my nigerian friend'])).toBeUndefined()
  })
})

describe('13. a wallet switch that waits', () => {
  it('says in the comment what happens when the wait ends', () => {
    const chat = readFileSync(join(__dirname, '../../components/intents/intent-chat.tsx'), 'utf8')
    expect(chat).not.toContain("`ready` after it is only a button the new wallet can't use")
  })
})

describe('the parsers a sentence goes through first', () => {
  it('keeps a typed follow-on the strict shape cannot read out of a sequence', () => {
    expect(parseChainSequence('swap 5 sol to usdc then send to my friend')).toBeNull()
  })
})
