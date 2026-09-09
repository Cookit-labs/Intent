'use client'

import { useCallback, useEffect, useState } from 'react'

import { useChain } from '../providers/chain-provider'
import { useWallet } from './use-wallet'
import { fromBaseUnits } from '../lib/swap/assets'
import type { SwapQuote } from '../lib/swap/quote'
import { FAILURE_MESSAGES } from '../lib/swap/submit'
import type { SwapPhase } from './use-swap'

/**
 * Executes the route an agent already chose.
 *
 * Distinct from `useSwap`, which starts from text and quotes for itself. Here
 * the competition has already run and picked a winner, so re-quoting would show
 * the user a different number than the agents compared — the quote handed over
 * is the one that gets signed.
 */
export interface SwapExecutionState {
  phase: SwapPhase
  quote?: SwapQuote
  sendDisplay?: string
  receiveDisplay?: string
  hash?: string
  explorerUrl?: string
  error?: string
}

export interface SwapExecution extends SwapExecutionState {
  confirm: () => void
  reset: () => void
}

export function useSwapExecution(route: unknown): SwapExecution {
  const { adapter } = useChain()
  const { address, isConnected } = useWallet()
  const [state, setState] = useState<SwapExecutionState>({ phase: 'idle' })

  // A new winning route replaces whatever was on screen. Without this a second
  // intent would show the previous swap's result.
  useEffect(() => {
    if (route === undefined) {
      setState({ phase: 'idle' })
      return
    }
    const quote = route as SwapQuote
    setState({
      phase: 'review',
      quote,
      sendDisplay: fromBaseUnits(quote.sendAmount),
      receiveDisplay: fromBaseUnits(quote.destAmount),
    })
  }, [route])

  const reset = useCallback(() => setState({ phase: 'idle' }), [])

  const confirm = useCallback(() => {
    const quote = state.quote
    if (quote === undefined) return

    if (!isConnected || address === undefined) {
      setState((s) => ({ ...s, phase: 'failed', error: 'Connect a wallet to execute this swap.' }))
      return
    }
    if (adapter.signTransaction === undefined) {
      setState((s) => ({ ...s, phase: 'failed', error: 'This chain cannot execute swaps yet.' }))
      return
    }

    async function run(): Promise<void> {
      setState((s) => ({ ...s, phase: 'signing' }))

      try {
        const buildRes = await fetch('/api/swap/build', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account: address, quote }),
        })
        const built = (await buildRes.json()) as { xdr?: string; error?: string }

        if (built.xdr === undefined) {
          setState((s) => ({
            ...s,
            phase: 'failed',
            error:
              built.error === 'quote_expired'
                ? 'That price is no longer current. Submit the intent again for a fresh quote.'
                : (built.error ?? 'Could not build the swap.'),
          }))
          return
        }

        const signed = await adapter.signTransaction?.({ xdr: built.xdr, address: address as string })
        if (signed === undefined) return

        if (!signed.ok) {
          // Declining returns to review: the user chose that, and the quote is
          // still on offer.
          if (signed.reason === 'rejected') {
            setState((s) => ({ ...s, phase: 'review' }))
            return
          }
          setState((s) => ({
            ...s,
            phase: 'failed',
            error: signed.detail ?? 'The wallet could not sign this transaction.',
          }))
          return
        }

        setState((s) => ({ ...s, phase: 'submitting' }))

        const submitRes = await fetch('/api/swap/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ signedXdr: signed.signedXdr, account: address }),
        })
        const result = (await submitRes.json()) as {
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
                : 'The swap did not go through.',
          }))
          return
        }

        setState((s) => ({
          ...s,
          phase: 'settled',
          ...(result.hash !== undefined ? { hash: result.hash } : {}),
          ...(result.explorerUrl !== undefined ? { explorerUrl: result.explorerUrl } : {}),
        }))
      } catch {
        setState((s) => ({ ...s, phase: 'failed', error: 'Something went wrong submitting the swap.' }))
      }
    }

    void run()
  }, [state.quote, address, isConnected, adapter])

  return { ...state, confirm, reset }
}
