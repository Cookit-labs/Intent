'use client'

import { useCallback, useState } from 'react'

import { useChain } from '../providers/chain-provider'
import { useWallet } from './use-wallet'
import { FAILURE_MESSAGES } from '../lib/swap/submit'

/**
 * Placing and withdrawing a resting order.
 *
 * Modelled on `use-swap-execution`, which already proved the shape: build on
 * the server, sign in the wallet, submit, report. What differs is that an
 * offer can be *refused* before it is ever built — a limit price through the
 * spread would fill on contact — and that refusal is a first-class outcome
 * shown to the user rather than an error swallowed on the way.
 */

export type LimitPhase =
  | 'idle'
  | 'checking'
  | 'review'
  | 'signing'
  | 'submitting'
  | 'placed'
  | 'refused'
  | 'failed'

export interface LimitOrderState {
  phase: LimitPhase
  /** Unsigned envelope, held between review and signing. */
  xdr?: string
  /** The price this order will actually rest at. */
  priceDecimal?: number
  /** What the venue is quoting now, so the gap is visible. */
  marketPriceUsd?: number
  amount?: string
  /** Set once the placing transaction confirms. */
  hash?: string
  explorerUrl?: string
  /** The offer id on the ledger, needed to cancel it later. */
  offerId?: string
  error?: string
  /** Why an order was refused, when it was. */
  refusal?: 'would_fill_now' | 'no_market' | 'invalid_price'
}

export interface PlaceRequest {
  sellSymbol: string
  buySymbol: string
  amount: string
  limitPriceUsd: number
}

export interface LimitOrder extends LimitOrderState {
  /** Prices the order and prepares it for signature. Does not sign. */
  prepare: (req: PlaceRequest) => void
  /** Signs and submits what `prepare` produced. */
  confirm: () => void
  /** Withdraws a resting order, on-chain. */
  cancel: (offerId: string, sellSymbol: string, buySymbol: string) => void
  reset: () => void
}

interface BuildResponse {
  xdr?: string
  offerId?: string
  amount?: string
  priceDecimal?: number
  marketPriceUsd?: number
  error?: string
  detail?: string
}

export function useLimitOrder(): LimitOrder {
  const { adapter } = useChain()
  const { address, isConnected } = useWallet()
  const [state, setState] = useState<LimitOrderState>({ phase: 'idle' })

  const reset = useCallback(() => setState({ phase: 'idle' }), [])

  const prepare = useCallback(
    (req: PlaceRequest) => {
      if (!isConnected || address === undefined) {
        setState({ phase: 'failed', error: 'Connect a wallet to place an order.' })
        return
      }

      async function run(): Promise<void> {
        setState({ phase: 'checking' })

        try {
          const res = await fetch('/api/offers/build', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ account: address, ...req }),
          })
          const built = (await res.json()) as BuildResponse

          if (built.xdr === undefined) {
            // A price through the spread is refused rather than filled. This
            // is the whole reason the route checks the book first.
            if (
              built.error === 'would_fill_now' ||
              built.error === 'no_market' ||
              built.error === 'invalid_price'
            ) {
              setState({
                phase: 'refused',
                refusal: built.error,
                ...(built.detail !== undefined ? { error: built.detail } : {}),
                ...(built.marketPriceUsd !== undefined
                  ? { marketPriceUsd: built.marketPriceUsd }
                  : {}),
              })
              return
            }
            setState({
              phase: 'failed',
              error: built.detail ?? built.error ?? 'Could not prepare this order.',
            })
            return
          }

          setState({
            phase: 'review',
            xdr: built.xdr,
            ...(built.amount !== undefined ? { amount: built.amount } : {}),
            ...(built.priceDecimal !== undefined ? { priceDecimal: built.priceDecimal } : {}),
            ...(built.marketPriceUsd !== undefined ? { marketPriceUsd: built.marketPriceUsd } : {}),
          })
        } catch {
          setState({ phase: 'failed', error: 'Could not reach the network.' })
        }
      }

      void run()
    },
    [address, isConnected]
  )

  const submit = useCallback(
    async (xdr: string, account: string): Promise<void> => {
      setState((s) => ({ ...s, phase: 'signing' }))

      const signed = await adapter.signTransaction?.({ xdr, address: account })
      if (signed === undefined) {
        setState((s) => ({ ...s, phase: 'failed', error: 'This chain cannot place orders yet.' }))
        return
      }

      if (!signed.ok) {
        // Declining returns to review: the user chose that, and the order is
        // still on the table.
        if (signed.reason === 'rejected') {
          setState((s) => ({ ...s, phase: 'review' }))
          return
        }
        setState((s) => ({
          ...s,
          phase: 'failed',
          error: signed.detail ?? 'The wallet could not sign this order.',
        }))
        return
      }

      setState((s) => ({ ...s, phase: 'submitting' }))

      const res = await fetch('/api/offers/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signedXdr: signed.signedXdr, account }),
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
              : 'The order was not placed.',
        }))
        return
      }

      setState((s) => ({
        ...s,
        phase: 'placed',
        ...(result.hash !== undefined ? { hash: result.hash } : {}),
        ...(result.explorerUrl !== undefined ? { explorerUrl: result.explorerUrl } : {}),
      }))
    },
    [adapter]
  )

  const confirm = useCallback(() => {
    const xdr = state.xdr
    if (xdr === undefined || address === undefined) return

    void submit(xdr, address).catch(() => {
      setState((s) => ({ ...s, phase: 'failed', error: 'Something went wrong placing the order.' }))
    })
  }, [state.xdr, address, submit])

  const cancel = useCallback(
    (offerId: string, sellSymbol: string, buySymbol: string) => {
      if (address === undefined) return

      async function run(): Promise<void> {
        setState({ phase: 'checking' })

        try {
          const res = await fetch('/api/offers/build', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              account: address,
              sellSymbol,
              buySymbol,
              // Zero size removes the order. Stellar has no delete operation.
              amount: '0',
              offerId,
            }),
          })
          const built = (await res.json()) as BuildResponse

          if (built.xdr === undefined) {
            setState({
              phase: 'failed',
              error: built.detail ?? built.error ?? 'Could not prepare the cancellation.',
            })
            return
          }

          await submit(built.xdr, address as string)
        } catch {
          setState({ phase: 'failed', error: 'Could not reach the network.' })
        }
      }

      void run()
    },
    [address, submit]
  )

  return { ...state, prepare, confirm, cancel, reset }
}
