import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CASHOUT_UNDER_WAY,
  CASHOUT_NOT_STARTED,
  MEASURE_ATTEMPTS,
  MEASURE_INTERVAL_MS,
  UNCONFIRMED_SWAP,
  beforeReadCounts,
  cashoutSequence,
  currencyStep,
  deliveredLine,
  endedNote,
  followOnNotYet,
  holdingOf,
  measureDelivered,
  moveOnCard,
  outputToken,
  readHolding,
  readyAction,
  sequenceOutcome,
  stageAfterMeasure,
  stageAfterSwap,
  stageOnCard,
  stageOnForm,
  stepLabels,
  stepMarks,
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
  it('trusts a read that lands while the card is still on offer', () => {
    expect(beforeReadCounts('review', 'solana')).toBe(true)
    expect(beforeReadCounts('review', 'evm')).toBe(true)
  })

  it('trusts one that lands in the wallet only where the wallet sends nothing itself', () => {
    expect(beforeReadCounts('signing', 'solana')).toBe(true)
    expect(beforeReadCounts('signing', 'sui')).toBe(true)
    expect(beforeReadCounts('signing', 'evm')).toBe(false)
    expect(beforeReadCounts('signing', 'near')).toBe(false)
  })

  it.each(['submitting', 'settled', 'pending', 'failed', 'idle', 'building'] as const)(
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
