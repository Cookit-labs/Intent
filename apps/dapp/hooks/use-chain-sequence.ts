'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import type { ChainSequenceRequest } from '../lib/chains/sequence'
import {
  beforeReadCounts,
  keepsBefore,
  measureDelivered,
  moveOnCard,
  moveOnSecond,
  nextRequest,
  outputToken,
  quoteStep,
  readBeforeSwap,
  readCashoutNote,
  readHolding,
  readyAction,
  secondStepPress,
  stageOnForm,
  stepLabels,
  swapLine,
  unmeasuredReply,
  type Before,
  type BeforeStatus,
  type SequenceProgress,
  type SequenceStage,
} from '../lib/chains/sequence-flow'
import type { ChainToken } from '../lib/chains/types'
import { useChain } from '../providers/chain-provider'
import type { ChainAction } from './use-chain-action'
import type { Cashout } from './use-cashout'
import { useWallet } from './use-wallet'

interface Run extends SequenceProgress {
  request: ChainSequenceRequest
  delivered?: string
  /** The wallet step 1 was built for, once it has settled. */
  account?: string
}

const UNKNOWN: Before = { status: 'unknown' }

export interface ChainSequence {
  sequence: ChainSequenceRequest | null
  stage: SequenceStage | undefined
  /** What the chain shows arrived, in display units. Never a quote and never a guess. */
  delivered: string | undefined
  error: string | undefined
  settled: boolean
  /** The wallet step 1 was built for, once it has settled. */
  account: string | undefined
  /** How the balance before the swap stands. */
  readStatus: BeforeStatus
  /** What to say about step 2 while step 1 is unsigned. */
  swapLine: string
  start: (request: ChainSequenceRequest, text: string) => void
  /** Step 2. Called from a press and nowhere else. */
  runNext: () => void
  clear: () => void
}

/**
 * A swap on a chain other than Stellar, and what follows it. It adds no signing and no latch: step
 * 1 is the ordinary race and `chainAction` card, a new race is still what lifts that card's latch,
 * and this watches them to learn what arrived. Reloading loses it, by design. Nothing signable is
 * kept, and the transcript and the card's attempt notice cover the person.
 *
 * A deposit, stake or send is that same card again. The one other thing that lifts its latch is
 * step 2's press, once, from `ready`, and `ready` is reached only from a settled step 1 or from a
 * step 2 that proved nothing moved. See `moveOnSecond`.
 */
export function useChainSequence(
  chainAction: ChainAction,
  cashout: Pick<Cashout, 'open' | 'locked' | 'session' | 'hash'>
): ChainSequence {
  const { slug } = useChain()
  const { address } = useWallet()
  const [run, setRun] = useState<Run | null>(null)
  const [readStatus, setReadStatus] = useState<BeforeStatus>('unknown')
  const [quoted, setQuoted] = useState<string | undefined>(undefined)

  // Read at the press, not the render the button was drawn in.
  const connected = useRef(address)
  connected.current = address
  const { phase, signed, prepared, account: builtFor } = chainAction
  // Read when a `before` answers, which is some way on from when it was asked.
  const phaseNow = useRef(phase)
  phaseNow.current = phase
  const familyNow = useRef(prepared?.signing.family)
  familyNow.current = prepared?.signing.family

  const before = useRef<Before>(UNKNOWN)
  // Each read, start and clear takes a number, so an answer to an older one is dropped.
  const beforeRead = useRef(0)

  const request = run?.request
  const stage = run?.stage
  // Past this, the card is step 2's, and what it shows has no bearing on a balance before the swap.
  const pastSwap = run?.settled === true

  const noteBefore = useCallback((next: Before) => {
    before.current = next
    setReadStatus(next.status)
  }, [])

  const readBefore = useCallback(
    (account: string | undefined, token: ChainToken | undefined) => {
      beforeRead.current += 1
      const mine = beforeRead.current
      if (account === undefined || token === undefined) {
        noteBefore(UNKNOWN)
        return
      }
      const counts = (): boolean =>
        mine === beforeRead.current && beforeReadCounts(phaseNow.current, familyNow.current)
      noteBefore({ status: 'reading', account, token })
      void readBeforeSwap(() => readHolding(slug, account, token), counts).then((amount) => {
        if (mine !== beforeRead.current) return
        noteBefore(
          amount !== undefined && counts() ? { status: 'known', amount, account, token } : UNKNOWN
        )
      })
    },
    [slug, noteBefore]
  )

  // From when the card starts building, which leaves a person no time to sign ahead of the read.
  // The prepared card isn't there yet, so this goes by what was asked and who is connected, and
  // the card is checked against that when it comes up. A wallet declined comes back to `review`
  // and keeps what was read.
  useEffect(() => {
    if (request === undefined || pastSwap) return
    const asked = request.swap.tokenOut
    if (phase === 'building') {
      readBefore(address, outputToken(slug, asked, asked))
      return
    }
    if (phase !== 'review' || prepared === undefined || builtFor === undefined) return
    const token = outputToken(slug, prepared.receive?.symbol, asked)
    if (token !== undefined && keepsBefore(before.current, builtFor, token.id)) return
    readBefore(builtFor, token)
  }, [request, pastSwap, phase, prepared, builtFor, address, slug, readBefore])

  // Whether Weave would take what this card should deliver. Never holds the card back: it only
  // changes what is said, and a failed or slow read says nothing new.
  useEffect(() => {
    setQuoted(undefined)
    if (request === undefined || prepared === undefined) return
    const { followOn } = request
    if (followOn.kind !== 'cashout' || followOn.currency === undefined) return
    const step = quoteStep(prepared.receive?.amount)
    if (step.kind === 'none') return
    if (step.kind === 'note') {
      setQuoted(step.note)
      return
    }
    let replaced = false
    void readCashoutNote(slug, followOn.currency, step.amount).then((note) => {
      if (!replaced) setQuoted(note)
    })
    return () => {
      replaced = true
    }
  }, [request, prepared, slug])

  useEffect(() => {
    setRun((r) => {
      if (r === null) return r
      if (r.stage === 'following') {
        const second = moveOnSecond(r, phase, signed, r.request, r.delivered, prepared?.kind)
        if (second === r) return r
        const { error: _said, opened: _opened, ...rest } = r
        return { ...rest, ...second }
      }
      const known = before.current
      const moved = moveOnCard(r, phase, signed, known.status === 'known', r.request)
      if (moved === r) return r
      const { stage: nextStage, settled, error } = moved
      return {
        request: r.request,
        stage: nextStage,
        settled,
        ...(error !== undefined ? { error } : {}),
        ...(settled && known.status === 'known' ? { account: known.account } : {}),
      }
    })
  }, [phase, signed, prepared?.kind])

  // One read at a time, ending on unmount, on `clear` and at the limit.
  const measuring = stage === 'measuring'
  useEffect(() => {
    if (!measuring) return
    const known = before.current
    if (known.status !== 'known') {
      setRun((r) =>
        r === null ? r : { ...r, stage: 'stranded', error: unmeasuredReply(r.request) }
      )
      return
    }
    const stop = new AbortController()
    void measureDelivered({
      before: known.amount,
      decimals: known.token.decimals,
      read: (signal) => readHolding(slug, known.account, known.token, signal),
      signal: stop.signal,
    }).then((result) => {
      if (result === undefined) return
      setRun((r) => {
        if (r?.stage !== 'measuring') return r
        return result.stage === 'ready'
          ? { ...r, stage: 'ready', delivered: result.delivered }
          : { ...r, stage: 'stranded', error: unmeasuredReply(r.request) }
      })
    })
    return () => stop.abort()
  }, [measuring, slug])

  const formOpen = cashout.session !== null
  const { locked, hash: paidHash } = cashout
  useEffect(() => {
    setRun((r) => {
      if (r === null) return r
      const next = stageOnForm(r.stage, {
        open: formOpen,
        locked,
        paid: paidHash !== undefined,
      })
      return next === r.stage ? r : { ...r, stage: next }
    })
  }, [formOpen, locked, paidHash])

  const start = useCallback(
    (next: ChainSequenceRequest) => {
      beforeRead.current += 1
      noteBefore(UNKNOWN)
      setRun({ request: next, stage: 'swap', settled: false })
    },
    [noteBefore]
  )

  const clear = useCallback(() => {
    beforeRead.current += 1
    noteBefore(UNKNOWN)
    setRun(null)
  }, [noteBefore])

  const runNext = useCallback(() => {
    if (run?.stage !== 'ready' || run.delivered === undefined || run.account === undefined) return
    const { followOn } = run.request
    if (followOn.kind !== 'cashout') {
      if (!run.settled) return
      const asked = run.request.swap.tokenOut
      const token = outputToken(slug, asked, asked)
      const press = secondStepPress(
        token === undefined ? undefined : nextRequest(run.request, run.delivered, token.decimals),
        connected.current,
        run.account
      )
      if (press.kind === 'refused') {
        setRun((r) => (r === null ? r : { ...r, error: press.message }))
        return
      }
      setRun((r) => {
        if (r === null) return r
        const { error: _said, ...rest } = r
        return { ...rest, stage: 'following', opened: false }
      })
      chainAction.release()
      chainAction.prepare(press.request, stepLabels(run.request)[1])
      return
    }
    const action = readyAction(run.delivered, cashout.locked, connected.current, run.account)
    if (action.kind !== 'open') {
      setRun((r) => (r === null ? r : { ...r, error: action.message }))
      return
    }
    setRun((r) => {
      if (r === null) return r
      const { error: _said, ...rest } = r
      return { ...rest, stage: 'next' }
    })
    cashout.open({
      amount: action.amount,
      ...(followOn.currency !== undefined ? { currency: followOn.currency } : {}),
    })
  }, [run, cashout, chainAction, slug])

  return {
    sequence: run?.request ?? null,
    stage,
    delivered: run?.delivered,
    error: run?.error,
    settled: run?.settled ?? false,
    account: run?.account,
    readStatus,
    swapLine: swapLine(phase, readStatus, quoted, request),
    start,
    runNext,
    clear,
  }
}
