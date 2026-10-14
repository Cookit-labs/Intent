'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { useChain } from '../providers/chain-provider'
import { useWallet } from './use-wallet'
import type { NairaOrderView } from '../lib/naira/orders'
import { isTerminal } from '../lib/naira/status'

/**
 * One naira cash-out, from the filled form to the bank.
 *
 * form -> creating -> review -> signing -> submitting -> tracking
 *
 * Every step that matters is the server's: the order is created there, the
 * payment is built from the stored order there, and the signed bytes are
 * re-checked there before they are sent. This hook only carries the user's
 * answers up and the user's signature across.
 */

export type NairaPhase =
  | 'form'
  | 'creating'
  | 'review'
  | 'signing'
  | 'submitting'
  | 'tracking'
  | 'failed'

export interface NairaFormValues {
  amountNgn: number
  bankCode: string
  accountNumber: string
}

export interface NairaPayoutState {
  phase: NairaPhase
  order?: NairaOrderView
  error?: string
  /** True when the failure said nothing about whether the order exists. */
  unknown?: boolean
}

const POLL_MS = 5_000

interface ApiError {
  error?: string
  message?: string
}

export function useNairaPayout(): {
  state: NairaPayoutState
  create: (values: NairaFormValues) => void
  pay: () => void
  edit: () => void
} {
  const { address } = useWallet()
  const { adapter } = useChain()
  const [state, setState] = useState<NairaPayoutState>({ phase: 'form' })

  // Minted once per distinct request and reused on a retry of the same one, so
  // a timeout followed by a retry cannot become two payouts. A changed amount
  // or account is a different request and gets a fresh key.
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null)

  const create = useCallback(
    (values: NairaFormValues) => {
      if (address === undefined) {
        setState({ phase: 'failed', error: 'Connect a wallet first.' })
        return
      }
      const fingerprint = `${address}|${values.bankCode}|${values.accountNumber}|${values.amountNgn}`
      if (attempt.current === null || attempt.current.fingerprint !== fingerprint) {
        attempt.current = { fingerprint, key: crypto.randomUUID() }
      }
      const idempotencyKey = attempt.current.key

      setState({ phase: 'creating' })
      void (async () => {
        try {
          const res = await fetch('/api/naira/orders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ account: address, ...values, idempotencyKey }),
          })
          const body = (await res.json()) as { order?: NairaOrderView } & ApiError
          if (!res.ok || body.order === undefined) {
            setState({
              phase: 'failed',
              error: body.message ?? 'The payout could not be set up.',
              unknown: res.status === 504,
            })
            return
          }
          setState({ phase: 'review', order: body.order })
        } catch {
          setState({
            phase: 'failed',
            error: 'No answer from the network. Nothing was sent; try again.',
            unknown: true,
          })
        }
      })()
    },
    [address]
  )

  const pay = useCallback(() => {
    const order = state.order
    if (order === undefined || address === undefined) return
    const signer = address

    void (async () => {
      setState({ phase: 'signing', order })
      try {
        const buildRes = await fetch(`/api/naira/orders/${order.id}/build`, { method: 'POST' })
        const built = (await buildRes.json()) as { xdr?: string } & ApiError
        if (!buildRes.ok || built.xdr === undefined) {
          setState({
            phase: 'failed',
            order,
            error: built.message ?? 'The payment could not be built.',
          })
          return
        }

        const signed = await adapter.signTransaction?.({ xdr: built.xdr, address: signer })
        if (signed === undefined) {
          setState({ phase: 'failed', order, error: 'This wallet cannot sign here.' })
          return
        }
        if (!signed.ok) {
          // Declining goes back to review: the order is still on offer.
          if (signed.reason === 'rejected') {
            setState({ phase: 'review', order })
            return
          }
          setState({
            phase: 'failed',
            order,
            error: signed.detail ?? 'The wallet could not sign this payment.',
          })
          return
        }

        setState({ phase: 'submitting', order })
        const submitRes = await fetch(`/api/naira/orders/${order.id}/submit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ signedXdr: signed.signedXdr }),
        })
        const result = (await submitRes.json()) as { ok?: boolean; hash?: string } & ApiError
        if (!submitRes.ok || result.ok === false) {
          setState({
            phase: 'failed',
            order,
            error: result.message ?? result.error ?? 'The payment did not go through.',
          })
          return
        }
        setState({
          phase: 'tracking',
          order: { ...order, ...(result.hash !== undefined ? { paymentHash: result.hash } : {}) },
        })
      } catch {
        setState({ phase: 'failed', order, error: 'Could not reach the network.' })
      }
    })()
  }, [state.order, address, adapter])

  const edit = useCallback(() => setState({ phase: 'form' }), [])

  // Follows the order to its end. The webhook is the fast path; this is the
  // one that still works when a webhook is missed.
  const trackedId = state.phase === 'tracking' ? state.order?.id : undefined
  useEffect(() => {
    if (trackedId === undefined) return
    let cancelled = false

    async function poll(): Promise<void> {
      try {
        const res = await fetch(`/api/naira/orders/${trackedId as string}`)
        if (!res.ok || cancelled) return
        const body = (await res.json()) as { order?: NairaOrderView }
        if (body.order === undefined || cancelled) return
        const next = body.order
        setState((s) => (s.phase === 'tracking' ? { phase: 'tracking', order: next } : s))
      } catch {
        // The next tick tries again.
      }
    }

    void poll()
    const timer = setInterval(() => {
      if (state.order !== undefined && isTerminal(state.order.status)) return
      void poll()
    }, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
    // Restarted only when the tracked order changes, not on every status tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackedId])

  return { state, create, pay, edit }
}
