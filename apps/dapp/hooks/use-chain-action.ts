'use client'

import { useCallback, useRef, useState } from 'react'

import type { ChainActionRequest, PreparedAction, SubmitResult } from '../lib/chains/types'
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
  /** A signature was given for this action, so it must not be signed again. */
  signed?: boolean
}

export interface ChainAction extends ChainActionState {
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
        setState({ phase: 'review', asked, prepared: body.prepared })
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
    if (prepared === undefined || address === undefined) return
    const account = address
    const mine = generation.current
    const current = (): boolean => generation.current === mine

    async function run(prepared: PreparedAction): Promise<void> {
      setState((s) => ({ ...s, phase: 'signing' }))

      const outcome = await adapter.signPrepared?.(prepared.signing)
      if (!current()) return
      if (outcome === undefined) {
        setState((s) => ({ ...s, phase: 'failed', error: 'This wallet cannot sign here yet.' }))
        return
      }
      if (!outcome.ok) {
        // Declining returns to review: the action is still on offer.
        if (outcome.reason === 'rejected') {
          setState((s) => ({ ...s, phase: 'review' }))
          return
        }
        setState((s) => ({
          ...s,
          phase: 'failed',
          error: outcome.detail ?? 'The wallet could not sign this.',
        }))
        return
      }

      setState((s) => ({ ...s, phase: 'submitting', signed: true }))
      const res = await fetch(`/api/chain/${slug}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account,
          venueId: prepared.venueId,
          signed: outcome.signed,
          ...(prepared.context !== undefined ? { context: prepared.context } : {}),
        }),
      })
      const result = (await res.json()) as SubmitResult
      if (!current()) return
      if (!result.ok) {
        setState((s) => ({
          ...s,
          phase: result.pending === true ? 'pending' : 'failed',
          error: result.error,
        }))
        return
      }
      setState((s) => ({
        ...s,
        phase: 'settled',
        hash: result.hash,
        explorerUrl: result.explorerUrl,
      }))
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
  }, [state.prepared, address, adapter, slug])

  return { ...state, prepare, refuse, confirm, reset }
}
