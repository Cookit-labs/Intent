'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import type { ChainSequenceRequest } from '../lib/chains/sequence'
import {
  beforeReadCounts,
  measureDelivered,
  moveOnCard,
  outputToken,
  readHolding,
  readyAction,
  stageOnForm,
  unmeasuredReply,
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

/** What the output token's balance was before the swap. Anything but `known` strands at settled. */
type Before =
  | { status: 'unknown' }
  | { status: 'reading' }
  | { status: 'known'; amount: string; token: ChainToken; account: string }

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
 */
export function useChainSequence(
  chainAction: ChainAction,
  cashout: Pick<Cashout, 'open' | 'locked' | 'session' | 'hash'>
): ChainSequence {
  const { slug } = useChain()
  const { address } = useWallet()
  const [run, setRun] = useState<Run | null>(null)

  // Read at the press, not the render the button was drawn in.
  const connected = useRef(address)
  connected.current = address
  const { phase, signed, prepared, account: builtFor } = chainAction
  // Read when a `before` answers, which is some way on from when it was asked.
  const phaseNow = useRef(phase)
  phaseNow.current = phase

  const before = useRef<Before>(UNKNOWN)
  // Each read, start and clear takes a number, so an answer to an older one is dropped.
  const beforeRead = useRef(0)

  const request = run?.request
  const stage = run?.stage

  // Before any signature, each time a card is put on offer: a wallet declined comes back here too.
  useEffect(() => {
    if (request === undefined || phase !== 'review') return
    if (prepared === undefined || builtFor === undefined) return
    beforeRead.current += 1
    const mine = beforeRead.current
    const token = outputToken(slug, prepared.receive?.symbol, request.swap.tokenOut)
    if (token === undefined) {
      before.current = UNKNOWN
      return
    }
    const account = builtFor
    const family = prepared.signing.family
    before.current = { status: 'reading' }
    void readHolding(slug, account, token).then((amount) => {
      if (mine !== beforeRead.current) return
      before.current =
        amount !== undefined && beforeReadCounts(phaseNow.current, family)
          ? { status: 'known', amount, token, account }
          : UNKNOWN
    })
  }, [request, phase, prepared, builtFor, slug])

  useEffect(() => {
    setRun((r) => {
      if (r === null) return r
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
  }, [phase, signed])

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

  const start = useCallback((next: ChainSequenceRequest) => {
    beforeRead.current += 1
    before.current = UNKNOWN
    setRun({ request: next, stage: 'swap', settled: false })
  }, [])

  const clear = useCallback(() => {
    beforeRead.current += 1
    before.current = UNKNOWN
    setRun(null)
  }, [])

  const runNext = useCallback(() => {
    if (run?.stage !== 'ready' || run.delivered === undefined || run.account === undefined) return
    const { followOn } = run.request
    // Step 2 by kind. A cash-out is the only one so far: `followOnNotYet` turns the rest away
    // before step 1, and each goes here when it is built.
    if (followOn.kind !== 'cashout') return
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
  }, [run, cashout])

  return {
    sequence: run?.request ?? null,
    stage,
    delivered: run?.delivered,
    error: run?.error,
    settled: run?.settled ?? false,
    account: run?.account,
    start,
    runNext,
    clear,
  }
}
