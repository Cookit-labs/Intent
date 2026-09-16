'use client'

import { useCallback, useState } from 'react'

import { useChain } from '../providers/chain-provider'
import { useWallet } from './use-wallet'
import { FAILURE_MESSAGES } from '../lib/swap/submit'

/**
 * Posting collateral, and taking it back.
 *
 * The same build-review-sign shape as every other pool call, because it is the
 * same `submit`. What differs is what it means: posting collateral is the only
 * action in this app that removes a safety guarantee rather than adding a
 * position. A plain supply cannot be liquidated; collateral can.
 *
 * The wallet prompt that follows says nothing about that — it shows an opaque
 * contract call — so the warning has to happen before this is called.
 */

export type CollateralPhase =
  | 'idle'
  | 'building'
  | 'review'
  | 'signing'
  | 'submitting'
  | 'settled'
  | 'failed'

export type CollateralDirection = 'post' | 'reclaim'

export interface CollateralState {
  phase: CollateralPhase
  direction?: CollateralDirection
  xdr?: string
  asset?: string
  amount?: string
  everything?: boolean
  hash?: string
  explorerUrl?: string
  error?: string
}

export interface CollateralRequest {
  /** The reserve's asset, as a contract id. */
  assetId: string
  /** Ticker, for display only. */
  symbol: string
  /** Base units. Required to post; omit to reclaim everything. */
  amount?: string
}

export interface Collateral extends CollateralState {
  /** Builds and simulates, holding it for review. Does not sign. */
  prepare: (request: CollateralRequest) => void
  /** Reclaims collateral, returning it to a plain supply balance. */
  reclaim: (request: CollateralRequest) => void
  confirm: () => void
  reset: () => void
}

const EMPTY: CollateralState = { phase: 'idle' }

export function useCollateral(): Collateral {
  const { adapter } = useChain()
  const { address, isConnected } = useWallet()
  const [state, setState] = useState<CollateralState>(EMPTY)

  const reset = useCallback(() => setState(EMPTY), [])

  const build = useCallback(
    (direction: CollateralDirection, request: CollateralRequest) => {
      if (!isConnected || address === undefined) {
        setState({ phase: 'failed', error: 'Connect a wallet first.' })
        return
      }
      const signer = address

      async function run(): Promise<void> {
        setState({ phase: 'building', direction })

        try {
          const res = await fetch('/api/lend/collateral', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              account: signer,
              asset: request.assetId,
              direction,
              ...(request.amount !== undefined ? { amount: request.amount } : {}),
            }),
          })
          const built = (await res.json()) as {
            xdr?: string
            amount?: string
            everything?: boolean
            error?: string
          }

          if (built.xdr === undefined) {
            setState({
              phase: 'failed',
              direction,
              error: built.error ?? 'This could not be built.',
            })
            return
          }

          setState({
            phase: 'review',
            direction,
            xdr: built.xdr,
            asset: request.symbol,
            ...(built.amount !== undefined ? { amount: built.amount } : {}),
            ...(built.everything !== undefined ? { everything: built.everything } : {}),
          })
        } catch {
          setState({ phase: 'failed', direction, error: 'Could not reach the network.' })
        }
      }

      void run()
    },
    [address, isConnected]
  )

  const prepare = useCallback((request: CollateralRequest) => build('post', request), [build])
  const reclaim = useCallback((request: CollateralRequest) => build('reclaim', request), [build])

  const confirm = useCallback(() => {
    const envelope = state.xdr
    const direction = state.direction
    if (envelope === undefined || direction === undefined || address === undefined) return
    const signer = address

    async function run(): Promise<void> {
      setState((s) => ({ ...s, phase: 'signing' }))

      const signed = await adapter.signTransaction?.({ xdr: envelope as string, address: signer })
      if (signed === undefined) {
        setState((s) => ({ ...s, phase: 'failed', error: 'This chain cannot do that yet.' }))
        return
      }
      if (!signed.ok) {
        if (signed.reason === 'rejected') {
          setState((s) => ({ ...s, phase: 'review' }))
          return
        }
        setState((s) => ({
          ...s,
          phase: 'failed',
          error: signed.detail ?? 'The wallet could not sign this.',
        }))
        return
      }

      setState((s) => ({ ...s, phase: 'submitting' }))

      const res = await fetch('/api/lend/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          signedXdr: signed.signedXdr,
          account: signer,
          kind: direction === 'post' ? 'collateral' : 'reclaim',
        }),
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
              : 'That did not go through.',
        }))
        return
      }

      setState((s) => ({
        ...s,
        phase: 'settled',
        ...(result.hash !== undefined ? { hash: result.hash } : {}),
        ...(result.explorerUrl !== undefined ? { explorerUrl: result.explorerUrl } : {}),
      }))
    }

    void run().catch(() => {
      setState((s) => ({ ...s, phase: 'failed', error: 'Something went wrong signing this.' }))
    })
  }, [state.xdr, state.direction, address, adapter])

  return { ...state, prepare, reclaim, confirm, reset }
}
