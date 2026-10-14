'use client'

import { useQuery } from '@tanstack/react-query'
import { Banknote, Check, Loader2, TriangleAlert } from 'lucide-react'
import { useMemo, useState } from 'react'

import { useNairaPayout } from '../../hooks/use-naira-payout'
import type { NairaStatus } from '../../lib/naira/status'

/**
 * The form an agent drops into the thread when an instruction is read as a
 * cash-out to naira.
 *
 * The account holder is never typed: it is looked up from the bank once the ten
 * digits are in, shown read-only, and the server looks it up again when the
 * order is made. What the user approves is therefore a name the bank gave, not
 * one the page supplied.
 */

/** Left in the account for the reserve and fees when "Max" is used. */
const KEEP_XLM = 2

interface Bank {
  code: string
  name: string
}

const STATUS_COPY: Record<NairaStatus, string> = {
  waiting: 'Waiting for your deposit to arrive.',
  processing: 'Deposit received. The bank transfer is on its way.',
  paid: 'Paid. The naira has been sent to the account.',
  expired: 'No deposit arrived in time, so this payout was cancelled. Nothing was taken.',
  failed: 'The bank transfer failed. Your XLM is returned to your account.',
}

function naira(n: number): string {
  return `₦${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function NairaPayoutCard({
  initialXlm,
  xlmPriceUsd,
  balanceXlm,
}: {
  initialXlm?: number
  xlmPriceUsd?: number
  balanceXlm?: string
}): JSX.Element {
  const { state, create, pay, edit } = useNairaPayout()

  const [amount, setAmount] = useState(initialXlm !== undefined ? String(initialXlm) : '')
  const [bankCode, setBankCode] = useState('')
  const [accountNumber, setAccountNumber] = useState('')

  const banks = useQuery({
    queryKey: ['naira-banks'],
    queryFn: async () =>
      ((await (await fetch('/api/naira/banks')).json()) as { banks: Bank[] }).banks,
    staleTime: Infinity,
  })

  const rate = useQuery({
    queryKey: ['naira-rate'],
    queryFn: async () => {
      const res = await fetch('/api/naira/rate')
      const body = (await res.json()) as { ngnPerUsd?: number; message?: string }
      if (!res.ok || body.ngnPerUsd === undefined) throw new Error(body.message ?? 'No rate.')
      return body.ngnPerUsd
    },
    staleTime: 20_000,
    retry: false,
  })

  const digitsReady = /^\d{10}$/.test(accountNumber) && bankCode !== ''
  const holder = useQuery({
    queryKey: ['naira-holder', bankCode, accountNumber],
    queryFn: async () => {
      const res = await fetch('/api/naira/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bankCode, accountNumber }),
      })
      const body = (await res.json()) as { accountName?: string; message?: string }
      if (!res.ok || body.accountName === undefined) {
        throw new Error(body.message ?? 'That account could not be verified.')
      }
      return body.accountName
    },
    enabled: digitsReady,
    staleTime: Infinity,
    retry: false,
  })

  const xlm = Number(amount)
  const maxXlm = balanceXlm !== undefined ? Math.max(0, Number(balanceXlm) - KEEP_XLM) : undefined
  const estimateNgn =
    rate.data !== undefined && xlmPriceUsd !== undefined && xlm > 0
      ? Math.floor(xlm * xlmPriceUsd * rate.data * 100) / 100
      : undefined

  const overBalance = maxXlm !== undefined && xlm > maxXlm
  const canReview =
    xlm > 0 &&
    estimateNgn !== undefined &&
    estimateNgn > 0 &&
    !overBalance &&
    holder.data !== undefined

  const bankName = useMemo(
    () => banks.data?.find((b) => b.code === bankCode)?.name,
    [banks.data, bankCode]
  )

  const { phase, order } = state

  if (phase === 'tracking' && order !== undefined) {
    const done = order.status === 'paid'
    const bad = order.status === 'failed' || order.status === 'expired'
    return (
      <div className="border-border flex flex-col gap-3 rounded-2xl border p-5">
        <div className="flex items-center gap-2 text-sm font-medium">
          {done ? (
            <Check className="h-4 w-4" />
          ) : bad ? (
            <TriangleAlert className="h-4 w-4" />
          ) : (
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
          )}
          {done ? 'Payout complete' : bad ? 'Payout stopped' : 'Payout in progress'}
        </div>
        <p className="text-muted-foreground text-sm">{STATUS_COPY[order.status]}</p>
        <p className="text-sm tabular-nums">
          {order.amountXlm} XLM to {naira(Number(order.amountNgn))} for {order.accountName},{' '}
          {order.bankName} {order.accountMask}
        </p>
      </div>
    )
  }

  if (
    (phase === 'review' || phase === 'signing' || phase === 'submitting') &&
    order !== undefined
  ) {
    const busy = phase !== 'review'
    return (
      <div className="border-border flex flex-col gap-4 rounded-2xl border p-5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Banknote className="h-4 w-4" /> Review payout
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm tabular-nums">
          <dt className="text-muted-foreground">You send</dt>
          <dd className="text-right font-medium">{order.amountXlm} XLM</dd>
          <dt className="text-muted-foreground">They receive</dt>
          <dd className="text-right font-medium">{naira(Number(order.amountNgn))}</dd>
          <dt className="text-muted-foreground">Rate</dt>
          <dd className="text-right">₦{Number(order.rate).toLocaleString('en-US')} per XLM</dd>
          <dt className="text-muted-foreground">Account holder</dt>
          <dd className="text-right">{order.accountName}</dd>
          <dt className="text-muted-foreground">Bank</dt>
          <dd className="text-right">
            {order.bankName} {order.accountMask}
          </dd>
        </dl>
        <p className="text-muted-foreground text-xs">
          The rate is locked for this order. Send the payment within 10 minutes or it is cancelled.
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={pay}
            className="bg-foreground text-background rounded-full px-4 py-2 text-sm transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {phase === 'signing'
              ? 'Waiting for your wallet…'
              : phase === 'submitting'
                ? 'Sending…'
                : 'Approve and sign'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={edit}
            className="border-border hover:border-foreground/40 rounded-full border px-4 py-2 text-sm transition-colors disabled:opacity-50"
          >
            Edit
          </button>
        </div>
      </div>
    )
  }

  if (phase === 'failed') {
    return (
      <div className="border-border flex flex-col gap-3 rounded-2xl border border-dashed p-5">
        <p className="flex items-start gap-2 text-sm">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          {state.error ?? 'The payout did not go through.'}
        </p>
        {state.unknown === true ? (
          <p className="text-muted-foreground text-xs">
            The request may have reached the payout service. Retrying uses the same request, so it
            will not be paid twice.
          </p>
        ) : null}
        <button
          type="button"
          onClick={edit}
          className="border-border hover:border-foreground/40 w-fit rounded-full border px-4 py-2 text-sm transition-colors"
        >
          Back to the form
        </button>
      </div>
    )
  }

  return (
    <div className="border-border flex flex-col gap-5 rounded-2xl border p-5">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Banknote className="h-4 w-4" /> Cash out XLM to naira
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="text-muted-foreground flex items-baseline justify-between text-xs">
          <label htmlFor="naira-amount">Amount (XLM)</label>
          {balanceXlm !== undefined ? (
            <span>
              Available: {Number(balanceXlm).toLocaleString('en-US', { maximumFractionDigits: 2 })}{' '}
              XLM
              {maxXlm !== undefined && maxXlm > 0 ? (
                <button
                  type="button"
                  onClick={() => setAmount(String(Math.floor(maxXlm * 100) / 100))}
                  className="hover:text-foreground ml-2 underline underline-offset-2"
                >
                  Max
                </button>
              ) : null}
            </span>
          ) : null}
        </div>
        <input
          id="naira-amount"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
          placeholder="0.00"
          className="border-border bg-background rounded-xl border px-3 py-2.5 text-sm tabular-nums"
        />
        <p className="text-muted-foreground text-xs">
          {estimateNgn !== undefined
            ? `About ${naira(estimateNgn)}. The final rate is locked when you review.`
            : rate.isError
              ? (rate.error as Error).message
              : 'Enter an amount to see what the bank receives.'}
        </p>
        {overBalance ? (
          <p className="text-xs">
            That is more than you can spend. About {KEEP_XLM} XLM stays in your account for the
            reserve and fees.
          </p>
        ) : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="naira-bank" className="text-muted-foreground text-xs">
            Bank
          </label>
          <select
            id="naira-bank"
            value={bankCode}
            onChange={(e) => setBankCode(e.target.value)}
            className="border-border bg-background rounded-xl border px-3 py-2.5 text-sm"
          >
            <option value="">Select a bank</option>
            {(banks.data ?? []).map((b) => (
              <option key={b.code} value={b.code}>
                {b.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="naira-account" className="text-muted-foreground text-xs">
            Account number
          </label>
          <input
            id="naira-account"
            inputMode="numeric"
            maxLength={10}
            value={accountNumber}
            onChange={(e) => setAccountNumber(e.target.value.replace(/\D/g, ''))}
            placeholder="10-digit account number"
            className="border-border bg-background rounded-xl border px-3 py-2.5 text-sm tabular-nums"
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-muted-foreground text-xs">Account holder</span>
        <div className="border-border bg-muted/30 min-h-[42px] rounded-xl border px-3 py-2.5 text-sm">
          {holder.isFetching ? (
            <span className="text-muted-foreground flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
              Checking with the bank…
            </span>
          ) : holder.data !== undefined ? (
            <span className="flex items-center gap-2">
              <Check className="h-3.5 w-3.5" /> {holder.data}
            </span>
          ) : holder.isError ? (
            (holder.error as Error).message
          ) : (
            <span className="text-muted-foreground">Enter a complete account number</span>
          )}
        </div>
      </div>

      <button
        type="button"
        disabled={!canReview || phase === 'creating'}
        onClick={() => {
          if (estimateNgn === undefined) return
          create({ amountNgn: estimateNgn, bankCode, accountNumber })
        }}
        className="bg-foreground text-background rounded-full px-4 py-2.5 text-sm transition-opacity hover:opacity-90 disabled:opacity-40"
      >
        {phase === 'creating'
          ? 'Setting up your payout…'
          : bankName !== undefined
            ? `Review payout to ${bankName}`
            : 'Review payout'}
      </button>
    </div>
  )
}
