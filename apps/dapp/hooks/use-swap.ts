'use client'

import { useCallback, useState } from 'react'

import { useChain } from '../providers/chain-provider'
import { useWallet } from './use-wallet'
import { fromBaseUnits } from '../lib/swap/assets'
import type { SwapQuote } from '../lib/swap/quote'
import { FAILURE_MESSAGES } from '../lib/swap/submit'

/**
 * Drives a swap from quote to confirmed transaction.
 *
 * The states are deliberately explicit rather than a pair of booleans: a user
 * about to spend money should be able to tell "waiting for a price" from
 * "waiting for you to sign" from "waiting for the network", and each needs a
 * different thing from them.
 *
 * Building and submitting happen through the API route so the heavy Stellar SDK
 * stays out of the client bundle; only signing has to happen here, because only
 * the wallet can do it.
 */

export type SwapPhase =
  | 'idle'
  | 'quoting'
  | 'review'
  | 'signing'
  | 'submitting'
  | 'settled'
  | 'failed'

export interface SwapState {
  phase: SwapPhase
  quote?: SwapQuote
  /** Present once the network has accepted the swap. */
  hash?: string
  explorerUrl?: string
  error?: string
  /** Human-readable amounts, so the UI does not repeat the conversion. */
  sendDisplay?: string
  receiveDisplay?: string
}

export interface SwapActions {
  requestQuote: (from: string, to: string, amount: string) => Promise<void>
  confirm: () => Promise<void>
  reset: () => void
}

export function useSwap(): SwapState & SwapActions {
  const { adapter } = useChain()
  const { address } = useWallet()
  const [state, setState] = useState<SwapState>({ phase: 'idle' })

  const reset = useCallback(() => setState({ phase: 'idle' }), [])

  const requestQuote = useCallback(async (from: string, to: string, amount: string) => {
    setState({ phase: 'quoting' })
    try {
      const res = await fetch('/api/swap/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to, amount }),
      })
      const data = (await res.json()) as { best?: SwapQuote; error?: string }

      if (data.best === undefined) {
        setState({ phase: 'failed', error: data.error ?? 'No route found for this pair.' })
        return
      }

      setState({
        phase: 'review',
        quote: data.best,
        sendDisplay: fromBaseUnits(data.best.sendAmount),
        receiveDisplay: fromBaseUnits(data.best.destAmount),
      })
    } catch {
      setState({ phase: 'failed', error: 'Could not reach the quote service.' })
    }
  }, [])

  const confirm = useCallback(async () => {
    const quote = state.quote
    if (quote === undefined || address === undefined) return

    if (adapter.signTransaction === undefined) {
      setState((s) => ({ ...s, phase: 'failed', error: 'This chain cannot execute swaps yet.' }))
      return
    }

    setState((s) => ({ ...s, phase: 'signing' }))

    try {
      // Re-quoted and rebuilt server-side rather than reusing the reviewed
      // envelope: a route priced a minute ago may no longer fill, and the
      // freshest quote is the one worth signing.
      const buildRes = await fetch('/api/swap/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: address, quote }),
      })
      const built = (await buildRes.json()) as { xdr?: string; error?: string }
      if (built.xdr === undefined) {
        setState((s) => ({ ...s, phase: 'failed', error: built.error ?? 'Could not build the swap.' }))
        return
      }

      const signed = await adapter.signTransaction({ xdr: built.xdr, address })
      if (!signed.ok) {
        // A decline returns to review rather than to an error screen: the user
        // chose this, and the quote they were looking at is still on offer.
        if (signed.reason === 'rejected') {
          setState((s) => ({ ...s, phase: 'review' }))
          return
        }
        setState((s) => ({ ...s, phase: 'failed', error: signed.detail ?? 'The wallet could not sign.' }))
        return
      }

      setState((s) => ({ ...s, phase: 'submitting' }))

      const submitRes = await fetch('/api/swap/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Account included so the route can re-assert the self-swap property
        // on bytes that have been through the client and a wallet extension.
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
  }, [state.quote, address, adapter])

  return { ...state, requestQuote, confirm, reset }
}
