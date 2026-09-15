'use client'

import { useCallback, useState } from 'react'

import { useChain } from '../providers/chain-provider'
import { useWallet } from './use-wallet'
import { FAILURE_MESSAGES } from '../lib/swap/submit'

/**
 * Supplying an asset the account already holds.
 *
 * Separate from `use-sequence`, which exists to carry proceeds from one step
 * into the next. Here there is no previous step: the amount is whatever the
 * account holds now, or whatever the user named, and it is known before
 * anything is signed.
 *
 * That makes this the simpler shape — one build, one signature, one
 * submission — and folding it into the sequence hook would mean pretending a
 * first step happened in order to reuse machinery for carrying its output.
 */

export type SupplyPhase =
  | 'idle'
  | 'building'
  | 'review'
  | 'signing'
  | 'submitting'
  | 'settled'
  | 'failed'

export interface SupplyState {
  phase: SupplyPhase
  /** The envelope awaiting signature. */
  xdr?: string
  /** Base units being supplied, as the route priced it. */
  amount?: string
  /** Ticker, for display. */
  asset?: string
  /**
   * What the pool would mint, approximately.
   *
   * Interest accrues every ledger and `submit` takes no minimum-out, so this
   * cannot be made exact and anything showing it must say "about".
   */
  bTokens?: string
  hash?: string
  explorerUrl?: string
  positionUrl?: string
  error?: string
}

export interface SupplyRequest {
  /** The reserve's asset, as a contract id. */
  assetId: string
  /** Ticker, for display only. */
  symbol: string
  /** Base units. */
  amount: string
}

export interface Supply extends SupplyState {
  /** Prices and builds the supply, holding it for review. Does not sign. */
  prepare: (request: SupplyRequest) => void
  confirm: () => void
  reset: () => void
}

const EMPTY: SupplyState = { phase: 'idle' }

export function useSupply(): Supply {
  const { adapter } = useChain()
  const { address, isConnected } = useWallet()
  const [state, setState] = useState<SupplyState>(EMPTY)

  const reset = useCallback(() => setState(EMPTY), [])

  const prepare = useCallback(
    (request: SupplyRequest) => {
      if (!isConnected || address === undefined) {
        setState({ phase: 'failed', error: 'Connect a wallet to supply.' })
        return
      }
      const signer = address

      async function run(): Promise<void> {
        setState({ phase: 'building' })

        try {
          const res = await fetch('/api/lend/build', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              account: signer,
              asset: request.assetId,
              amount: request.amount,
            }),
          })
          const built = (await res.json()) as {
            xdr?: string
            amount?: string
            bTokens?: string
            error?: string
          }

          if (built.xdr === undefined) {
            // Every refusal from that route is a real condition — an exceeded
            // supply cap, a disabled reserve, a balance that cannot cover it —
            // surfaced before a signature rather than after one.
            setState({
              phase: 'failed',
              error: built.error ?? 'This supply could not be built.',
            })
            return
          }

          setState({
            phase: 'review',
            xdr: built.xdr,
            asset: request.symbol,
            ...(built.amount !== undefined ? { amount: built.amount } : {}),
            ...(built.bTokens !== undefined ? { bTokens: built.bTokens } : {}),
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
    const envelope = state.xdr
    if (envelope === undefined || address === undefined) return
    const signer = address

    async function run(): Promise<void> {
      setState((s) => ({ ...s, phase: 'signing' }))

      const signed = await adapter.signTransaction?.({ xdr: envelope as string, address: signer })
      if (signed === undefined) {
        setState((s) => ({ ...s, phase: 'failed', error: 'This chain cannot supply yet.' }))
        return
      }
      if (!signed.ok) {
        // Declining returns to review rather than failing: the supply is still
        // on offer and the user chose not to sign it.
        if (signed.reason === 'rejected') {
          setState((s) => ({ ...s, phase: 'review' }))
          return
        }
        setState((s) => ({
          ...s,
          phase: 'failed',
          error: signed.detail ?? 'The wallet could not sign this supply.',
        }))
        return
      }

      setState((s) => ({ ...s, phase: 'submitting' }))

      const res = await fetch('/api/lend/submit', {
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
              : 'The supply did not go through.',
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
      setState((s) => ({
        ...s,
        phase: 'failed',
        error: 'Something went wrong signing the supply.',
      }))
    })
  }, [state.xdr, address, adapter])

  return { ...state, prepare, confirm, reset }
}
