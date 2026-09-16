'use client'

import { useCallback, useState } from 'react'

import { useChain } from '../providers/chain-provider'
import { useWallet } from './use-wallet'
import type { PlanAction } from '../lib/swap/build-plan'
import { FAILURE_MESSAGES } from '../lib/swap/submit'

/**
 * Signing a multi-step plan.
 *
 * Separate from `use-swap-execution` because a plan is a different thing to
 * approve. A swap has one number to check; a plan has an ordered list, and the
 * order is meaning — resting the remainder before swapping would commit funds
 * the swap still needs.
 *
 * The description is not decoration. A plan the user cannot read is a plan
 * they cannot refuse, and one signature covering several operations is only
 * safe if every one of them is visible first.
 */

export type PlanPhase =
  | 'idle'
  | 'building'
  | 'review'
  | 'signing'
  | 'submitting'
  | 'settled'
  | 'failed'

export interface PlanExecutionState {
  phase: PlanPhase
  xdr?: string
  /** Numbered steps, in the order they will execute. */
  description?: string[]
  hash?: string
  explorerUrl?: string
  error?: string
}

export interface PlanExecution extends PlanExecutionState {
  /** Builds the plan and holds it for review. Does not sign. */
  prepare: (actions: PlanAction[]) => void
  confirm: () => void
  reset: () => void
}

export function usePlanExecution(): PlanExecution {
  const { adapter } = useChain()
  const { address, isConnected } = useWallet()
  const [state, setState] = useState<PlanExecutionState>({ phase: 'idle' })

  const reset = useCallback(() => setState({ phase: 'idle' }), [])

  const prepare = useCallback(
    (actions: PlanAction[]) => {
      if (!isConnected || address === undefined) {
        setState({ phase: 'failed', error: 'Connect a wallet to execute a plan.' })
        return
      }

      async function run(): Promise<void> {
        setState({ phase: 'building' })
        try {
          const res = await fetch('/api/plan/build', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ account: address, actions }),
          })
          const built = (await res.json()) as {
            xdr?: string
            description?: string[]
            error?: string
          }

          if (built.xdr === undefined) {
            // Every refusal from that endpoint is a safety property — an
            // unverified asset, a step the app does not build — so the reason
            // is shown rather than replaced with something generic.
            setState({ phase: 'failed', error: built.error ?? 'Could not build this plan.' })
            return
          }

          setState({
            phase: 'review',
            xdr: built.xdr,
            ...(built.description !== undefined ? { description: built.description } : {}),
          })
        } catch {
          setState({ phase: 'failed', error: 'Could not reach the network.' })
        }
      }

      void run()
    },
    [address, isConnected]
  )

  const confirm = useCallback(() => {
    const xdr: string | undefined = state.xdr
    if (xdr === undefined || address === undefined) return
    // Both narrowed into locals: the async closure below is not covered by the
    // guard above, so TypeScript widens them again inside it.
    const envelope: string = xdr
    // Narrowed once here, so the async closure below does not have to reassert
    // it at every use.
    const signer: string = address

    async function run(): Promise<void> {
      setState((s) => ({ ...s, phase: 'signing' }))

      const signed = await adapter.signTransaction?.({ xdr: envelope, address: signer })
      if (signed === undefined) {
        setState((s) => ({ ...s, phase: 'failed', error: 'This chain cannot execute plans yet.' }))
        return
      }
      if (!signed.ok) {
        // Declining returns to review: the plan is still on offer, and the
        // user chose not to sign it rather than hitting an error.
        if (signed.reason === 'rejected') {
          setState((s) => ({ ...s, phase: 'review' }))
          return
        }
        setState((s) => ({
          ...s,
          phase: 'failed',
          error: signed.detail ?? 'The wallet could not sign this plan.',
        }))
        return
      }

      setState((s) => ({ ...s, phase: 'submitting' }))

      const res = await fetch('/api/plan/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signedXdr: signed.signedXdr, account: signer }),
      })
      const result = (await res.json()) as {
        ok?: boolean
        hash?: string
        explorerUrl?: string
        reason?: keyof typeof FAILURE_MESSAGES
      }

      if (result.ok !== true) {
        setState((s) => ({
          ...s,
          phase: 'failed',
          error:
            result.reason !== undefined
              ? FAILURE_MESSAGES[result.reason]
              : 'The plan did not go through.',
        }))
        return
      }

      // Atomic: every step happened, or none did. There is no partial state to
      // report, which is the reason a plan is one transaction rather than
      // several.
      setState((s) => ({
        ...s,
        phase: 'settled',
        ...(result.hash !== undefined ? { hash: result.hash } : {}),
        ...(result.explorerUrl !== undefined ? { explorerUrl: result.explorerUrl } : {}),
      }))
    }

    void run().catch(() => {
      setState((s) => ({ ...s, phase: 'failed', error: 'Something went wrong signing the plan.' }))
    })
  }, [state.xdr, address, adapter])

  return { ...state, prepare, confirm, reset }
}
