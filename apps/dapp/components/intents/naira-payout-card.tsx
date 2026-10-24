'use client'

import { cn } from '@intent/ui'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import {
  ArrowDown,
  BadgeCheck,
  Banknote,
  Check,
  Loader2,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'

import { useNairaPayout } from '../../hooks/use-naira-payout'
import type { NairaOrderView } from '../../lib/naira/orders'
import type { NairaStatus } from '../../lib/naira/status'
import { BankPicker, type Bank } from './bank-picker'

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

const STATUS_COPY: Record<NairaStatus, string> = {
  waiting: 'Waiting for your deposit to arrive.',
  processing: 'Deposit received. The bank transfer is on its way.',
  paid: 'Paid. The naira has been sent to the account.',
  expired: 'No deposit arrived in time, so this payout was cancelled. Nothing was taken.',
  failed: 'The bank transfer failed. Your XLM is returned to your account.',
}

/**
 * The card sits in the thread as the agents' side of it. In dark mode it steps
 * out of the purple bubbles onto a near-black grey (#1a1a1a), with its fields
 * in a deep purple (#191a33) of the brand's hue, so the form reads as a tool
 * rather than another message.
 */
const SHELL =
  'bg-bubble-agent text-bubble-agent-foreground border-bubble-agent-border flex flex-col rounded-3xl border p-5 shadow-[0_1px_3px_rgb(0_0_0/0.05)] dark:border-white/[0.06] dark:bg-[#1a1a1a] dark:text-foreground dark:shadow-[0_12px_40px_-16px_rgb(0_0_0/0.7)]'

const FIELD =
  'border-bubble-agent-border bg-background/70 focus-within:border-brand/60 focus-within:ring-brand/15 rounded-2xl border transition-all focus-within:ring-4 dark:border-white/[0.07] dark:bg-[#191a33]'

/** "DANIEL EMMANUEL OKPOHO" as a person would write it. Banks return names in capitals. */
function titleCase(name: string): string {
  return name.toLowerCase().replace(/(^|[\s'-])\p{L}/gu, (m) => m.toUpperCase())
}

function naira(n: number): string {
  return `₦${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function CardHeader({ title, subtitle }: { title: string; subtitle?: string }): JSX.Element {
  return (
    <div className="flex items-center gap-3">
      <span className="bg-bubble-me text-bubble-me-foreground flex h-10 w-10 shrink-0 items-center justify-center rounded-full">
        <Banknote className="h-5 w-5" />
      </span>
      <div className="flex flex-col leading-tight">
        <span className="text-sm font-semibold">{title}</span>
        {subtitle !== undefined ? (
          <span className="text-muted-foreground text-xs">{subtitle}</span>
        ) : null}
      </div>
    </div>
  )
}

const STEPS = ['Deposit', 'Bank transfer', 'Paid'] as const

/** Where a payout is, as three steps, so "in progress" says which part. */
function PayoutProgress({
  status,
  summary,
}: {
  status: NairaStatus
  summary: ReactNode
}): JSX.Element {
  const done = status === 'paid'
  const bad = status === 'failed' || status === 'expired'
  const reached = status === 'waiting' ? 0 : status === 'processing' ? 1 : 2
  return (
    <div className={cn(SHELL, 'gap-4')}>
      <CardHeader
        title={done ? 'Payout complete' : bad ? 'Payout stopped' : 'Payout in progress'}
        subtitle={STATUS_COPY[status]}
      />
      {!bad ? (
        <ol className="flex items-center gap-2">
          {STEPS.map((label, i) => {
            const complete = i < reached || done
            const current = i === reached && !done
            return (
              <li key={label} className="flex flex-1 flex-col gap-1.5">
                <span
                  className={cn(
                    'h-1.5 rounded-full transition-colors',
                    complete ? 'bg-brand' : current ? 'bg-brand/40 animate-pulse' : 'bg-muted'
                  )}
                />
                <span
                  className={cn(
                    'flex items-center gap-1 text-[11px]',
                    complete || current ? 'font-medium' : 'text-muted-foreground'
                  )}
                >
                  {complete ? <Check className="text-brand h-3 w-3" /> : null}
                  {current ? (
                    <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />
                  ) : null}
                  {label}
                </span>
              </li>
            )
          })}
        </ol>
      ) : (
        <p className="text-destructive flex items-center gap-2 text-xs">
          <TriangleAlert className="h-3.5 w-3.5" />
          {status === 'expired' ? 'Expired' : 'Failed'}
        </p>
      )}
      <p className="bg-background/60 rounded-2xl px-4 py-3 text-sm tabular-nums dark:bg-[#191a33]">
        {summary}
      </p>
    </div>
  )
}

export function NairaPayoutCard({
  initialXlm,
  xlmPriceUsd,
  balanceXlm,
  asset = 'xlm',
  balanceUsdc,
  initialPath = 'xlm',
  onConvertFirst,
  onOrder,
  sourceSymbol,
  balanceOther,
}: {
  /** The amount asked for, in `asset`. */
  initialXlm?: number
  xlmPriceUsd?: number
  balanceXlm?: string
  /** What is being paid out: XLM, or USDC that is already held. */
  asset?: 'xlm' | 'usdc'
  balanceUsdc?: string
  /**
   * A verified asset other than XLM or USDC. It is always converted to USDC
   * first, since only XLM and USDC reach the payout provider.
   */
  sourceSymbol?: string
  balanceOther?: string
  /** Which route the form opens on; the user can change it. */
  initialPath?: 'xlm' | 'usdc'
  /**
   * Hands the filled form to the swap flow. Absent means the convert-first
   * route is not offered and the form only pays XLM directly.
   */
  onConvertFirst?: (v: { amountXlm: number; bankCode: string; accountNumber: string }) => void
  /** Told each time the order changes, so the chat can keep how the cash-out went. */
  onOrder?: (order: NairaOrderView) => void
}): JSX.Element {
  const { state, create, pay, edit } = useNairaPayout()
  const seenOrder = state.order
  useEffect(() => {
    if (seenOrder !== undefined) onOrder?.(seenOrder)
    // The order object is replaced on every change; the callback is not a trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seenOrder])

  const [amount, setAmount] = useState(initialXlm !== undefined ? String(initialXlm) : '')
  const [bankCode, setBankCode] = useState('')
  const [accountNumber, setAccountNumber] = useState('')
  const other = sourceSymbol !== undefined
  const [path, setPath] = useState<'xlm' | 'usdc'>(
    other ? 'usdc' : onConvertFirst !== undefined ? initialPath : 'xlm'
  )

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

  const symbol = other ? sourceSymbol : asset === 'usdc' ? 'USDC' : 'XLM'
  const xlm = Number(amount)
  // XLM keeps a reserve back for fees and the account; USDC does not, because
  // fees are paid in XLM.
  const balance = other ? balanceOther : asset === 'usdc' ? balanceUsdc : balanceXlm
  const maxXlm =
    balance !== undefined
      ? Math.max(0, Number(balance) - (asset === 'usdc' || other ? 0 : KEEP_XLM))
      : undefined
  // A dollar of USDC is a dollar; XLM is priced.
  const unitUsd = other ? undefined : asset === 'usdc' ? 1 : xlmPriceUsd
  const estimateNgn =
    rate.data !== undefined && unitUsd !== undefined && xlm > 0
      ? Math.floor(xlm * unitUsd * rate.data * 100) / 100
      : undefined

  const overBalance = maxXlm !== undefined && xlm > maxXlm
  const canReview =
    xlm > 0 &&
    (other || (estimateNgn !== undefined && estimateNgn > 0)) &&
    !overBalance &&
    holder.data !== undefined

  const bankName = useMemo(
    () => banks.data?.find((b) => b.code === bankCode)?.name,
    [banks.data, bankCode]
  )

  const { phase, order } = state

  if (phase === 'tracking' && order !== undefined) {
    return (
      <PayoutProgress
        status={order.status}
        summary={
          <>
            {order.amount} {order.coin.toUpperCase()} to {naira(Number(order.amountNgn))} for{' '}
            {order.accountName}, {order.bankName} {order.accountMask}
          </>
        }
      />
    )
  }

  if (
    (phase === 'review' || phase === 'signing' || phase === 'submitting') &&
    order !== undefined
  ) {
    const busy = phase !== 'review'
    return (
      <div className={cn(SHELL, 'gap-5')}>
        <CardHeader title="Review payout" subtitle="The rate is locked for this order." />

        <div className="bg-background/60 flex flex-col items-center gap-1 rounded-2xl px-4 py-5 text-center tabular-nums dark:bg-[#191a33]">
          <span className="text-muted-foreground text-xs">You send</span>
          <span className="text-lg font-semibold">
            {order.amount} {order.coin.toUpperCase()}
          </span>
          <span className="bg-bubble-me text-bubble-me-foreground my-1 flex h-7 w-7 items-center justify-center rounded-full">
            <ArrowDown className="h-3.5 w-3.5" />
          </span>
          <span className="text-muted-foreground text-xs">{order.accountName} receives</span>
          <span className="text-3xl font-semibold tracking-tight">
            {naira(Number(order.amountNgn))}
          </span>
        </div>

        <dl className="divide-bubble-agent-border flex flex-col divide-y text-sm tabular-nums dark:divide-white/[0.07]">
          {(
            [
              [
                'Rate',
                `₦${Number(order.rate).toLocaleString('en-US')} per ${order.coin.toUpperCase()}`,
              ],
              ['Account holder', order.accountName],
              ['Bank', `${order.bankName} ${order.accountMask}`],
            ] as const
          ).map(([k, v]) => (
            <div key={k} className="flex items-center justify-between gap-4 py-2.5">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="text-right font-medium">{v}</dd>
            </div>
          ))}
          <div className="flex items-center justify-between gap-4 py-2.5">
            <dt className="text-muted-foreground">Pays to</dt>
            <dd className="text-right">
              <a
                href={`https://stellar.expert/explorer/public/account/${order.depositAddress}`}
                target="_blank"
                rel="noreferrer"
                title={order.depositAddress}
                className="bg-muted rounded-full px-2.5 py-1 font-mono text-xs underline-offset-2 hover:underline"
              >
                {order.depositAddress.slice(0, 6)}…{order.depositAddress.slice(-6)}
              </a>
            </dd>
          </div>
        </dl>

        <div className="bg-bubble-me/40 flex gap-2.5 rounded-2xl px-4 py-3 text-xs">
          <ShieldCheck className="text-brand mt-0.5 h-4 w-4 shrink-0" />
          <p className="leading-relaxed">
            Send the payment within 10 minutes or it is cancelled. This is a one-time deposit
            address made for this payout, so a wallet security scan can flag it. Before you sign,
            check that the address your wallet shows starts with{' '}
            <span className="font-mono font-semibold">{order.depositAddress.slice(0, 6)}</span> and
            ends with{' '}
            <span className="font-mono font-semibold">{order.depositAddress.slice(-6)}</span>.
          </p>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={pay}
            className="bg-bubble-me text-bubble-me-foreground hover:bg-brand hover:text-brand-foreground flex h-11 flex-1 items-center justify-center gap-2 rounded-full text-sm font-medium transition-colors disabled:opacity-60"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : null}
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
            className="border-bubble-agent-foreground/15 hover:bg-bubble-agent-foreground/5 h-11 rounded-full border px-5 text-sm transition-colors disabled:opacity-50"
          >
            Edit
          </button>
        </div>
      </div>
    )
  }

  if (phase === 'failed') {
    return (
      <div className={cn(SHELL, 'gap-3 border-dashed')}>
        <p className="flex items-start gap-2 text-sm">
          <TriangleAlert className="text-destructive mt-0.5 h-4 w-4 shrink-0" />
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
          className="border-bubble-agent-foreground/15 hover:bg-bubble-agent-foreground/5 w-fit rounded-full border px-4 py-2 text-sm transition-colors"
        >
          Back to the form
        </button>
      </div>
    )
  }

  return (
    <div className={cn(SHELL, 'gap-5')}>
      <CardHeader
        title={
          path === 'usdc'
            ? `Convert ${symbol} to USDC, then pay out naira`
            : `Cash out ${symbol} to naira`
        }
        subtitle="Paid straight to a Nigerian bank account"
      />

      {onConvertFirst !== undefined && !other ? (
        <div className="flex flex-col gap-2">
          <div
            role="radiogroup"
            aria-label="How to pay"
            className="bg-muted/70 grid grid-cols-2 rounded-full p-1 dark:bg-[#191a33]"
          >
            {(
              [
                ['xlm', 'Send XLM directly'],
                ['usdc', 'Convert to USDC first'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={path === value}
                onClick={() => setPath(value)}
                className={cn(
                  'relative rounded-full px-3 py-2 text-xs font-medium transition-colors',
                  path === value ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {path === value ? (
                  <motion.span
                    layoutId="naira-path-thumb"
                    className="bg-background absolute inset-0 rounded-full shadow-sm"
                    transition={{ type: 'spring', stiffness: 500, damping: 38 }}
                  />
                ) : null}
                <span className="relative">{label}</span>
              </button>
            ))}
          </div>
          <p className="text-muted-foreground px-1 text-xs">
            {path === 'xlm'
              ? `One signature. Your ${symbol} goes straight to the payout.`
              : 'Two signatures. Agents compete on the swap, then the USDC is paid out. Swap fees and slippage apply.'}
          </p>
        </div>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <div className={cn(FIELD, 'px-4 pb-3 pt-2.5', overBalance && 'border-destructive/60')}>
          <div className="text-muted-foreground flex items-center justify-between text-xs">
            <label htmlFor="naira-amount">You send</label>
            {balance !== undefined ? (
              <span className="flex items-center gap-1.5">
                Available {Number(balance).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                {maxXlm !== undefined && maxXlm > 0 ? (
                  <button
                    type="button"
                    onClick={() => setAmount(String(Math.floor(maxXlm * 100) / 100))}
                    className="bg-bubble-me text-bubble-me-foreground hover:bg-bubble-me/80 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide transition-colors"
                  >
                    Max
                  </button>
                ) : null}
              </span>
            ) : null}
          </div>
          <div className="mt-1 flex items-center gap-2">
            <input
              id="naira-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
              placeholder="0.00"
              className="placeholder:text-muted-foreground/50 min-w-0 flex-1 bg-transparent text-2xl font-semibold tabular-nums outline-none"
            />
            <span className="bg-muted rounded-full px-3 py-1 text-sm font-medium">{symbol}</span>
          </div>
          <div className="border-bubble-agent-border mt-2 border-t pt-2 text-xs dark:border-white/[0.07]">
            {other ? (
              <span className="text-muted-foreground">
                Agents compete on the swap into USDC, then the USDC is paid out. The final figure is
                shown before you sign the payout.
              </span>
            ) : estimateNgn !== undefined ? (
              <span className="flex flex-wrap items-baseline justify-between gap-x-2">
                <span>
                  ≈{' '}
                  <span className="text-base font-semibold tabular-nums">{naira(estimateNgn)}</span>
                </span>
                <span className="text-muted-foreground">
                  {path === 'usdc'
                    ? 'Final figure shown before you sign the payout.'
                    : 'Rate locks when you review.'}
                </span>
              </span>
            ) : (
              <span className="text-muted-foreground">
                {rate.isError
                  ? (rate.error as Error).message
                  : 'Enter an amount to see what the bank receives.'}
              </span>
            )}
          </div>
        </div>
        {overBalance ? (
          <p className="text-destructive px-1 text-xs">
            {asset === 'usdc'
              ? `That is more ${symbol} than the account holds.`
              : `That is more than you can spend. About ${KEEP_XLM} XLM stays in your account for the reserve and fees.`}
          </p>
        ) : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="naira-bank" className="text-muted-foreground px-1 text-xs">
            Bank
          </label>
          <BankPicker
            id="naira-bank"
            banks={banks.data}
            loading={banks.isLoading}
            value={bankCode}
            onChange={setBankCode}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="naira-account"
            className="text-muted-foreground flex justify-between px-1 text-xs"
          >
            Account number
            <span className="tabular-nums">{accountNumber.length}/10</span>
          </label>
          <div className={cn(FIELD, 'flex h-12 items-center px-3')}>
            <input
              id="naira-account"
              inputMode="numeric"
              maxLength={10}
              value={accountNumber}
              onChange={(e) => setAccountNumber(e.target.value.replace(/\D/g, ''))}
              placeholder="0123456789"
              className="placeholder:text-muted-foreground/50 min-w-0 flex-1 bg-transparent text-sm tabular-nums tracking-[0.15em] outline-none"
            />
          </div>
          {/* The name the bank gave for the account, said the way a banking
              app says it: under the number, in the holder's own name. */}
          <div className="flex min-h-[24px] items-center px-1 text-xs" aria-live="polite">
            {holder.isFetching ? (
              <span className="text-muted-foreground flex items-center gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />
                Checking with the bank…
              </span>
            ) : holder.data !== undefined ? (
              <motion.span
                initial={{ opacity: 0, y: -2 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex items-center gap-1.5"
              >
                <span className="font-medium">{titleCase(holder.data)}</span>
                <BadgeCheck className="text-brand h-3.5 w-3.5" aria-label="Verified by the bank" />
              </motion.span>
            ) : holder.isError ? (
              <span className="text-destructive">{(holder.error as Error).message}</span>
            ) : null}
          </div>
        </div>
      </div>

      <button
        type="button"
        disabled={!canReview || phase === 'creating'}
        onClick={() => {
          if (estimateNgn === undefined && !other) return
          if (path === 'usdc' && onConvertFirst !== undefined) {
            onConvertFirst({ amountXlm: xlm, bankCode, accountNumber })
            return
          }
          if (estimateNgn === undefined) return
          create({
            amountNgn: estimateNgn,
            bankCode,
            accountNumber,
            ...(asset === 'usdc' ? { usdc: xlm } : {}),
          })
        }}
        className="bg-bubble-me text-bubble-me-foreground hover:bg-brand hover:text-brand-foreground disabled:hover:bg-bubble-me disabled:hover:text-bubble-me-foreground flex h-12 items-center justify-center gap-2 rounded-full text-sm font-medium transition-colors disabled:opacity-50"
      >
        {phase === 'creating' ? (
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
        ) : null}
        {phase === 'creating'
          ? 'Setting up your payout…'
          : path === 'usdc'
            ? 'Compare swap routes'
            : bankName !== undefined
              ? `Review payout to ${bankName}`
              : 'Review payout'}
      </button>
    </div>
  )
}

/**
 * Follows a payout that was set up by the swap flow, from the order's id.
 *
 * The card above follows its own orders; a two-leg payout is made inside the
 * sequence, so this reads the same record by id until it reaches an end.
 */
export function NairaOrderTracker({ orderId }: { orderId: string }): JSX.Element {
  const order = useQuery({
    queryKey: ['naira-order', orderId],
    queryFn: async () => {
      const res = await fetch(`/api/naira/orders/${orderId}`)
      const body = (await res.json()) as {
        order?: {
          status: NairaStatus
          amount: string
          coin: string
          amountNgn: string
          accountName: string
          bankName: string
          accountMask: string
        }
      }
      if (!res.ok || body.order === undefined) throw new Error('Could not read the payout.')
      return body.order
    },
    refetchInterval: (query) => {
      const status = query.state.data?.status
      return status === 'paid' || status === 'failed' || status === 'expired' ? false : 5_000
    },
  })

  const data = order.data
  if (data === undefined) {
    return (
      <div className={cn(SHELL, 'text-muted-foreground flex-row items-center gap-2 text-sm')}>
        <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
        Checking your payout…
      </div>
    )
  }

  return (
    <PayoutProgress
      status={data.status}
      summary={
        <>
          {data.amount} {data.coin.toUpperCase()} to {naira(Number(data.amountNgn))} for{' '}
          {data.accountName}, {data.bankName} {data.accountMask}
        </>
      }
    />
  )
}
