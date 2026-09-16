'use client'

import { useCallback, useState } from 'react'

import { useChain } from '../providers/chain-provider'
import { useWallet } from './use-wallet'
import { FAILURE_MESSAGES } from '../lib/swap/submit'

/**
 * Opening and closing a liability.
 *
 * One hook for both directions, unlike supply and withdraw, because they are
 * halves of the same decision: nobody borrows without eventually repaying, and
 * a card showing a debt needs both actions in reach. Splitting them would mean
 * two hooks whose states have to be kept from contradicting each other.
 *
 * The shape otherwise mirrors `use-withdraw` — build, review, sign, submit —
 * with one difference that matters: a refusal carries whether waiting could
 * help. "The pool is full" and "you need more collateral" arrive identically
 * from the contract and demand opposite responses.
 */

export type BorrowPhase =
  | 'idle'
  | 'building'
  | 'review'
  | 'signing'
  | 'submitting'
  | 'settled'
  | 'failed'

export type BorrowDirection = 'borrow' | 'repay'

export interface BorrowState {
  phase: BorrowPhase
  direction?: BorrowDirection
  /** The envelope awaiting signature. */
  xdr?: string
  /** Ticker, for display. */
  asset?: string
  /** Base units, or the sentinel when repaying everything. */
  amount?: string
  /** True when a repayment clears the whole liability. */
  everything?: boolean
  hash?: string
  explorerUrl?: string
  error?: string
  /**
   * Whether the refusal might clear on its own.
   *
   * A reserve at its utilisation ceiling frees up as borrowers repay;
   * insufficient collateral does not fix itself. Telling the two apart decides
   * whether the user should wait or act.
   */
  transient?: boolean
}

export interface BorrowRequest {
  /** The reserve's asset, as a contract id. */
  assetId: string
  /** Ticker, for display only. */
  symbol: string
  /** Base units. Required to borrow; omit to repay everything. */
  amount?: string
}

export interface Borrow extends BorrowState {
  /** Builds and simulates, holding it for review. Does not sign. */
  prepare: (direction: BorrowDirection, request: BorrowRequest) => void
  confirm: () => void
  reset: () => void
}

const EMPTY: BorrowState = { phase: 'idle' }

export function useBorrow(): Borrow {
  const { adapter } = useChain()
  const { address, isConnected } = useWallet()
  const [state, setState] = useState<BorrowState>(EMPTY)

  const reset = useCallback(() => setState(EMPTY), [])

  const prepare = useCallback(
    (direction: BorrowDirection, request: BorrowRequest) => {
      if (!isConnected || address === undefined) {
        setState({ phase: 'failed', error: `Connect a wallet to ${direction}.` })
        return
      }
      const signer = address

      async function run(): Promise<void> {
        setState({ phase: 'building', direction })

        try {
          const res = await fetch(`/api/lend/${direction}`, {
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
            error?: string
            transient?: boolean
          }

          if (built.xdr === undefined) {
            setState({
              phase: 'failed',
              direction,
              error: built.error ?? `This ${direction} could not be built.`,
              ...(built.transient !== undefined ? { transient: built.transient } : {}),
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

  const confirm = useCallback(() => {
    const envelope = state.xdr
    const direction = state.direction
    if (envelope === undefined || direction === undefined || address === undefined) return
    const signer = address

    async function run(): Promise<void> {
      setState((s) => ({ ...s, phase: 'signing' }))

      const signed = await adapter.signTransaction?.({ xdr: envelope as string, address: signer })
      if (signed === undefined) {
        setState((s) => ({ ...s, phase: 'failed', error: 'This chain cannot borrow yet.' }))
        return
      }
      if (!signed.ok) {
        // Declining returns to review rather than failing: the transaction is
        // still on offer and the user chose not to sign it.
        if (signed.reason === 'rejected') {
          setState((s) => ({ ...s, phase: 'review' }))
          return
        }
        setState((s) => ({
          ...s,
          phase: 'failed',
          error: signed.detail ?? `The wallet could not sign this ${direction as string}.`,
        }))
        return
      }

      setState((s) => ({ ...s, phase: 'submitting' }))

      const res = await fetch('/api/lend/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Named so a refusal is phrased as the operation the user asked for.
        body: JSON.stringify({ signedXdr: signed.signedXdr, account: signer, kind: direction }),
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
              : `The ${direction as string} did not go through.`,
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

  return { ...state, prepare, confirm, reset }
}
