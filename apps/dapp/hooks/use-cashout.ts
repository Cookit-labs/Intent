'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { walletFetch } from '../lib/api/network-fetch'
import type { SignedOutcome, SigningPayload } from '../lib/chains/types'
import {
  accountMismatch,
  afterSubmit,
  afterWallet,
  canSign,
  depositConfirmed,
  isLocked,
  nextAttempt,
  orderPhase,
  shouldPoll,
  awaitsPaidAmount,
  PAID_AMOUNT_READS,
  type CashoutAttempt,
  type CashoutCurrency,
  type CashoutOrderView,
  type CashoutPhase,
} from '../lib/weave/cashout-view'
import type { CashoutCurrencyCode } from '../lib/weave/parse-cashout'
import { isCashoutChain } from '../lib/weave/types'
import { useChain } from '../providers/chain-provider'
import { useWallet } from './use-wallet'

const POLL_MS = 5_000

export interface CashoutDetails {
  currency: string
  institution: string
  accountIdentifier: string
  amount: string
}

export interface CashoutSeed {
  amount?: string
  currency?: CashoutCurrencyCode
}

interface CashoutState {
  phase: CashoutPhase
  order?: CashoutOrderView | undefined
  /** The wallet the order was made for. The only one allowed to sign it. */
  account?: string | undefined
  hash?: string | undefined
  explorerUrl?: string | undefined
  error?: string | undefined
}

export interface Cashout extends CashoutState {
  /** Set while the card is on screen. A new key means a fresh form. */
  session: { key: number; seed: CashoutSeed } | null
  /** True while money may be moving: the card stays, and no other cash-out can start. */
  locked: boolean
  open: (seed: CashoutSeed) => void
  dismiss: () => void
  create: (details: CashoutDetails) => void
  backToForm: () => void
  pay: () => void
  retryReview: () => void
  /** "I checked, try again": asks about the order once more, then offers signing only if it hasn't moved. */
  checkedTryAgain: () => void
  startOver: () => void
}

interface ApiError {
  error?: string
  message?: string
}

function messageOf(body: ApiError, fallback: string): string {
  return body.message ?? fallback
}

async function readBody<T>(res: Response): Promise<T & ApiError> {
  try {
    return (await res.json()) as T & ApiError
  } catch {
    return {} as T & ApiError
  }
}

/** The currencies a chain pays out in. Nothing at all reads as none available. */
export async function fetchCashoutCurrencies(chain: string): Promise<CashoutCurrency[]> {
  try {
    const res = await walletFetch(`/api/cashout/options?chain=${encodeURIComponent(chain)}`)
    if (!res.ok) return []
    const body = await readBody<{ currencies?: CashoutCurrency[] }>(res)
    return body.currencies ?? []
  } catch {
    return []
  }
}

async function readOrder(id: string): Promise<CashoutOrderView | undefined> {
  try {
    const res = await walletFetch(`/api/cashout/orders/${id}`)
    if (!res.ok) return undefined
    return (await readBody<{ order?: CashoutOrderView }>(res)).order
  } catch {
    return undefined
  }
}

/**
 * One cash-out, from the form to the account.
 *
 * form -> creating -> review -> signing -> submitting
 * -> tracking | pending | check | failed
 *
 * Lives beside the chat, not inside the card, so a cash-out under way survives
 * the card leaving the screen and blocks another from starting.
 */
export function useCashout(): Cashout {
  const { slug, adapter } = useChain()
  const { address } = useWallet()
  const [state, setState] = useState<CashoutState>({ phase: 'form' })
  const [opened, setOpened] = useState<{
    key: number
    seed: CashoutSeed
    chain: string
  } | null>(null)

  const attempt = useRef<CashoutAttempt | null>(null)
  const sending = useRef(false)
  // Read at the last moment before the wallet opens: building takes a while.
  const connected = useRef(address)
  useEffect(() => {
    connected.current = address
  }, [address])
  // A request answered after the person moved on must not bring its step back.
  const generation = useRef(0)

  const locked = isLocked(state.phase, state.order)

  const open = useCallback(
    (seed: CashoutSeed) => {
      if (locked) return
      generation.current += 1
      setState({ phase: 'form' })
      setOpened((o) => ({ key: (o?.key ?? 0) + 1, seed, chain: slug }))
    },
    [locked, slug]
  )

  const dismiss = useCallback(() => {
    if (locked) return
    generation.current += 1
    setOpened(null)
    setState({ phase: 'form' })
  }, [locked])

  const create = useCallback(
    (values: CashoutDetails) => {
      if (address === undefined) {
        setState({ phase: 'failed', error: 'Connect a wallet first.' })
        return
      }
      if (!isCashoutChain(slug)) return
      const account = address
      const chain = slug

      attempt.current = nextAttempt(
        attempt.current,
        [
          account,
          chain,
          values.currency,
          values.institution,
          values.accountIdentifier,
          values.amount,
        ].join('|'),
        () => crypto.randomUUID()
      )
      const idempotencyKey = attempt.current.key

      generation.current += 1
      const run = generation.current
      setState({ phase: 'creating' })
      void (async () => {
        try {
          const res = await walletFetch('/api/cashout/orders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chain, account, ...values, idempotencyKey }),
          })
          const body = await readBody<{ order?: CashoutOrderView }>(res)
          if (body.error === 'order_closed') attempt.current = null
          if (run !== generation.current) return
          if (!res.ok || body.order === undefined) {
            setState({
              phase: 'failed',
              error: messageOf(body, 'The payout could not be set up. Nothing was sent.'),
            })
            return
          }
          setState({ phase: orderPhase(body.order), order: body.order, account })
        } catch {
          if (run !== generation.current) return
          setState({
            phase: 'failed',
            error:
              'No answer from the network. Nothing was sent. Trying again uses the same request, so it will not make a second order.',
          })
        }
      })()
    },
    [address, slug]
  )

  const pay = useCallback(() => {
    const order = state.order
    const account = state.account
    if (!canSign(state.phase, order) || order === undefined || sending.current) return
    if (account === undefined) return
    const wrongWallet = accountMismatch(address, account)
    if (wrongWallet !== undefined) {
      setState((s) => ({ ...s, error: wrongWallet }))
      return
    }
    sending.current = true
    const id = order.id

    void (async () => {
      try {
        setState((s) => ({ ...s, phase: 'signing', error: undefined }))

        let signing: SigningPayload | undefined
        try {
          const res = await walletFetch(`/api/cashout/orders/${id}/build`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          })
          const body = await readBody<{ signing?: SigningPayload }>(res)
          if (!res.ok || body.signing === undefined) {
            const error = messageOf(body, 'The deposit could not be built. Nothing was sent.')
            setState((s) => ({ ...s, phase: 'failed', error }))
            return
          }
          signing = body.signing
        } catch {
          setState((s) => ({
            ...s,
            phase: 'failed',
            error: 'Could not reach the network. Nothing was sent.',
          }))
          return
        }

        const switched = accountMismatch(connected.current, account)
        if (switched !== undefined) {
          setState((s) => ({ ...s, phase: 'review', error: switched }))
          return
        }

        const family = signing.family
        let outcome: SignedOutcome
        try {
          const asked = adapter.signPrepared?.(signing)
          if (asked === undefined) {
            setState((s) => ({
              ...s,
              phase: 'failed',
              error: 'This wallet cannot sign here yet. Nothing was sent.',
            }))
            return
          }
          outcome = await asked
        } catch {
          outcome = { ok: false, reason: 'wallet_error' }
        }

        const walletStep = afterWallet(outcome, family)
        if (walletStep.next === 'review') {
          setState((s) => ({ ...s, phase: 'review' }))
          return
        }
        if (walletStep.next === 'failed') {
          setState((s) => ({ ...s, phase: 'failed', error: walletStep.error }))
          return
        }
        if (walletStep.next === 'check') {
          const latest = await readOrder(id)
          setState((s) => {
            const current = latest ?? s.order
            const moved = current !== undefined && depositConfirmed(current)
            return { ...s, phase: moved ? 'tracking' : 'check', order: current }
          })
          return
        }

        setState((s) => ({ ...s, phase: 'submitting' }))
        let answer: unknown
        try {
          const res = await walletFetch(`/api/cashout/orders/${id}/submit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ signed: walletStep.signed }),
          })
          answer = await res.json()
        } catch {
          answer = undefined
        }

        const submitStep = afterSubmit(answer, family)
        if (submitStep.next === 'tracking') {
          setState((s) => ({
            ...s,
            phase: 'tracking',
            hash: submitStep.hash,
            explorerUrl: submitStep.explorerUrl,
            error: undefined,
          }))
          return
        }
        setState((s) => ({ ...s, phase: submitStep.next, error: submitStep.error }))
      } finally {
        sending.current = false
      }
    })()
  }, [state.phase, state.order, state.account, address, adapter])

  const backToForm = useCallback(() => {
    setState((s) => (isLocked(s.phase, s.order) ? s : { phase: 'form' }))
  }, [])

  const retryReview = useCallback(() => {
    setState((s) =>
      s.phase === 'failed' && s.order !== undefined
        ? { ...s, phase: 'review', error: undefined }
        : s
    )
  }, [])

  const checkedTryAgain = useCallback(() => {
    const id = state.phase === 'check' ? state.order?.id : undefined
    if (id === undefined) return
    void readOrder(id).then((latest) => {
      setState((s) => {
        if (s.phase !== 'check') return s
        const current = latest ?? s.order
        const moved = current !== undefined && depositConfirmed(current)
        return { ...s, phase: moved ? 'tracking' : 'review', order: current }
      })
    })
  }, [state.phase, state.order?.id])

  const startOver = useCallback(() => {
    if (locked) return
    generation.current += 1
    attempt.current = null
    setState({ phase: 'form' })
    setOpened((o) => ({ key: (o?.key ?? 0) + 1, seed: {}, chain: slug }))
  }, [locked, slug])

  // A paid order is read a few more times for what it paid, which is the figure the receipt shows.
  const paidReads = useRef(0)
  const orderId = state.order?.id
  useEffect(() => {
    paidReads.current = 0
  }, [orderId])
  const trackedId =
    (state.phase === 'tracking' || state.phase === 'pending' || state.phase === 'check') &&
    state.order !== undefined &&
    (shouldPoll(state.order.status) ||
      (awaitsPaidAmount(state.order) && paidReads.current < PAID_AMOUNT_READS))
      ? state.order.id
      : undefined

  useEffect(() => {
    if (trackedId === undefined) return
    const id = trackedId
    let cancelled = false

    async function poll(): Promise<void> {
      try {
        const res = await walletFetch(`/api/cashout/orders/${id}`)
        if (!res.ok || cancelled) return
        const body = (await res.json()) as { order?: CashoutOrderView }
        const next = body.order
        if (next === undefined || cancelled) return
        if (awaitsPaidAmount(next)) paidReads.current += 1
        setState((s) => {
          if (s.order?.id !== next.id) return s
          const unsure = s.phase === 'pending' || s.phase === 'check'
          if (unsure && depositConfirmed(next)) {
            return { ...s, phase: 'tracking', order: next, error: undefined }
          }
          return s.phase === 'tracking' || unsure ? { ...s, order: next } : s
        })
      } catch {
        // The next tick tries again.
      }
    }

    void poll()
    const timer = setInterval(() => void poll(), POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [trackedId])

  const status = state.order?.status
  useEffect(() => {
    if (status !== undefined && !shouldPoll(status)) attempt.current = null
  }, [status])

  const onThisChain = opened !== null && opened.chain === slug
  const session = opened !== null && (onThisChain || locked) ? opened : null

  return {
    ...state,
    session,
    locked,
    open,
    dismiss,
    create,
    backToForm,
    pay,
    retryReview,
    checkedTryAgain,
    startOver,
  }
}
