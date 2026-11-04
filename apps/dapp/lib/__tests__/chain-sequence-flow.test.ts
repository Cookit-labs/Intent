import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CASHOUT_UNDER_WAY,
  BALANCE_UNREAD,
  BEFORE_RETRY_MS,
  CASHOUT_NOT_STARTED,
  MEASURE_ATTEMPTS,
  MEASURE_INTERVAL_MS,
  SWAP_NEXT_STEP,
  TOO_SMALL_FOR_WEAVE,
  UNCONFIRMED_SWAP,
  beforeReadCounts,
  cashoutSequence,
  currencyStep,
  deliveredLine,
  endedNote,
  followOnNotYet,
  holdingOf,
  keepsBefore,
  measureDelivered,
  moveOnCard,
  outputToken,
  questionAnswerFrom,
  questionChainRefusal,
  quoteNote,
  quoteStep,
  readBeforeSwap,
  readCashoutNote,
  readHolding,
  readyAction,
  sequenceOutcome,
  sequenceWordsMatch,
  stageAfterMeasure,
  stageAfterSwap,
  stageOnCard,
  stageOnForm,
  stepLabels,
  stepMarks,
  swapLine,
  unmeasuredReply,
} from '../chains/sequence-flow'
import { strandedReply, type ChainSequenceRequest } from '../chains/sequence'
import type { WalletBalances } from '../chains/types'
import { accountMismatch } from '../weave/cashout-view'

const ALICE = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'
const BOB = 'BPFLoaderUpgradeab1e11111111111111111111111'
const SOLANA_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const USDC = { symbol: 'USDC', id: SOLANA_USDC, decimals: 6 }

const REQUEST: ChainSequenceRequest = {
  swap: { kind: 'swap', amount: '0.5', tokenIn: 'SOL', tokenOut: 'USDC', venue: undefined },
  followOn: { kind: 'cashout', currency: 'KES' },
}

function balances(partial: Partial<WalletBalances>): WalletBalances {
  return { tokens: [], complete: true, ...partial }
}

function held(id: string, amount: string, symbol = 'USDC') {
  return { symbol, id, amount, decimals: 6, native: false, listed: true }
}

describe('stageAfterSwap', () => {
  it('measures after settled', () => {
    expect(stageAfterSwap('settled')).toBe('measuring')
    expect(stageAfterSwap('settled', false)).toBe('measuring')
  })

  it.each(['idle', 'building', 'review', 'signing', 'submitting'] as const)(
    'has nothing to say while the card is %s',
    (phase) => {
      expect(stageAfterSwap(phase)).toBeUndefined()
      expect(stageAfterSwap(phase, true)).toBeUndefined()
    }
  )

  it('strands a pending step 1, latched or not', () => {
    expect(stageAfterSwap('pending')).toBe('stranded')
    expect(stageAfterSwap('pending', true)).toBe('stranded')
    expect(stageAfterSwap('pending', false)).toBe('stranded')
  })

  it('strands a failure unless told a signature cannot have moved money', () => {
    expect(stageAfterSwap('failed')).toBe('stranded')
    expect(stageAfterSwap('failed', true)).toBe('stranded')
  })

  it('ends plainly on a failure that proves nothing moved', () => {
    expect(stageAfterSwap('failed', false)).toBe('done')
  })
})

describe('stageOnCard', () => {
  it('walks step 1 forward', () => {
    expect(stageOnCard('swap', 'review', false)).toBe('swap')
    expect(stageOnCard('swap', 'settled', true)).toBe('measuring')
    expect(stageOnCard('swap', 'pending', true)).toBe('stranded')
    expect(stageOnCard('swap', 'failed', true)).toBe('stranded')
    expect(stageOnCard('swap', 'failed', false)).toBe('done')
  })

  it('lets a clean failure be retried on the same race, so it is not stuck', () => {
    expect(stageOnCard('done', 'failed', false)).toBe('done')
    expect(stageOnCard('done', 'idle', false)).toBe('done')
    expect(stageOnCard('done', 'building', false)).toBe('swap')
    expect(stageOnCard('done', 'review', false)).toBe('swap')
    expect(stageOnCard('swap', 'settled', true)).toBe('measuring')
  })

  it('never moves on from what is already known, whatever the card does next', () => {
    for (const stage of ['measuring', 'ready', 'next', 'stranded'] as const) {
      for (const phase of ['idle', 'building', 'review', 'settled', 'pending', 'failed'] as const) {
        expect(stageOnCard(stage, phase, true)).toBe(stage)
      }
    }
  })

  it('never reaches ready from a pending step 1, on any path', () => {
    let stage = stageOnCard('swap', 'pending', true)
    for (const phase of ['idle', 'pending', 'settled', 'review', 'building'] as const) {
      stage = stageOnCard(stage, phase, true)
      expect(stage).toBe('stranded')
    }
  })
})

describe('moveOnCard', () => {
  const START = { stage: 'swap', settled: false } as const

  it('stays put while the card is open', () => {
    for (const phase of ['idle', 'building', 'review', 'signing', 'submitting'] as const) {
      expect(moveOnCard(START, phase, true, true, REQUEST)).toBe(START)
    }
  })

  it('measures after settled when the balance before the swap is known', () => {
    expect(moveOnCard(START, 'settled', true, true, REQUEST)).toEqual({
      stage: 'measuring',
      settled: true,
    })
  })

  it('goes straight to stranded after settled when it is not, guessing nothing', () => {
    const moved = moveOnCard(START, 'settled', true, false, REQUEST)
    expect(moved).toEqual({
      stage: 'stranded',
      settled: true,
      error: unmeasuredReply(REQUEST),
    })
    expect(moved.error).toContain('The swap went through')
    expect(moved.error).toContain('Nothing was paid out.')
    expect(moved.error).not.toMatch(/\d/)
  })

  it('never says the swap went through for a pending step 1', () => {
    const moved = moveOnCard(START, 'pending', true, true, REQUEST)
    expect(moved).toEqual({ stage: 'stranded', settled: false, error: UNCONFIRMED_SWAP })
    expect(moved.error).not.toMatch(/went through/i)
  })

  it('never says it for a wallet error after sending either, and tells them to check', () => {
    const moved = moveOnCard(START, 'failed', true, true, REQUEST)
    expect(moved).toEqual({ stage: 'stranded', settled: false, error: UNCONFIRMED_SWAP })
    expect(moved.error).toMatch(/check your wallet/i)
  })

  it('ends plainly on a clean failure, then comes back up on a retry', () => {
    const failed = moveOnCard(START, 'failed', false, false, REQUEST)
    expect(failed).toEqual({ stage: 'done', settled: false, error: CASHOUT_NOT_STARTED })
    expect(failed.error).not.toMatch(/went through/i)
    expect(moveOnCard(failed, 'idle', false, false, REQUEST)).toBe(failed)
    const retried = moveOnCard(failed, 'review', false, true, REQUEST)
    expect(retried).toEqual({ stage: 'swap', settled: false })
    expect(moveOnCard(retried, 'settled', true, true, REQUEST).stage).toBe('measuring')
  })

  it('leaves a swap that settled alone, whatever the card does next', () => {
    const measuring = { stage: 'measuring', settled: true } as const
    const finished = { stage: 'done', settled: true } as const
    for (const phase of ['idle', 'building', 'review', 'failed', 'pending'] as const) {
      expect(moveOnCard(measuring, phase, true, true, REQUEST)).toBe(measuring)
      expect(moveOnCard(finished, phase, false, true, REQUEST)).toBe(finished)
    }
  })

  it('never offers step 2 after a pending step 1, even if the card later says settled', () => {
    const stranded = moveOnCard(START, 'pending', true, true, REQUEST)
    expect(moveOnCard(stranded, 'settled', true, true, REQUEST)).toBe(stranded)
  })
})

describe('stageOnForm', () => {
  const closed = { open: false, locked: false, paid: false }
  const open = { open: true, locked: false, paid: false }

  it('goes back to ready when the form is left, so it can be pressed again', () => {
    expect(stageOnForm('next', closed)).toBe('ready')
  })

  it('stays while the form is open', () => {
    expect(stageOnForm('next', open)).toBe('next')
  })

  it('is finished the moment a cash-out is under way, so the button cannot return', () => {
    expect(stageOnForm('next', { ...open, locked: true })).toBe('done')
    expect(stageOnForm('next', { ...open, paid: true })).toBe('done')
    expect(stageOnForm('next', { ...closed, paid: true })).toBe('done')
  })

  it('touches no other stage', () => {
    for (const stage of ['swap', 'measuring', 'ready', 'stranded', 'done'] as const) {
      expect(stageOnForm(stage, { ...open, locked: true })).toBe(stage)
    }
  })
})

describe('stageAfterMeasure', () => {
  it('is ready as soon as an amount is measured', () => {
    expect(stageAfterMeasure('5', 1, 20)).toBe('ready')
    expect(stageAfterMeasure('5', 20, 20)).toBe('ready')
  })

  it('keeps looking before the limit and strands at it', () => {
    expect(stageAfterMeasure(undefined, 1, 20)).toBe('keep')
    expect(stageAfterMeasure(undefined, 19, 20)).toBe('keep')
    expect(stageAfterMeasure(undefined, 20, 20)).toBe('stranded')
  })

  it('polls for the bound the brief sets', () => {
    expect(MEASURE_INTERVAL_MS).toBe(3_000)
    expect(MEASURE_ATTEMPTS).toBe(20)
  })
})

describe('outputToken', () => {
  it('finds the id from the table, on each chain a cash-out runs from', () => {
    expect(outputToken('solana', 'USDC', 'USDC')?.id).toBe(SOLANA_USDC)
    expect(outputToken('sui', 'USDC', 'usdc')?.id).toBe(
      '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'
    )
    expect(outputToken('avalanche', 'USDC', 'USDC')?.id).toBe(
      '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E'
    )
  })

  it('knows nothing it cannot be sure of', () => {
    expect(outputToken('solana', undefined, 'USDC')).toBeUndefined()
    expect(outputToken('solana', 'USDC', undefined)).toBeUndefined()
    expect(outputToken('solana', 'USDT', 'USDC')).toBeUndefined()
    expect(outputToken('solana', 'FAKE', 'FAKE')).toBeUndefined()
    expect(outputToken('solana', 'usdc', 'usdc')?.id).toBe(SOLANA_USDC)
    expect(outputToken('stellar', 'USDC', 'USDC')).toBeUndefined()
  })
})

describe('holdingOf', () => {
  it('matches on id, never on symbol', () => {
    const read = balances({
      tokens: [held('Copycat111', '999', 'USDC'), held(SOLANA_USDC, '1.5')],
    })
    expect(holdingOf(read, USDC)).toBe('1.5')
    expect(holdingOf(balances({ tokens: [held('Copycat111', '999', 'USDC')] }), USDC)).toBe('0')
  })

  it('reads a token missing from a complete answer as none held', () => {
    expect(holdingOf(balances({}), USDC)).toBe('0')
  })

  it('does not read a token missing from an incomplete answer as zero', () => {
    expect(holdingOf(balances({ complete: false }), USDC)).toBeUndefined()
    expect(holdingOf(balances({ complete: false, unread: ['USDC'] }), USDC)).toBeUndefined()
    expect(holdingOf(balances({ unread: ['USDC'] }), USDC)).toBeUndefined()
  })

  it('still reads a token present in an incomplete answer', () => {
    const read = balances({ complete: false, knownOnly: true, tokens: [held(SOLANA_USDC, '2')] })
    expect(holdingOf(read, USDC)).toBe('2')
  })
})

describe('readHolding', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const signal = new AbortController().signal

  function answering(status: number, body: unknown): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status }))
    )
  }

  it('asks the chain route for this account, uncached', async () => {
    answering(200, balances({ tokens: [held(SOLANA_USDC, '4')] }))
    expect(await readHolding('solana', ALICE, USDC, signal)).toBe('4')
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`/api/chain/solana/balances?account=${ALICE}`)
    expect(init.cache).toBe('no-store')
  })

  it('reads nothing from a 503 and from an answer of the wrong shape', async () => {
    answering(503, { error: 'balances_unavailable' })
    expect(await readHolding('solana', ALICE, USDC, signal)).toBeUndefined()
    answering(200, { tokens: 'none' })
    expect(await readHolding('solana', ALICE, USDC, signal)).toBeUndefined()
  })

  it('reads nothing when the request throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      })
    )
    expect(await readHolding('solana', ALICE, USDC, signal)).toBeUndefined()
  })
})

describe('beforeReadCounts', () => {
  it('trusts a read that lands while the card is being built or is on offer', () => {
    expect(beforeReadCounts('building', undefined)).toBe(true)
    expect(beforeReadCounts('review', 'solana')).toBe(true)
    expect(beforeReadCounts('review', 'evm')).toBe(true)
  })

  it('does not trust one that lands in the wallet when the wallet is not known', () => {
    expect(beforeReadCounts('signing', undefined)).toBe(false)
  })

  it('trusts one that lands in the wallet only where the wallet sends nothing itself', () => {
    expect(beforeReadCounts('signing', 'solana')).toBe(true)
    expect(beforeReadCounts('signing', 'sui')).toBe(true)
    expect(beforeReadCounts('signing', 'evm')).toBe(false)
    expect(beforeReadCounts('signing', 'near')).toBe(false)
  })

  it.each(['submitting', 'settled', 'pending', 'failed', 'idle'] as const)(
    'does not trust one that lands at %s',
    (phase) => {
      expect(beforeReadCounts(phase, 'solana')).toBe(false)
    }
  )
})

describe('measureDelivered', () => {
  const noWait = async (): Promise<void> => {}

  function reads(answers: (string | undefined)[]): {
    read: () => Promise<string | undefined>
    count: () => number
    most: () => number
  } {
    let count = 0
    let open = 0
    let most = 0
    return {
      read: async () => {
        open += 1
        most = Math.max(most, open)
        await Promise.resolve()
        open -= 1
        const answer = answers[Math.min(count, answers.length - 1)]
        count += 1
        return answer
      },
      count: () => count,
      most: () => most,
    }
  }

  function args(read: () => Promise<string | undefined>, signal = new AbortController().signal) {
    return { before: '1', decimals: 6, read, signal, wait: noWait }
  }

  it('measures the rise, not the balance', async () => {
    const source = reads(['1', '1', '3.5'])
    expect(await measureDelivered(args(source.read))).toEqual({
      stage: 'ready',
      delivered: '2.5',
    })
    expect(source.count()).toBe(3)
  })

  it('strands with no amount when the balance never rises, after the limit and no further', async () => {
    const source = reads(['1'])
    expect(await measureDelivered(args(source.read))).toEqual({ stage: 'stranded' })
    expect(source.count()).toBe(MEASURE_ATTEMPTS)
  })

  it('counts a failed read as an attempt and does not end early on one', async () => {
    const source = reads([undefined, undefined, '6'])
    expect(await measureDelivered(args(source.read))).toEqual({ stage: 'ready', delivered: '5' })
    const failing = reads([undefined])
    expect(await measureDelivered(args(failing.read))).toEqual({ stage: 'stranded' })
    expect(failing.count()).toBe(MEASURE_ATTEMPTS)
  })

  it('never has two reads open at once', async () => {
    const source = reads(['1'])
    await measureDelivered(args(source.read))
    expect(source.most()).toBe(1)
  })

  it('waits the interval between reads and not after the last', async () => {
    const source = reads(['1', '2'])
    const wait = vi.fn(async () => {})
    await measureDelivered({ ...args(source.read), wait })
    expect(wait).toHaveBeenCalledTimes(1)
    expect(wait.mock.calls[0]).toEqual([MEASURE_INTERVAL_MS, expect.anything()])
  })

  it('stops reading once aborted, and decides nothing', async () => {
    const stop = new AbortController()
    const source = reads(['1'])
    const wait = vi.fn(async () => {
      stop.abort()
    })
    const result = await measureDelivered({ ...args(source.read, stop.signal), wait })
    expect(result).toBeUndefined()
    expect(source.count()).toBe(1)
  })

  it('ignores an answer that lands after the abort', async () => {
    const stop = new AbortController()
    const result = await measureDelivered(
      args(async () => {
        stop.abort()
        return '9'
      }, stop.signal)
    )
    expect(result).toBeUndefined()
  })
})

describe('readyAction', () => {
  it('opens the form at the measured amount, less the room Weave may take', () => {
    expect(readyAction('10.2', false, ALICE, ALICE)).toEqual({ kind: 'open', amount: '10' })
    expect(readyAction('5', false, ALICE, ALICE)).toEqual({ kind: 'open', amount: '4.9' })
  })

  it('offers nothing for an amount too small to cash out, and says what arrived', () => {
    const action = readyAction('0.005', false, ALICE, ALICE)
    expect(action.kind).toBe('too-small')
    expect(action).toMatchObject({ message: deliveredLine('0.005') })
    expect(deliveredLine('0.005')).toContain('0.005 USDC')
    expect(deliveredLine('0.005')).toContain('too small')
  })

  it('says a locked cash-out rather than letting the open return silently', () => {
    expect(readyAction('5', true, ALICE, ALICE)).toEqual({
      kind: 'refused',
      message: CASHOUT_UNDER_WAY,
    })
  })

  it('refuses another wallet with the existing sentence', () => {
    expect(readyAction('5', false, BOB, ALICE)).toEqual({
      kind: 'refused',
      message: accountMismatch(BOB, ALICE),
    })
  })

  it('refuses a disconnected wallet too', () => {
    expect(readyAction('5', false, undefined, ALICE)).toEqual({
      kind: 'refused',
      message: accountMismatch(undefined, ALICE),
    })
  })

  it('reads hex addresses without regard to case', () => {
    const lower = '0xabcdef0123456789abcdef0123456789abcdef01'
    const upper = '0xABCDEF0123456789ABCDEF0123456789ABCDEF01'
    expect(readyAction('5', false, upper, lower).kind).toBe('open')
  })
})

describe('what is said', () => {
  it('words a step 1 that is not confirmed without claiming it went through', () => {
    expect(UNCONFIRMED_SWAP).not.toMatch(/went through/i)
    expect(UNCONFIRMED_SWAP).toMatch(/check your wallet/i)
    expect(UNCONFIRMED_SWAP).toMatch(/will not start/i)
    expect(UNCONFIRMED_SWAP).toMatch(/nothing was paid out/i)
    expect(UNCONFIRMED_SWAP).not.toContain('—')
  })

  it('records one sentence per ending, and nothing mid-way', () => {
    expect(sequenceOutcome('swap', undefined, undefined)).toBeUndefined()
    expect(sequenceOutcome('measuring', undefined, undefined)).toBeUndefined()
    expect(sequenceOutcome('next', '5', undefined)).toBeUndefined()
    expect(sequenceOutcome('ready', '5', undefined)).toBe(deliveredLine('5'))
    expect(sequenceOutcome('stranded', undefined, UNCONFIRMED_SWAP)).toBe(UNCONFIRMED_SWAP)
    expect(sequenceOutcome('done', undefined, 'Ended.')).toBe('Ended.')
  })

  it('does not record a refused press in place of what arrived', () => {
    expect(sequenceOutcome('ready', '5', accountMismatch(BOB, ALICE))).toBe(deliveredLine('5'))
  })

  it('says step 2 did not run when a new message ends a swap that settled', () => {
    expect(endedNote('ready', '5', REQUEST)).toBe(strandedReply('USDC', '5', REQUEST.followOn))
    expect(endedNote('next', '5', REQUEST)).toBe(strandedReply('USDC', '5', REQUEST.followOn))
    expect(endedNote('measuring', undefined, REQUEST)).toBe(
      strandedReply('USDC', undefined, REQUEST.followOn)
    )
    expect(endedNote('ready', '5', REQUEST)).toContain('Nothing was paid out.')
  })

  it('says nothing more where nothing settled or all is already said', () => {
    for (const stage of ['swap', 'stranded', 'done'] as const) {
      expect(endedNote(stage, undefined, REQUEST)).toBeUndefined()
    }
    expect(endedNote(undefined, undefined, null)).toBeUndefined()
  })
})

describe('stepLabels', () => {
  it('names both steps', () => {
    expect(stepLabels(REQUEST)).toEqual(['Swap 0.5 SOL to USDC', 'Cash out to KES'])
  })

  it('reads the same however the token was typed', () => {
    const typed: ChainSequenceRequest = {
      swap: { kind: 'swap', amount: '2', tokenIn: 'sol', tokenOut: 'usdc' },
      followOn: { kind: 'cashout' },
    }
    expect(stepLabels(typed)).toEqual(['Swap 2 SOL to USDC', 'Cash out'])
  })
})

describe('stepMarks', () => {
  it('shows step 1 in progress before anything is signed', () => {
    expect(stepMarks('swap', false)).toEqual(['now', 'waiting'])
  })

  it('moves to step 2 only once it is on offer', () => {
    expect(stepMarks('measuring', true)).toEqual(['done', 'waiting'])
    expect(stepMarks('ready', true)).toEqual(['done', 'now'])
    expect(stepMarks('next', true)).toEqual(['done', 'now'])
  })

  it('does not tick a step 1 nobody can vouch for', () => {
    expect(stepMarks('stranded', false)).toEqual(['stopped', 'stopped'])
    expect(stepMarks('done', false)).toEqual(['stopped', 'stopped'])
  })

  it('ticks a step 1 that settled, even when step 2 can go no further', () => {
    expect(stepMarks('stranded', true)).toEqual(['done', 'stopped'])
  })

  it('does not tick a cash-out that is only under way, since the payout has not landed', () => {
    expect(stepMarks('done', true)).toEqual(['done', 'now'])
  })
})

describe('cashoutSequence', () => {
  it('turns a cash-out of another token into a swap to USDC', () => {
    expect(
      cashoutSequence({ kind: 'sequence', token: 'SOL', amount: '5', currency: 'KES' })
    ).toEqual({
      swap: { kind: 'swap', amount: '5', tokenIn: 'SOL', tokenOut: 'USDC', venue: undefined },
      followOn: { kind: 'cashout', currency: 'KES' },
    })
  })

  it('leaves the currency open when none was named', () => {
    expect(cashoutSequence({ kind: 'sequence', token: 'SOL', amount: '5' }).followOn).toEqual({
      kind: 'cashout',
    })
  })
})

describe('currencyStep', () => {
  const KES = { code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', country: 'KE' }
  const NGN = { code: 'NGN', name: 'Nigerian Naira', symbol: 'N', country: 'NG' }

  it('refuses before signing when nothing pays out', () => {
    expect(currencyStep(undefined, [])).toEqual({
      kind: 'refuse',
      message: "Cash-outs aren't available right now.",
    })
    expect(currencyStep('KES', []).kind).toBe('refuse')
  })

  it('refuses before signing a currency this chain does not pay', () => {
    const step = currencyStep('UGX', [KES, NGN])
    expect(step.kind).toBe('refuse')
    expect(step).toMatchObject({ message: expect.stringContaining('UGX') })
  })

  it('runs a named currency that is offered', () => {
    expect(currencyStep('KES', [KES, NGN])).toEqual({ kind: 'run', currency: 'KES' })
  })

  it('runs the only currency there is, and asks otherwise', () => {
    expect(currencyStep(undefined, [KES])).toEqual({ kind: 'run', currency: 'KES' })
    expect(currencyStep(undefined, [KES, NGN])).toEqual({ kind: 'ask', choices: [KES, NGN] })
  })
})

describe('followOnNotYet', () => {
  it('lets a cash-out through', () => {
    expect(followOnNotYet({ kind: 'cashout' })).toBeUndefined()
  })

  it.each([
    [{ kind: 'supply' as const }],
    [{ kind: 'stake' as const }],
    [{ kind: 'send' as const, recipient: ALICE }],
  ])('says not yet for %j, with nothing signed', (followOn) => {
    expect(followOnNotYet(followOn)).toMatch(/not yet/i)
    expect(followOnNotYet(followOn)).toContain('Nothing was signed or sent.')
  })
})

describe('sequenceWordsMatch', () => {
  const asked = { amount: '5', token: 'SOL' }

  it('finds the amount and the token in what the person typed', () => {
    expect(sequenceWordsMatch(asked, ['please cash out 5 SOL'])).toBe(true)
    expect(sequenceWordsMatch(asked, ['get my sol to my bank', '5'])).toBe(true)
    expect(sequenceWordsMatch(asked, ['5sol to my bank'])).toBe(true)
    expect(sequenceWordsMatch(asked, ['sell SOL, 5 of it.'])).toBe(true)
  })

  it('compares numbers, not text', () => {
    expect(sequenceWordsMatch(asked, ['cash out 5.0 SOL'])).toBe(true)
    expect(sequenceWordsMatch({ amount: '5.0', token: 'SOL' }, ['cash out 5 SOL'])).toBe(true)
    expect(sequenceWordsMatch({ amount: '0.5', token: 'SOL' }, ['cash out .5 SOL'])).toBe(true)
    expect(sequenceWordsMatch({ amount: '1000', token: 'SOL' }, ['cash 1,000 sol'])).toBe(true)
  })

  it('refuses a different amount', () => {
    expect(sequenceWordsMatch({ amount: '12', token: 'SOL' }, ['get my SOL to my bank'])).toBe(
      false
    )
    expect(sequenceWordsMatch(asked, ['cash out 6 SOL'])).toBe(false)
  })

  it.each(['cash out 15 SOL', 'cash out 0.5 SOL', 'cash out 5.5 SOL', 'cash out 55 SOL'])(
    'does not find 5 inside another number: %s',
    (said) => {
      expect(sequenceWordsMatch(asked, [said])).toBe(false)
    }
  )

  it.each([
    'cash out $5 of SOL',
    'cash out $ 5 of SOL',
    'cash out ₦5 of SOL',
    'cash out 5 dollars of SOL',
    'cash out 5 usd of my sol',
    '5k SOL',
    '5% of my SOL',
  ])('does not take a figure of something else for an amount of the token: %s', (said) => {
    expect(sequenceWordsMatch(asked, [said])).toBe(false)
  })

  it('reads a chain name as its token, both ways round', () => {
    expect(sequenceWordsMatch(asked, ['cash out 5 solana'])).toBe(true)
    expect(sequenceWordsMatch(asked, ['cash out 5solana'])).toBe(true)
    expect(sequenceWordsMatch(asked, ['get my Solana to my bank', '5'])).toBe(true)
    expect(sequenceWordsMatch({ amount: '5', token: 'SOLANA' }, ['cash out 5 sol'])).toBe(true)
    expect(sequenceWordsMatch({ amount: '5', token: 'SOLANA' }, ['cash out 5 solana'])).toBe(true)
    expect(sequenceWordsMatch({ amount: '5', token: 'AVAX' }, ['cash out 5 avalanche'])).toBe(true)
    expect(sequenceWordsMatch({ amount: '5', token: 'MON' }, ['cash out 5 monad'])).toBe(true)
  })

  it('does not read one chain name as another token, or a longer word as a chain name', () => {
    expect(sequenceWordsMatch({ amount: '5', token: 'AVAX' }, ['cash out 5 solana'])).toBe(false)
    expect(sequenceWordsMatch(asked, ['cash out 5 solanax'])).toBe(false)
    expect(sequenceWordsMatch(asked, ['cash out 5 SOLfoo'])).toBe(false)
  })

  it.each([
    'cash out 5 USDT on solana',
    'cash out 5 USDT on my Solana',
    'cash out 5 USDT from the solana chain',
    'cash out 5 USDT in solana',
    'send 5 USDT from my solana wallet to my bank',
    'cash out 5 USDT, my solana account',
  ])('does not take a chain named as a place for the token: %s', (said) => {
    expect(sequenceWordsMatch(asked, [said])).toBe(false)
  })

  it('still reads the symbol itself after such a word', () => {
    expect(sequenceWordsMatch(asked, ['cash out 5 sol on solana'])).toBe(true)
  })

  it('refuses a token only the model named, since only the person is passed in', () => {
    expect(sequenceWordsMatch(asked, ['put 5 into my bank'])).toBe(false)
    expect(sequenceWordsMatch(asked, [])).toBe(false)
  })

  it('escapes a token, so its symbols are read as themselves', () => {
    expect(sequenceWordsMatch({ amount: '5', token: 'USD+' }, ['cash out 5 USD+'])).toBe(true)
    expect(sequenceWordsMatch({ amount: '5', token: 'USD+' }, ['cash out 5 USDD'])).toBe(false)
  })
})

describe('readBeforeSwap', () => {
  const noWait = async (): Promise<void> => {}

  it('reads once when the first answers', async () => {
    const read = vi.fn(async () => '3')
    expect(await readBeforeSwap(read, () => true, noWait)).toBe('3')
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('tries once more after the pause while the card is unsigned', async () => {
    const read = vi.fn<() => Promise<string | undefined>>()
    read.mockResolvedValueOnce(undefined).mockResolvedValueOnce('3')
    const wait = vi.fn(noWait)
    expect(await readBeforeSwap(read, () => true, wait)).toBe('3')
    expect(read).toHaveBeenCalledTimes(2)
    expect(wait).toHaveBeenCalledWith(BEFORE_RETRY_MS)
    expect(BEFORE_RETRY_MS).toBe(1_500)
  })

  it('tries only once more', async () => {
    const read = vi.fn(async () => undefined)
    expect(await readBeforeSwap(read, () => true, noWait)).toBeUndefined()
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('does not retry once the card has moved on', async () => {
    const read = vi.fn(async () => undefined)
    expect(await readBeforeSwap(read, () => false, noWait)).toBeUndefined()
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('does not retry if the card moves on during the pause', async () => {
    const read = vi.fn(async () => undefined)
    let open = true
    const wait = async (): Promise<void> => {
      open = false
    }
    expect(await readBeforeSwap(read, () => open, wait)).toBeUndefined()
    expect(read).toHaveBeenCalledTimes(1)
  })
})

describe('keepsBefore', () => {
  const token = { symbol: 'USDC', id: SOLANA_USDC, decimals: 6 }

  it('keeps a read under way or known for this wallet and token, so a decline reads nothing again', () => {
    expect(keepsBefore({ status: 'reading', account: ALICE, token }, ALICE, SOLANA_USDC)).toBe(true)
    expect(
      keepsBefore({ status: 'known', amount: '1', account: ALICE, token }, ALICE, SOLANA_USDC)
    ).toBe(true)
  })

  it('reads again for another wallet, another token, or after a read that failed', () => {
    expect(keepsBefore({ status: 'reading', account: ALICE, token }, BOB, SOLANA_USDC)).toBe(false)
    expect(keepsBefore({ status: 'reading', account: ALICE, token }, ALICE, 'other')).toBe(false)
    expect(keepsBefore({ status: 'unknown' }, ALICE, SOLANA_USDC)).toBe(false)
  })
})

describe('swapLine', () => {
  it('says step 2 follows while nothing says otherwise', () => {
    expect(swapLine('idle', 'unknown', undefined)).toBe(SWAP_NEXT_STEP)
    expect(swapLine('building', 'reading', undefined)).toBe(SWAP_NEXT_STEP)
    expect(swapLine('building', 'unknown', undefined)).toBe(SWAP_NEXT_STEP)
    expect(swapLine('review', 'reading', undefined)).toBe(SWAP_NEXT_STEP)
    expect(swapLine('review', 'known', undefined)).toBe(SWAP_NEXT_STEP)
  })

  it('does not promise step 2 on a card whose balance could not be read', () => {
    expect(swapLine('review', 'unknown', undefined)).toBe(BALANCE_UNREAD)
    expect(swapLine('signing', 'unknown', undefined)).toBe(BALANCE_UNREAD)
    expect(BALANCE_UNREAD).toBe(
      'I could not read your USDC balance, so if you sign this swap the cash-out will not follow. You would hold the USDC and can cash it out yourself.'
    )
  })

  it('shows a refused size in its place', () => {
    expect(swapLine('review', 'known', 'Too small.')).toBe('Too small.')
    expect(swapLine('review', 'reading', 'Too small.')).toBe('Too small.')
  })

  it('says the unread balance first, since no size matters without it', () => {
    expect(swapLine('review', 'unknown', 'Too small.')).toBe(BALANCE_UNREAD)
  })
})

describe('quoteStep', () => {
  it('asks about what the button would open, not the whole receive', () => {
    expect(quoteStep('10.2')).toEqual({ kind: 'ask', amount: '10' })
  })

  it('needs no answer for an amount that rounds to nothing or cannot be read', () => {
    expect(quoteStep('0.005')).toEqual({ kind: 'note', note: TOO_SMALL_FOR_WEAVE })
    expect(quoteStep('about five')).toEqual({ kind: 'note', note: TOO_SMALL_FOR_WEAVE })
  })

  it('says nothing with no amount on the card', () => {
    expect(quoteStep(undefined)).toEqual({ kind: 'none' })
  })
})

describe('quoteNote', () => {
  it('says nothing for a quote Weave would take', () => {
    expect(quoteNote(200, { costPercent: 1 })).toBeUndefined()
    expect(quoteNote(200, { costPercent: 5 })).toBeUndefined()
  })

  it('says so past the cost the order route refuses at', () => {
    expect(quoteNote(200, { costPercent: 5.01 })).toBe(TOO_SMALL_FOR_WEAVE)
    expect(TOO_SMALL_FOR_WEAVE).toBe(
      'Weave would refuse a cash-out this small, so this swap would leave you holding the USDC.'
    )
  })

  it('uses a refusal in the route own plain words, and what it means here', () => {
    const message = 'No price is available for this cash-out right now. No money has moved.'
    expect(quoteNote(422, { error: 'rejected', message })).toBe(
      `${message} This swap would leave you holding the USDC.`
    )
  })

  it('falls back when a refusal has no plain words', () => {
    expect(quoteNote(422, { error: 'rejected' })).toBe(TOO_SMALL_FOR_WEAVE)
    expect(quoteNote(422, { message: 'E_MIN' })).toBe(TOO_SMALL_FOR_WEAVE)
    expect(quoteNote(422, { message: '<html>not a sentence</html>' })).toBe(TOO_SMALL_FOR_WEAVE)
  })

  it('says so for an amount the route cannot read', () => {
    expect(quoteNote(400, { error: 'invalid_amount', message: 'Enter an amount.' })).toBe(
      TOO_SMALL_FOR_WEAVE
    )
  })

  it.each([
    [503, { error: 'unavailable', message: 'Cash-outs are busy right now.' }],
    [429, { error: 'rate_limited' }],
    [401, { error: 'unauthenticated', message: 'Connect your wallet to cash out.' }],
    [400, { error: 'unknown_currency', message: 'This chain does not cash out to that currency.' }],
    [200, {}],
  ])('adds nothing for %i %j, which says nothing about the size', (status, body) => {
    expect(quoteNote(status, body)).toBeUndefined()
  })
})

describe('readCashoutNote', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('asks the quote route for this chain, currency and amount, and reads the refusal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'rejected' }), { status: 422 }))
    )
    expect(await readCashoutNote('solana', 'KES', '1.4')).toBe(TOO_SMALL_FOR_WEAVE)
    const [url] = vi.mocked(fetch).mock.calls[0] as [string]
    expect(url).toBe('/api/cashout/quote?chain=solana&currency=KES&amount=1.4')
  })

  it('adds nothing when the read fails or is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      })
    )
    expect(await readCashoutNote('solana', 'KES', '1.4')).toBeUndefined()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>', { status: 200 }))
    )
    expect(await readCashoutNote('solana', 'KES', '1.4')).toBeUndefined()
  })
})

describe('questionAnswerFrom', () => {
  const sequence = { request: REQUEST, chain: 'solana' }
  const open = { sequence }

  it('reads "cash out to KES" as the answer to the swap waiting on it', () => {
    expect(questionAnswerFrom(open, { kind: 'open', currency: 'KES' })).toBe('KES')
  })

  it('does not take a request with its own amount for an answer', () => {
    expect(questionAnswerFrom(open, { kind: 'open', amount: '5', currency: 'KES' })).toBeUndefined()
  })

  it('leaves every other route alone', () => {
    expect(questionAnswerFrom(open, { kind: 'pass' })).toBeUndefined()
    expect(questionAnswerFrom(open, { kind: 'ask' })).toBeUndefined()
    expect(questionAnswerFrom(open, { kind: 'open' })).toBeUndefined()
    expect(questionAnswerFrom(open, { kind: 'currency', currency: 'USD' })).toBeUndefined()
  })

  it('leaves a plain question, an answered one and no question alone', () => {
    const route = { kind: 'open', currency: 'KES' } as const
    expect(questionAnswerFrom({}, route)).toBeUndefined()
    expect(questionAnswerFrom({ sequence, answer: 'Kenya' }, route)).toBeUndefined()
    expect(questionAnswerFrom(null, route)).toBeUndefined()
  })
})

describe('questionChainRefusal', () => {
  it('lets an answer through on the chain it was asked on', () => {
    expect(questionChainRefusal('avalanche', 'avalanche')).toBeUndefined()
  })

  it('refuses one from another chain, with nothing signed', () => {
    const refusal = questionChainRefusal('avalanche', 'monad')
    expect(refusal).toContain('another chain')
    expect(refusal).toContain('Nothing was signed or sent.')
  })
})
