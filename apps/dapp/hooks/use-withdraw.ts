'use client'

import { useCallback, useState } from 'react'

import { useChain } from '../providers/chain-provider'
import { useWallet } from './use-wallet'
import { FAILURE_MESSAGES } from '../lib/swap/submit'

/**
 * Taking a position back out of Blend.
 *
 * The mirror of `use-supply`, and shaped identically on purpose: one build, one
 * signature, one submission. The differences are in what can go wrong rather
 * than in the flow — a withdrawal cannot exceed a cap or need a trustline, but
 * it can be refused by the pool for lack of liquidity, which a supply never is.
 *
 * `amount` omitted means the whole position. That is not the same as passing
 * the balance the UI last read: interest accrues every ledger, so an exact
 * figure is already short by the time it is signed and would leave dust behind
 * in a position the user asked to close.
 */

export type WithdrawPhase =
  | 'idle'
  | 'building'
  | 'review'
  | 'signing'
  | 'submitting'
  | 'settled'
  | 'failed'

export interface WithdrawState {
  phase: WithdrawPhase
  /** The envelope awaiting signature. */
  xdr?: string
  /** Ticker, for display. */
  asset?: string
  /** Base units requested, or the sentinel when emptying the position. */
  amount?: string
  /** True when this closes the position rather than taking a named amount. */
  everything?: boolean
  /**
   * What the position still holds afterwards, in bTokens.
   *
   * Not the sum withdrawn. Zero here means the position will be emptied, which
   * is the clearest confirmation a simulation can give.
   */
  remaining?: string
  hash?: string
  explorerUrl?: string
  error?: string
}

export interface WithdrawRequest {
  /** The reserve's asset, as a contract id. */
  assetId: string
  /** Ticker, for display only. */
  symbol: string
  /** Base units, or omitted to withdraw the whole position. */
  amount?: string
}

export interface Withdraw extends WithdrawState {
  /** Builds and simulates the withdrawal, holding it for review. Does not sign. */
  prepare: (request: WithdrawRequest) => void
  confirm: () => void
  reset: () => void
}

const EMPTY: WithdrawState = { phase: 'idle' }

export function useWithdraw(): Withdraw {
  const { adapter } = useChain()
  const { address, isConnected } = useWallet()
  const [state, setState] = useState<WithdrawState>(EMPTY)

  const reset = useCallback(() => setState(EMPTY), [])

  const prepare = useCallback(
    (request: WithdrawRequest) => {
      if (!isConnected || address === undefined) {
        setState({ phase: 'failed', error: 'Connect a wallet to withdraw.' })
        return
      }
      const signer = address

      async function run(): Promise<void> {
        setState({ phase: 'building' })

        try {
          const res = await fetch('/api/lend/withdraw', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              account: signer,
              asset: request.assetId,
              ...(request.amount !== undefined ? { amount: request.amount } : {}),
            }),
          })
          const built = (await res.json()) as {
            xdr?: string
            amount?: string
            everything?: boolean
            remaining?: string
            error?: string
          }

          if (built.xdr === undefined) {
            // The pool's own reason, which distinguishes "not enough liquidity
            // right now" from "nothing to withdraw" — a difference that decides
            // whether waiting helps.
            setState({
              phase: 'failed',
              error: built.error ?? 'This withdrawal could not be built.',
            })
            return
          }

          setState({
            phase: 'review',
            xdr: built.xdr,
            asset: request.symbol,
            ...(built.amount !== undefined ? { amount: built.amount } : {}),
            ...(built.everything !== undefined ? { everything: built.everything } : {}),
            ...(built.remaining !== undefined ? { remaining: built.remaining } : {}),
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
        setState((s) => ({ ...s, phase: 'failed', error: 'This chain cannot withdraw yet.' }))
        return
      }
      if (!signed.ok) {
        // Declining returns to review rather than failing: the withdrawal is
        // still on offer and the user chose not to sign it.
        if (signed.reason === 'rejected') {
          setState((s) => ({ ...s, phase: 'review' }))
          return
        }
        setState((s) => ({
          ...s,
          phase: 'failed',
          error: signed.detail ?? 'The wallet could not sign this withdrawal.',
        }))
        return
      }

      setState((s) => ({ ...s, phase: 'submitting' }))

      const res = await fetch('/api/lend/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Named so a refusal is phrased as a withdrawal rather than a supply.
        body: JSON.stringify({ signedXdr: signed.signedXdr, account: signer, kind: 'withdraw' }),
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
              : 'The withdrawal did not go through.',
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
        error: 'Something went wrong signing the withdrawal.',
      }))
    })
  }, [state.xdr, address, adapter])

  return { ...state, prepare, confirm, reset }
}
