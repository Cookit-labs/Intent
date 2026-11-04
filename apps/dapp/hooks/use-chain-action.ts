'use client'

import { useCallback, useRef, useState } from 'react'

import type { ChainActionRequest, PreparedAction } from '../lib/chains/types'
import {
  accountMismatch,
  afterSigning,
  afterSubmitting,
  latchBeforeSign,
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
  prepared?: PreparedAction
  hash?: string
  explorerUrl?: string
  error?: string
  /** The account the payload was built and checked for. */
  account?: string
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
  prepare: (request: ChainActionRequest, asked: string) => void
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
    (request: ChainActionRequest, asked: string) => {
      if (address === undefined) {
        setState({ phase: 'failed', asked, error: 'Connect a wallet first.' })
        return
      }
      const account = address
      generation.current += 1
      const mine = generation.current

      async function run(): Promise<void> {
        setState({ phase: 'building', asked })
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
        setState({ phase: 'review', asked, prepared: body.prepared, account })
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
      const family = prepared.signing.family
      // A wallet that sends for itself may send and then report an error, so
      // the latch is set before it is called, not after it answers.
      if (latchBeforeSign(family)) setSigned(true)
      setRequested(true)
      setState((s) => {
        const { error: _cleared, ...rest } = s
        return { ...rest, phase: 'signing' }
      })

      const outcome = await adapter.signPrepared?.(prepared.signing)
      if (!current()) return
      if (outcome === undefined) {
        setState((s) => ({ ...s, phase: 'failed', error: 'This wallet cannot sign here yet.' }))
        return
      }
      const step = afterSigning(outcome, family)
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
      const res = await fetch(`/api/chain/${slug}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account,
          venueId: prepared.venueId,
          signed: step.signed,
          ...(prepared.context !== undefined ? { context: prepared.context } : {}),
        }),
      })
      const result = (await res.json()) as unknown
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
  }, [state.prepared, state.account, adapter, slug])

  return { ...state, signed, requested, release, prepare, refuse, confirm, reset }
}
