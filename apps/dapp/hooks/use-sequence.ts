'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { useChain } from '../providers/chain-provider'
import { useWallet } from './use-wallet'
import type { PlanAction } from '../lib/swap/build-plan'
import { blendPositionUrl } from '../lib/swap/contract-registry'
import { FAILURE_MESSAGES } from '../lib/swap/submit'

/**
 * Signing several transactions in order.
 *
 * Distinct from `use-plan-execution`, and the difference is forced by the
 * protocol rather than chosen. A plan is one transaction that Stellar executes
 * atomically: every step or none. **Soroban permits exactly one operation per
 * transaction** — verified on testnet twice — so a swap and a Blend supply
 * cannot share a signature, and a sequence is genuinely several transactions
 * signed one at a time.
 *
 * That changes what honesty requires. A plan can promise atomicity; a sequence
 * cannot, so it must instead show every step before the first signature and say
 * exactly where the user is if they stop partway.
 *
 * **Stopping is a normal outcome, not a failure.** Someone who signs the swap
 * and declines the supply holds XLM. That is a position, not a stuck state, and
 * the UI must say so rather than implying the sequence broke.
 *
 * The compensation for losing atomicity is real: step two is priced against
 * what step one *actually delivered*, rather than against an estimate an atomic
 * version would have had to guess in advance.
 *
 * **Steps advance on their own.** Approving the sequence approves all of it, so
 * once the first signature is given the next wallet prompt follows without
 * another button. That is a UX choice, not a safety one: the whole plan is
 * still shown before the first signature, which is where consent actually
 * happens. Declining any prompt stops the run, and the wallet remains the last
 * word on every individual transaction.
 */

export type SequencePhase =
  | 'idle'
  | 'building'
  | 'review'
  | 'signing'
  | 'submitting'
  | 'settled'
  | 'stopped'
  | 'failed'

export interface SequenceStep {
  /** What this step does, in words, for the review list. */
  label: string
  /** Set once this step confirms. */
  hash?: string
  explorerUrl?: string
  /**
   * Where the *result* of this step can be seen, when that is somewhere other
   * than a block explorer.
   *
   * A supply's explorer link proves the transaction happened; it does not show
   * the position it created, its balance, or the rate it earns. Those are what
   * someone who just lent actually wants.
   */
  positionUrl?: string
  /** What the step actually delivered, in base units. Known only after it settles. */
  delivered?: string
}

export interface SequenceState {
  phase: SequencePhase
  steps: SequenceStep[]
  /** Which step is being signed, or would be next. */
  current: number
  /** The envelope awaiting signature, when there is one. */
  xdr?: string
  error?: string
  /**
   * Set when the next step should sign itself without another click.
   *
   * True only for steps after the first: the opening signature is always
   * deliberate, because that is the moment the whole plan was approved.
   */
  autoAdvance?: boolean
}

/** A swap, then a supply of whatever it delivered. */
export interface SwapThenLend {
  kind: 'swap-then-lend'
  swap: PlanAction
  /** The reserve's asset, as a contract id. */
  lendAsset: string
  venue: string
}

export interface Sequence extends SequenceState {
  /** Builds the first step and shows the whole sequence. Does not sign. */
  prepare: (request: SwapThenLend) => void
  /** Signs and submits the step now awaiting signature. */
  confirm: () => void
  /** Stops after what has already settled, deliberately. */
  stop: () => void
  reset: () => void
}

const EMPTY: SequenceState = { phase: 'idle', steps: [], current: 0 }

/** Removes a leading "1. " from a server-numbered step label. */
function stripStepNumber(label: string | undefined): string | undefined {
  return label?.replace(/^\s*\d+\.\s*/, '')
}

export function useSequence(): Sequence {
  const { adapter } = useChain()
  const { address, isConnected } = useWallet()
  const [state, setState] = useState<SequenceState>(EMPTY)
  const [request, setRequest] = useState<SwapThenLend | undefined>(undefined)

  const reset = useCallback(() => {
    setState(EMPTY)
    setRequest(undefined)
  }, [])

  /**
   * Ends the sequence where it stands.
   *
   * Reported as `stopped` rather than `failed`, because nothing went wrong. The
   * distinction is the whole point: a user holding the asset from step one made
   * a choice, and calling that a failure would misdescribe their position.
   */
  const stop = useCallback(() => {
    setState((s) => ({ ...s, phase: 'stopped' }))
  }, [])

  const prepare = useCallback(
    (req: SwapThenLend) => {
      if (!isConnected || address === undefined) {
        setState({ ...EMPTY, phase: 'failed', error: 'Connect a wallet to run this sequence.' })
        return
      }
      const signer = address

      async function run(): Promise<void> {
        setRequest(req)
        setState({ ...EMPTY, phase: 'building' })

        try {
          const res = await fetch('/api/plan/build', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ account: signer, actions: [req.swap] }),
          })
          const built = (await res.json()) as {
            xdr?: string
            description?: string[]
            error?: string
          }

          if (built.xdr === undefined) {
            setState({
              ...EMPTY,
              phase: 'failed',
              error: built.error ?? 'Could not build the first step.',
            })
            return
          }

          // Both steps are named before the first signature. Showing only the
          // step being signed would let someone approve step one without
          // knowing a second was coming.
          setState({
            phase: 'review',
            current: 0,
            xdr: built.xdr,
            steps: [
              // `describePlan` numbers its steps ("1. Swap"), and the card
              // numbers them too, so the prefix is stripped rather than shown
              // twice. The card owns the ordering: a sequence's steps are not
              // the same list as a plan's.
              { label: stripStepNumber(built.description?.[0]) ?? 'Swap' },
              { label: `Supply the result to ${req.venue === 'blend' ? 'Blend' : req.venue}` },
            ],
          })
        } catch {
          setState({ ...EMPTY, phase: 'failed', error: 'Could not reach the network.' })
        }
      }

      void run()
    },
    [address, isConnected]
  )

  /**
   * Builds the supply, sized to what the swap actually delivered.
   *
   * The amount is a parameter rather than a stored figure precisely because it
   * is not knowable until the previous step confirms.
   */
  const buildLend = useCallback(
    async (signer: string, asset: string, amount: string): Promise<void> => {
      setState((s) => ({ ...s, phase: 'building' }))

      const res = await fetch('/api/lend/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: signer, asset, amount }),
      })
      const built = (await res.json()) as { xdr?: string; bTokens?: string; error?: string }

      if (built.xdr === undefined) {
        // The supply failing does not undo the swap. The user holds the asset,
        // which is why this reports where they are rather than a bare error.
        setState((s) => ({
          ...s,
          phase: 'failed',
          error:
            built.error ??
            'The swap went through, but the supply could not be built. You are holding the asset.',
        }))
        return
      }

      // Assigned by spread rather than named, because strict optional
      // properties reject an explicit `undefined` where the key is optional.
      const envelope = built.xdr
      // Marked ready rather than awaiting a click. The effect below picks this
      // up and raises the next wallet prompt, so the user signs twice instead
      // of clicking twice and signing twice.
      setState((s) => ({ ...s, phase: 'review', current: 1, xdr: envelope, autoAdvance: true }))
    },
    []
  )

  const confirm = useCallback(() => {
    const envelope = state.xdr
    if (envelope === undefined || address === undefined || request === undefined) return
    const signer = address
    const req = request
    const stepIndex = state.current

    async function run(): Promise<void> {
      setState((s) => {
        const next: SequenceState = { ...s, phase: 'signing' }
        // Consumed here, so a re-render cannot raise a second prompt for the
        // same step.
        delete next.autoAdvance
        return next
      })

      const signed = await adapter.signTransaction?.({ xdr: envelope as string, address: signer })
      if (signed === undefined) {
        setState((s) => ({ ...s, phase: 'failed', error: 'This chain cannot run sequences yet.' }))
        return
      }
      if (!signed.ok) {
        if (signed.reason === 'rejected') {
          // Declining step one abandons the sequence; declining step two leaves
          // a real position from step one. Different outcomes, so they are
          // reported differently.
          setState((s) => ({ ...s, phase: stepIndex === 0 ? 'review' : 'stopped' }))
          return
        }
        setState((s) => ({
          ...s,
          phase: 'failed',
          error: signed.detail ?? 'The wallet could not sign this step.',
        }))
        return
      }

      setState((s) => ({ ...s, phase: 'submitting' }))

      const endpoint = stepIndex === 0 ? '/api/plan/submit' : '/api/lend/submit'
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signedXdr: signed.signedXdr, account: signer }),
      })
      const result = (await res.json()) as {
        ok?: boolean
        hash?: string
        explorerUrl?: string
        delivered?: string
        reason?: keyof typeof FAILURE_MESSAGES
      }

      if (result.ok !== true) {
        setState((s) => ({
          ...s,
          phase: 'failed',
          error:
            result.reason !== undefined
              ? FAILURE_MESSAGES[result.reason]
              : 'That step did not go through.',
        }))
        return
      }

      setState((s) => {
        const steps = s.steps.map((step, i) =>
          i === stepIndex
            ? {
                ...step,
                ...(result.hash !== undefined ? { hash: result.hash } : {}),
                ...(result.explorerUrl !== undefined ? { explorerUrl: result.explorerUrl } : {}),
                ...(result.delivered !== undefined ? { delivered: result.delivered } : {}),
                // Only the supply has somewhere else worth looking. A swap is
                // fully described by its transaction; a position is not.
                ...(stepIndex > 0 ? { positionUrl: blendPositionUrl() } : {}),
              }
            : step
        )
        const done = stepIndex >= s.steps.length - 1
        const next: SequenceState = { ...s, steps, phase: done ? 'settled' : 'building' }
        delete next.xdr
        return next
      })

      // The step that makes a sequence worth the second signature: the supply
      // is sized to what arrived, not to what was predicted.
      if (stepIndex === 0) {
        if (result.delivered === undefined) {
          setState((s) => ({
            ...s,
            phase: 'failed',
            error:
              'The swap settled, but how much it delivered could not be read. ' +
              'You are holding the asset; supply it manually rather than guessing an amount.',
          }))
          return
        }
        await buildLend(signer, req.lendAsset, result.delivered)
      }
    }

    void run().catch(() => {
      setState((s) => ({ ...s, phase: 'failed', error: 'Something went wrong signing this step.' }))
    })
  }, [state.xdr, state.current, address, adapter, request, buildLend])

  // Raises the next wallet prompt once a later step is built and ready.
  //
  // Guarded by a ref rather than by the phase alone: React may render the same
  // state twice, and a duplicate prompt for the same envelope would ask the
  // user to sign a transaction they have already seen.
  const advancedFor = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (state.autoAdvance !== true || state.phase !== 'review' || state.xdr === undefined) return
    if (advancedFor.current === state.xdr) return
    advancedFor.current = state.xdr
    confirm()
  }, [state.autoAdvance, state.phase, state.xdr, confirm])

  return { ...state, prepare, confirm, stop, reset }
}
