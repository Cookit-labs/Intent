'use client'

import { useCallback, useRef, useState } from 'react'

import type { ChainActionKind, ChainActionRequest, PreparedAction } from '../lib/chains/types'
import {
  accountMismatch,
  afterSigning,
  afterSubmitting,
  attemptNotice,
  attemptStorage,
  earlierAttempt,
  latchBeforeSign,
  noteSubmitAnswer,
  noteWalletAnswer,
  QUOTE_EXPIRED,
  quoteExpiredBeforeSigning,
  recordAttempt,
  submitSigned,
  type AttemptNotice,
  type SignAttempt,
} from '../lib/chains/signing-flow'
import { useChain } from '../providers/chain-provider'
import { useWallet } from './use-wallet'

export type ChainActionPhase =
  | 'idle'
  | 'building'
  | 'review'
  | 'signing'
  | 'submitting'
  | 'settled'
  /** Sent, with the outcome not known yet. Not a failure: the money has moved. */
  | 'pending'
  | 'failed'

export interface ChainActionState {
  phase: ChainActionPhase
  asked?: string
  /** What is being built, before there is a card to read it from. */
  building?: ChainActionKind
  prepared?: PreparedAction
  hash?: string
  explorerUrl?: string
  error?: string
  /** The account the payload was built and checked for. */
  account?: string
  /** The race this action was chosen from; absent for the direct route built when no race gave one. */
  raceId?: string
  /** This same action was already started recently, perhaps before a reload. */
  earlier?: AttemptNotice
}

export interface ChainAction extends ChainActionState {
  /**
   * A signature may have happened in this race, so nothing may be signed again.
   * It belongs to the race, not the card: Dismiss, Done and reset leave it set,
   * and only `release`, called when a new race starts, clears it.
   */
  signed: boolean
  /**
   * A signature was asked of the wallet in this race. Unlike `signed`, a clean
   * failure does not clear it: something was signed, so "nothing was signed"
   * must never be said again. Only a new race clears it.
   */
  requested: boolean
  release: () => void
  prepare: (request: ChainActionRequest, asked: string, raceId?: string) => void
  /** Shows a message in the card without building anything, for what can't be read. */
  refuse: (message: string, asked: string) => void
  confirm: () => void
  reset: () => void
}

const EMPTY: ChainActionState = { phase: 'idle' }

/** One action on a chain that is not Stellar: one build, one signature, one submission. */
export function useChainAction(): ChainAction {
  const { slug, adapter } = useChain()
  const { address } = useWallet()
  // Read at the moment of signing, not the render the click was made in.
  const addressRef = useRef(address)
  addressRef.current = address
  const [signed, setSigned] = useState(false)
  const [requested, setRequested] = useState(false)
  const release = useCallback(() => {
    setSigned(false)
    setRequested(false)
  }, [])
  const [state, setState] = useState<ChainActionState>(EMPTY)
  // Each prepare, refuse and reset starts a new generation. A response from an
  // older one is dropped, so a build that was superseded cannot become a
  // signable card under a newer request.
  const generation = useRef(0)

  const reset = useCallback(() => {
    generation.current += 1
    setState(EMPTY)
  }, [])

  const refuse = useCallback((message: string, asked: string) => {
    generation.current += 1
    setState({ phase: 'failed', asked, error: message })
  }, [])

  const prepare = useCallback(
    (request: ChainActionRequest, asked: string, raceId?: string) => {
      if (address === undefined) {
        setState({ phase: 'failed', asked, error: 'Connect a wallet first.' })
        return
      }
      const account = address
      generation.current += 1
      const mine = generation.current

      async function run(): Promise<void> {
        setState({ phase: 'building', asked, building: request.kind })
        const res = await fetch(`/api/chain/${slug}/prepare`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account, request }),
        })
        const body = (await res.json()) as { prepared?: PreparedAction; error?: string }
        if (generation.current !== mine) return
        if (body.prepared === undefined) {
          setState({
            phase: 'failed',
            asked,
            error: body.error ?? 'This could not be built. Nothing was signed or sent.',
          })
          return
        }
        const earlier = earlierAttempt(attemptStorage(), {
          chain: slug,
          account,
          tokenIn: body.prepared.pay.symbol,
          amount: body.prepared.pay.amount,
        })
        setState({
          phase: 'review',
          asked,
          prepared: body.prepared,
          account,
          ...(raceId !== undefined ? { raceId } : {}),
          ...(earlier !== undefined ? { earlier: attemptNotice(earlier) } : {}),
        })
      }

      void run().catch(() => {
        if (generation.current !== mine) return
        setState({ phase: 'failed', asked, error: 'Could not reach the network.' })
      })
    },
    [address, slug]
  )

  const confirm = useCallback(() => {
    const prepared = state.prepared
    const builtFor = state.account
    if (prepared === undefined || builtFor === undefined) return
    const account = builtFor
    const raceId = state.raceId
    const mine = generation.current
    const current = (): boolean => generation.current === mine

    // The payload was checked against this account only. A different wallet
    // connected since the card was built stays on review with the reason.
    const wrongWallet = (): boolean => {
      const message = accountMismatch(addressRef.current, account)
      if (message === undefined) return false
      setState((s) => ({ ...s, phase: 'review', error: message }))
      return true
    }
    if (wrongWallet()) return

    async function run(prepared: PreparedAction): Promise<void> {
      // Checked again immediately before the wallet opens.
      if (wrongWallet()) return
      if (quoteExpiredBeforeSigning(prepared)) {
        setState((s) => ({ ...s, phase: 'failed', error: QUOTE_EXPIRED }))
        return
      }
      const family = prepared.signing.family
      const storage = attemptStorage()
      const attempt: SignAttempt = {
        chain: slug,
        account,
        tokenIn: prepared.pay.symbol,
        amount: prepared.pay.amount,
        at: Date.now(),
      }
      recordAttempt(storage, attempt)
      // A wallet that sends for itself may send and then report an error, so
      // the latch is set before it is called, not after it answers.
      if (latchBeforeSign(family)) setSigned(true)
      setRequested(true)
      setState((s) => {
        const { error: _cleared, ...rest } = s
        return { ...rest, phase: 'signing' }
      })

      const outcome = await adapter.signPrepared?.(prepared.signing)
      const step = outcome === undefined ? undefined : afterSigning(outcome, family)
      // Noted even for a card replaced since: the answer is as true either way.
      noteWalletAnswer(storage, attempt, step)
      if (!current()) return
      if (step === undefined) {
        setState((s) => ({ ...s, phase: 'failed', error: 'This wallet cannot sign here yet.' }))
        return
      }
      if (step.next === 'review') {
        setState((s) => ({ ...s, phase: 'review' }))
        return
      }
      if (step.next === 'unknown') {
        setState((s) => ({ ...s, phase: 'pending', error: step.error }))
        return
      }
      if (step.next === 'failed') {
        setState((s) => ({ ...s, phase: 'failed', error: step.error }))
        return
      }

      setSigned(true)
      setState((s) => ({ ...s, phase: 'submitting' }))
      const result = await submitSigned(
        `/api/chain/${slug}/submit`,
        {
          account,
          venueId: prepared.venueId,
          signed: step.signed,
          ...(prepared.context !== undefined ? { context: prepared.context } : {}),
        },
        raceId
      )
      noteSubmitAnswer(storage, attempt, result)
      if (!current()) return
      const done = afterSubmitting(result, family)
      if (!done.latched) setSigned(false)
      if (done.phase === 'settled') {
        setState((s) => ({
          ...s,
          phase: 'settled',
          hash: done.hash,
          ...(done.explorerUrl !== undefined ? { explorerUrl: done.explorerUrl } : {}),
        }))
        return
      }
      setState((s) => ({ ...s, phase: done.phase, error: done.error }))
    }

    void run(prepared).catch(() => {
      if (!current()) return
      setState((s) => ({
        ...s,
        phase: 'failed',
        error:
          "This could not be confirmed. Check your wallet's activity before trying again, in case it went through.",
      }))
    })
  }, [state.prepared, state.account, state.raceId, adapter, slug])

  return { ...state, signed, requested, release, prepare, refuse, confirm, reset }
}
