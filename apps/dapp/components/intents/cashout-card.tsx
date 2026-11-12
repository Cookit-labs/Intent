'use client'

import { accountExplorerUrl } from '@intent/config'
import { cn } from '@intent/ui'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import {
  ArrowDown,
  ArrowRight,
  BadgeCheck,
  Banknote,
  Check,
  ExternalLink,
  Loader2,
  ShieldCheck,
  Timer,
  TriangleAlert,
} from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'

import { fetchCashoutCurrencies, type Cashout } from '../../hooks/use-cashout'
import { useWallet } from '../../hooks/use-wallet'
import { walletFetch } from '../../lib/api/network-fetch'
import {
  accountHint,
  canSign,
  CHECK_WALLET,
  cleanIdentifier,
  depositExplorerUrl,
  DO_NOT_RESEND,
  explorerName,
  formatPayout,
  formatUsdc,
  isRealHolderName,
  isValidAmount,
  NO_CASHOUTS,
  shouldPoll,
  payoutProvider,
  statusText,
  withBankLogos,
  type CashoutInstitution,
  type CashoutOrderView,
  type CashoutQuote,
} from '../../lib/weave/cashout-view'
import { currencyFlag, payoutWord } from '../../lib/weave/currency-flag'
import { isCashoutChain } from '../../lib/weave/types'
import { useChain } from '../../providers/chain-provider'
import { TokenIcon } from '../ui/token-icon'
import type { TurnCard } from '../../lib/chat/turn-card'
import { cashoutAmountFrom } from '../../lib/chains/sequence'
import { BankMark, BankPicker, type Bank } from './bank-picker'
import { toolCard, toolPanel } from './bubble'

/**
 * The cash-out form on every chain Weave pays out from.
 *
 * Its screens are the naira form's, copied from `naira-payout-card.tsx` so a
 * person sees one form whichever chain they are on. Only what that form says about
 * Linq in particular differs, where it would be untrue of Weave: the rate is an
 * estimate here and is not locked.
 */

const SHELL = toolCard

const FIELD =
  'border-bubble-agent-border bg-background/70 focus-within:border-brand/60 focus-within:ring-brand/15 rounded-2xl border transition-all focus-within:ring-4 dark:border-white/[0.07] dark:bg-[#121212]'

/** How long an order waits for its deposit when Weave doesn't say. */
const PAY_WINDOW_MS = 10 * 60 * 1000

function titleCase(name: string): string {
  return name.toLowerCase().replace(/(^|[\s'-])\p{L}/gu, (m) => m.toUpperCase())
}

function CardHeader({
  title,
  subtitle,
  tone = 'brand',
}: {
  title: string
  subtitle?: string
  tone?: 'brand' | 'verified' | 'warning'
}): JSX.Element {
  return (
    <div className="flex items-center gap-3">
      {tone === 'verified' ? (
        <BadgeCheck
          className="fill-brand text-brand-foreground h-10 w-10 shrink-0"
          aria-label="Complete"
          role="img"
        />
      ) : (
        <span
          className={cn(
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-full',
            tone === 'warning'
              ? 'bg-warning/15 text-warning'
              : 'bg-bubble-me text-bubble-me-foreground'
          )}
        >
          {tone === 'warning' ? (
            <TriangleAlert className="h-5 w-5" />
          ) : (
            <Banknote className="h-5 w-5" />
          )}
        </span>
      )}
      <div className="flex flex-col leading-tight">
        <span className="text-sm font-semibold">{title}</span>
        {subtitle !== undefined ? (
          <span className="text-muted-foreground text-xs">{subtitle}</span>
        ) : null}
      </div>
    </div>
  )
}

/** Which provider pays the order, with its logo, as one more row of the card's list. */
function RoutedThrough({
  order,
  className,
}: {
  order: CashoutOrderView
  className: string
}): JSX.Element {
  const provider = payoutProvider(order)
  return (
    <div className={cn('flex items-center justify-between gap-4', className)}>
      <dt className="text-muted-foreground">Routed through</dt>
      <dd className="flex items-center gap-1.5 text-right font-medium">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={provider.logo}
          alt=""
          width={18}
          height={18}
          className="h-[18px] w-[18px] rounded-full object-cover"
        />
        {provider.name}
      </dd>
    </div>
  )
}

function PayoutProgress({
  order,
  bank,
  hash,
  explorerUrl,
  unsure,
  onRetry,
}: {
  order: CashoutOrderView
  bank?: Bank | undefined
  hash?: string | undefined
  explorerUrl?: string | undefined
  /** Set while a transfer may have gone out and its outcome isn't known. */
  unsure?: string | undefined
  /** Absent on a card kept in the chat after its turn, which offers nothing to press. */
  onRetry?: (() => void) | undefined
}): JSX.Element {
  const done = order.status === 'paid'
  // What Weave says reached the account, after every fee. Only this is shown once paid.
  const paid = done ? order.paidDest : undefined
  const running = shouldPoll(order.status)
  const bad = !done && !running
  const reached = order.status === 'waiting' ? 0 : order.status === 'processing' ? 1 : 2
  const isNaira = order.currency === 'NGN'
  const steps = ['Deposit', isNaira ? 'Bank transfer' : 'Payout', 'Paid']
  const known = order.depositHash ?? hash
  const href =
    known === undefined || known === ''
      ? undefined
      : explorerUrl !== undefined && explorerUrl !== ''
        ? explorerUrl
        : isCashoutChain(order.chain)
          ? depositExplorerUrl(order.chain, known)
          : undefined
  return (
    <div className={cn(SHELL, 'gap-4')}>
      <CardHeader
        tone={done ? 'verified' : bad || unsure !== undefined ? 'warning' : 'brand'}
        title={
          done
            ? 'Payout complete'
            : bad
              ? 'Payout stopped'
              : unsure !== undefined
                ? 'Transfer sent, outcome not known yet'
                : 'Payout in progress'
        }
        subtitle={
          done
            ? `Paid to ${order.institutionName}`
            : statusText(order.status, payoutProvider(order).id)
        }
      />

      {unsure !== undefined && running ? (
        <p role="status" className="text-sm leading-relaxed">
          {unsure}
        </p>
      ) : null}

      {running ? (
        <ol className="flex items-center gap-2">
          {steps.map((label, i) => {
            const complete = i < reached
            const current = i === reached
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
      ) : null}
      {bad && onRetry !== undefined ? (
        <button
          type="button"
          onClick={onRetry}
          className="border-border hover:border-foreground/40 w-fit self-start rounded-full border px-4 py-2 text-sm transition-colors"
        >
          Try the payout again
        </button>
      ) : null}

      <div
        className={cn(
          toolPanel,
          'flex flex-wrap items-center justify-center gap-3 px-4 py-5 tabular-nums'
        )}
      >
        <span className="flex items-center gap-2 text-lg font-semibold">
          <TokenIcon symbol="USDC" size={24} />
          {formatUsdc(order.amount)} USDC
        </span>
        <ArrowRight className="text-muted-foreground h-4 w-4" />
        <span className="flex items-center gap-2 text-lg font-semibold">
          {bank !== undefined ? <BankMark bank={bank} className="h-6 w-6" /> : null}
          {paid !== undefined
            ? formatPayout(paid, order.currency)
            : done
              ? 'Confirming the amount paid…'
              : `${order.exactDest === true ? '' : '≈ '}${formatPayout(order.estimatedDest, order.currency)}`}
        </span>
      </div>

      <dl className="divide-bubble-agent-border flex flex-col divide-y text-sm dark:divide-white/[0.07]">
        <div className="flex items-center justify-between gap-4 py-2">
          <dt className="text-muted-foreground">Account holder</dt>
          <dd className="text-right font-medium">
            {isRealHolderName(order.accountName) ? order.accountName : 'Not confirmed'}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-4 py-2">
          <dt className="text-muted-foreground">{isNaira ? 'Bank' : 'Paid to'}</dt>
          <dd className="text-right font-medium">
            {order.institutionName} {order.accountMask}
          </dd>
        </div>
        <RoutedThrough order={order} className="py-2" />
      </dl>

      {href !== undefined && isCashoutChain(order.chain) ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="bg-bubble-me text-bubble-me-foreground hover:bg-brand hover:text-brand-foreground inline-flex w-fit items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors"
        >
          View payment on {explorerName(order.chain)}
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      ) : null}

      {running ? (
        <p className="text-muted-foreground text-xs">
          Your USDC has left or is leaving your wallet. {DO_NOT_RESEND}
        </p>
      ) : null}
    </div>
  )
}

function BeforeYouSign({
  address,
  expiresAt,
}: {
  address: string
  expiresAt?: string | undefined
}): JSX.Element {
  const [deadline] = useState(() => {
    const stated = expiresAt !== undefined ? Date.parse(expiresAt) : Number.NaN
    return Number.isNaN(stated) ? Date.now() + PAY_WINDOW_MS : stated
  })
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])

  const left = Math.max(0, deadline - now)
  const expired = left === 0
  const mm = Math.floor(left / 60_000)
  const ss = String(Math.floor((left % 60_000) / 1000)).padStart(2, '0')

  return (
    <div className="bg-background/60 divide-bubble-agent-border flex flex-col divide-y rounded-2xl text-sm dark:divide-white/[0.07] dark:bg-[#121212]">
      <div className="flex items-center gap-3 px-4 py-3">
        <span
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
            expired
              ? 'bg-destructive/15 text-destructive'
              : 'bg-bubble-me text-bubble-me-foreground'
          )}
        >
          <Timer className="h-4 w-4" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="font-medium">{expired ? 'Time is up' : 'Pay within'}</span>
          <span className="text-muted-foreground text-xs">
            {expired
              ? 'This payout will be cancelled. Use Edit to start a new one.'
              : 'Unpaid orders are cancelled. Nothing is taken.'}
          </span>
        </div>
        <span
          className={cn(
            'font-mono text-lg font-semibold tabular-nums',
            expired ? 'text-destructive' : left < 120_000 ? 'text-warning' : undefined
          )}
          aria-live="off"
        >
          {mm}:{ss}
        </span>
      </div>

      <div className="flex items-start gap-3 px-4 py-3">
        <span className="bg-bubble-me text-bubble-me-foreground flex h-8 w-8 shrink-0 items-center justify-center rounded-full">
          <ShieldCheck className="h-4 w-4" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="font-medium leading-tight">Match the address in your wallet</span>
          <span className="flex flex-wrap items-center gap-1.5 font-mono text-xs">
            <span className="bg-brand/15 text-brand dark:bg-brand/30 dark:text-bubble-me rounded-md px-1.5 py-0.5 font-semibold">
              {address.slice(0, 6)}
            </span>
            <span className="text-muted-foreground tracking-widest">···</span>
            <span className="bg-brand/15 text-brand dark:bg-brand/30 dark:text-bubble-me rounded-md px-1.5 py-0.5 font-semibold">
              {address.slice(-6)}
            </span>
          </span>
          <span className="text-muted-foreground text-xs leading-relaxed">
            A one-time deposit address made for this payout, so a wallet security scan may flag it
            as new.
          </span>
        </div>
      </div>
    </div>
  )
}

function Message({ children }: { children: ReactNode }): JSX.Element {
  return <div className={cn(SHELL, 'gap-3 border-dashed')}>{children}</div>
}

const BACK_BUTTON =
  'border-bubble-agent-foreground/15 hover:bg-bubble-agent-foreground/5 w-fit rounded-full border px-4 py-2 text-sm transition-colors'

/**
 * The account number is held here and in the requests that check and use it, and
 * nowhere else: not in the chat, its history or any log.
 */
/** A payout's last screen, kept in the chat once its turn is behind it. */
export function FrozenPayoutCard({
  card,
}: {
  card: Extract<TurnCard, { kind: 'weave' }>
}): JSX.Element {
  return (
    <PayoutProgress
      order={card.order}
      bank={card.bank}
      hash={card.hash}
      explorerUrl={card.explorerUrl}
    />
  )
}

export function CashoutCard({
  cashout,
  onFinal,
}: {
  cashout: Cashout
  /** Told the payout screen's contents each time they change, so the chat can keep it. */
  onFinal?: (card: Extract<TurnCard, { kind: 'weave' }>) => void
}): JSX.Element | null {
  const { slug, descriptor } = useChain()
  const { address, isWrongNetwork, switchNetwork, isSwitching } = useWallet()
  const seed = cashout.session?.seed

  const [amount, setAmount] = useState(seed?.amount ?? '')
  const [settledAmount, setSettledAmount] = useState(seed?.amount ?? '')
  const [bankCode, setBankCode] = useState('')
  const [accountNumber, setAccountNumber] = useState('')
  const [settledAccount, setSettledAccount] = useState('')

  useEffect(() => {
    const id = window.setTimeout(() => setSettledAmount(amount), 400)
    return () => window.clearTimeout(id)
  }, [amount])
  useEffect(() => {
    const id = window.setTimeout(() => setSettledAccount(accountNumber), 500)
    return () => window.clearTimeout(id)
  }, [accountNumber])

  const options = useQuery({
    queryKey: ['cashout-options', slug],
    queryFn: () => fetchCashoutCurrencies(slug),
    staleTime: 60_000,
    retry: false,
  })
  const currencies = options.data
  const seedAvailable =
    seed?.currency !== undefined && currencies?.some((c) => c.code === seed.currency) === true
  const currency = seedAvailable
    ? (seed?.currency as string)
    : (currencies?.find((c) => c.code === 'NGN')?.code ?? currencies?.[0]?.code ?? '')
  const corridor = currencies?.find((c) => c.code === currency)
  const isNaira = currency === 'NGN'

  const institutions = useQuery({
    queryKey: ['cashout-institutions', currency],
    queryFn: async () => {
      const res = await walletFetch(
        `/api/cashout/institutions?currency=${encodeURIComponent(currency)}`
      )
      const body = (await res.json()) as { institutions?: CashoutInstitution[]; message?: string }
      if (!res.ok || body.institutions === undefined) {
        throw new Error(body.message ?? 'Could not load the banks.')
      }
      return body.institutions
    },
    enabled: currency !== '',
    staleTime: 300_000,
    retry: false,
  })

  // The same list the naira form reads, for the same logos on the same banks.
  const nairaBanks = useQuery({
    queryKey: ['naira-banks'],
    queryFn: async () =>
      ((await (await fetch('/api/naira/banks')).json()) as { banks: Bank[] }).banks,
    staleTime: Infinity,
    enabled: isNaira,
  })

  const banks = useMemo<Bank[] | undefined>(
    () =>
      institutions.data === undefined
        ? undefined
        : withBankLogos(institutions.data, isNaira ? (nairaBanks.data ?? []) : [], currency),
    [institutions.data, nairaBanks.data, isNaira, currency]
  )

  const balanceQuery = useQuery({
    queryKey: ['cashout-balance', slug, address],
    queryFn: async () => {
      const params = new URLSearchParams({ chain: slug, account: address as string })
      const res = await walletFetch(`/api/cashout/balance?${params.toString()}`)
      const body = (await res.json()) as { balance?: string }
      if (!res.ok || body.balance === undefined) throw new Error('No balance.')
      return body.balance
    },
    enabled: address !== undefined,
    staleTime: 15_000,
    retry: false,
  })
  const balance = balanceQuery.data

  const quoteReady = currency !== '' && isValidAmount(settledAmount)
  const quote = useQuery({
    queryKey: ['cashout-quote', slug, currency, settledAmount],
    queryFn: async () => {
      const params = new URLSearchParams({ chain: slug, currency, amount: settledAmount })
      const res = await walletFetch(`/api/cashout/quote?${params.toString()}`)
      const body = (await res.json()) as Partial<CashoutQuote> & { message?: string }
      if (!res.ok || body.destAmount === undefined) {
        throw new Error(body.message ?? 'No estimate is available for this amount.')
      }
      return body as CashoutQuote
    },
    enabled: quoteReady,
    staleTime: 20_000,
    retry: false,
  })

  const picked = institutions.data?.find((i) => i.code === bankCode)
  const hint = accountHint(picked?.type, currency)
  const accountToCheck = isNaira ? accountNumber : settledAccount
  const accountReady =
    bankCode !== '' && (isNaira ? /^\d{10}$/.test(accountToCheck) : accountToCheck.length >= 6)
  const holder = useQuery({
    queryKey: ['cashout-holder', currency, bankCode, accountToCheck],
    queryFn: async () => {
      const res = await walletFetch('/api/cashout/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currency,
          institution: bankCode,
          accountIdentifier: accountToCheck,
        }),
      })
      const body = (await res.json()) as { accountName?: string; message?: string }
      if (!res.ok || body.accountName === undefined) {
        throw new Error(body.message ?? 'That account could not be verified.')
      }
      return body.accountName
    },
    enabled: accountReady,
    staleTime: Infinity,
    retry: false,
  })

  const { phase, order } = cashout
  const reviewBank = banks?.find((b) => b.code === bankCode || b.name === order?.institutionName)

  const tracking = (phase === 'tracking' || phase === 'pending') && order !== undefined
  useEffect(() => {
    if (!tracking || onFinal === undefined) return
    onFinal({
      kind: 'weave',
      order,
      ...(reviewBank !== undefined ? { bank: reviewBank } : {}),
      ...(cashout.hash !== undefined ? { hash: cashout.hash } : {}),
      ...(cashout.explorerUrl !== undefined ? { explorerUrl: cashout.explorerUrl } : {}),
    })
    // Said again only when what the screen shows changes; a new callback each render is not that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracking, order, reviewBank, cashout.hash, cashout.explorerUrl])

  if (cashout.session === null) return null

  if ((phase === 'tracking' || phase === 'pending') && order !== undefined) {
    return (
      <PayoutProgress
        order={order}
        bank={reviewBank}
        hash={cashout.hash}
        explorerUrl={cashout.explorerUrl}
        unsure={phase === 'pending' ? cashout.error : undefined}
        onRetry={cashout.startOver}
      />
    )
  }

  if (phase === 'check' && order !== undefined) {
    return (
      <div className={cn(SHELL, 'gap-4')}>
        <CardHeader tone="warning" title="Check your wallet before trying again" />
        <p role="status" className="text-sm leading-relaxed">
          {CHECK_WALLET}
        </p>
        <p className="text-muted-foreground text-xs">
          If your wallet shows it was sent, {DO_NOT_RESEND.toLowerCase()} This page keeps following
          the order.
        </p>
        <button type="button" onClick={cashout.checkedTryAgain} className={BACK_BUTTON}>
          I checked, try again
        </button>
      </div>
    )
  }

  if (
    (phase === 'review' || phase === 'signing' || phase === 'submitting') &&
    order !== undefined
  ) {
    const busy = phase !== 'review'
    const destination = Number(order.estimatedDest)
    const about = order.exactDest === true ? '' : '≈ '
    return (
      <div className={cn(SHELL, 'gap-5')}>
        <CardHeader
          title="Review payout"
          subtitle={
            order.exactDest === true
              ? 'The exact amount this account receives, after the provider’s fees. The provider has locked it.'
              : 'An estimate after the provider’s fees. What lands can be a few percent lower, and the receipt shows the exact amount paid.'
          }
        />

        <div className="bg-background/60 flex flex-col items-center gap-1 rounded-2xl px-4 py-5 text-center tabular-nums dark:bg-[#121212]">
          <span className="text-muted-foreground text-xs">You send</span>
          <span className="text-lg font-semibold">{formatUsdc(order.amount)} USDC</span>
          {reviewBank !== undefined ? (
            <BankMark bank={reviewBank} className="my-1.5 h-9 w-9" />
          ) : (
            <span className="bg-bubble-me text-bubble-me-foreground my-1 flex h-7 w-7 items-center justify-center rounded-full">
              <ArrowDown className="h-3.5 w-3.5" />
            </span>
          )}
          <span className="text-muted-foreground text-xs">
            {isRealHolderName(order.accountName) ? order.accountName : 'This account'} receives
          </span>
          <span className="text-3xl font-semibold tracking-tight">
            {about}
            {formatPayout(destination, order.currency)}
          </span>
        </div>

        <dl className="divide-bubble-agent-border flex flex-col divide-y text-sm tabular-nums dark:divide-white/[0.07]">
          {(
            [
              [
                'Rate',
                `${about}${formatPayout(destination / Number(order.amount), order.currency)} per USDC`,
              ],
              [
                'Account holder',
                isRealHolderName(order.accountName) ? order.accountName : 'Not confirmed',
              ],
              [isNaira ? 'Bank' : 'Paid to', `${order.institutionName} ${order.accountMask}`],
            ] as const
          ).map(([k, v]) => (
            <div key={k} className="flex items-center justify-between gap-4 py-2.5">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="text-right font-medium">{v}</dd>
            </div>
          ))}
          <RoutedThrough order={order} className="py-2.5" />
          <div className="flex items-center justify-between gap-4 py-2.5">
            <dt className="text-muted-foreground">Pays to</dt>
            <dd className="text-right">
              <a
                href={accountExplorerUrl(slug, order.depositAddress)}
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

        <BeforeYouSign key={order.id} address={order.depositAddress} expiresAt={order.expiresAt} />

        {cashout.error !== undefined ? (
          <p role="alert" className="text-destructive text-sm">
            {cashout.error}
          </p>
        ) : null}

        <div className="flex gap-2">
          <button
            type="button"
            disabled={isWrongNetwork ? isSwitching : busy || !canSign(phase, order)}
            onClick={isWrongNetwork ? switchNetwork : cashout.pay}
            className="bg-bubble-me text-bubble-me-foreground hover:bg-brand hover:text-brand-foreground flex h-11 flex-1 items-center justify-center gap-2 rounded-full text-sm font-medium transition-colors disabled:opacity-60"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : null}
            {isWrongNetwork
              ? `Switch your wallet to ${descriptor.name}`
              : phase === 'signing'
                ? 'Waiting for your wallet…'
                : phase === 'submitting'
                  ? 'Sending…'
                  : 'Approve and sign'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={cashout.backToForm}
            className="border-bubble-agent-foreground/15 hover:bg-bubble-agent-foreground/5 h-11 shrink-0 rounded-full border px-5 text-sm transition-colors disabled:opacity-50"
          >
            Edit
          </button>
        </div>
      </div>
    )
  }

  if (phase === 'failed') {
    return (
      <Message>
        <p role="alert" className="flex items-start gap-2 text-sm">
          <TriangleAlert className="text-destructive mt-0.5 h-4 w-4 shrink-0" />
          {cashout.error ?? 'The payout did not go through.'}
        </p>
        <button
          type="button"
          onClick={order !== undefined ? cashout.retryReview : cashout.backToForm}
          className={BACK_BUTTON}
        >
          {order !== undefined ? 'Back to the review' : 'Back to the form'}
        </button>
      </Message>
    )
  }

  if (options.isLoading) {
    return (
      <div className={cn(SHELL, 'text-muted-foreground flex-row items-center gap-2 text-sm')}>
        <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
        Checking where you can cash out…
      </div>
    )
  }

  if (currencies === undefined || currencies.length === 0) {
    return (
      <Message>
        <p className="text-sm">{NO_CASHOUTS}</p>
        <button type="button" onClick={cashout.dismiss} className={BACK_BUTTON}>
          Close
        </button>
      </Message>
    )
  }

  const send = Number(amount)
  const maxAmount = balance !== undefined ? Number(balance) : undefined
  const overBalance = maxAmount !== undefined && send > maxAmount
  const estimate = quoteReady && quote.data !== undefined ? quote.data : undefined
  const canReview =
    isValidAmount(amount) && estimate !== undefined && !overBalance && holder.data !== undefined
  const bankName = banks?.find((b) => b.code === bankCode)?.name
  const word = payoutWord(institutions.data?.map((i) => i.type) ?? [])
  const holderWord = picked?.type === 'mobile_money' ? 'mobile money provider' : 'bank'
  const flag = currencyFlag(currency)
  const creating = phase === 'creating'

  return (
    <div className={cn(SHELL, 'gap-5')}>
      <CardHeader
        title={`Cash out USDC to ${isNaira ? 'naira' : (corridor?.name ?? currency)}`}
        subtitle={
          isNaira
            ? 'Paid straight to a Nigerian bank account'
            : `Paid straight to a ${word} account in ${corridor?.country ?? currency}`
        }
      />

      {seed?.currency !== undefined && !seedAvailable ? (
        <p className="text-muted-foreground px-1 text-xs">
          {seed.currency} isn&apos;t available here, so this pays out in {currency}.
        </p>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <div className={cn(FIELD, 'px-4 pb-3 pt-2.5', overBalance && 'border-destructive/60')}>
          <div className="text-muted-foreground flex items-center justify-between text-xs">
            <label htmlFor="cashout-amount">You send</label>
            {balance !== undefined ? (
              <span className="flex items-center gap-1.5">
                Available {Number(balance).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                {maxAmount !== undefined && maxAmount > 0 ? (
                  <button
                    type="button"
                    onClick={() => setAmount(cashoutAmountFrom(balance) ?? '')}
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
              id="cashout-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
              placeholder="0.00"
              className="placeholder:text-muted-foreground/50 min-w-0 flex-1 bg-transparent text-2xl font-semibold tabular-nums outline-none"
            />
            <span className="bg-muted flex items-center gap-1.5 rounded-full py-1 pl-1 pr-3 text-sm font-medium">
              <TokenIcon symbol="USDC" size={20} />
              USDC
            </span>
          </div>
          <div className="border-bubble-agent-border mt-2 border-t pt-2 text-xs dark:border-white/[0.07]">
            {estimate !== undefined ? (
              <span className="flex flex-wrap items-baseline justify-between gap-x-2">
                <span className="flex items-center gap-1.5">
                  ≈{' '}
                  {flag !== undefined ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={flag.src}
                      alt={`${flag.country} flag`}
                      width={20}
                      height={15}
                      className="h-[15px] w-5 rounded-[2px] object-cover"
                    />
                  ) : null}
                  <span className="text-base font-semibold tabular-nums">
                    {formatPayout(estimate.destAmount, currency)}
                  </span>
                </span>
                <span className="text-muted-foreground">
                  Estimate. You see the exact amount before you sign.
                </span>
              </span>
            ) : (
              <span className="text-muted-foreground">
                {quote.isError && quoteReady
                  ? (quote.error as Error).message
                  : isNaira
                    ? 'Enter an amount to see what the bank receives.'
                    : 'Enter an amount to see what you receive.'}
              </span>
            )}
          </div>
        </div>
        {overBalance ? (
          <p className="text-destructive px-1 text-xs">That is more USDC than the account holds.</p>
        ) : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="cashout-bank" className="text-muted-foreground px-1 text-xs">
            {isNaira ? 'Bank' : word.charAt(0).toUpperCase() + word.slice(1)}
          </label>
          <BankPicker
            id="cashout-bank"
            banks={banks}
            loading={institutions.isLoading}
            value={bankCode}
            onChange={setBankCode}
          />
          {institutions.isError ? (
            <p className="text-destructive px-1 text-xs">{(institutions.error as Error).message}</p>
          ) : null}
        </div>
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="cashout-account"
            className="text-muted-foreground flex justify-between px-1 text-xs"
          >
            {isNaira ? 'Account number' : hint.label}
            {isNaira ? <span className="tabular-nums">{accountNumber.length}/10</span> : null}
          </label>
          <div className={cn(FIELD, 'flex h-12 items-center px-3')}>
            <input
              id="cashout-account"
              inputMode={isNaira ? 'numeric' : hint.inputMode}
              autoComplete="off"
              maxLength={isNaira ? 10 : 20}
              value={accountNumber}
              onChange={(e) =>
                setAccountNumber(
                  isNaira ? e.target.value.replace(/\D/g, '') : cleanIdentifier(e.target.value)
                )
              }
              placeholder={isNaira ? '0123456789' : hint.placeholder}
              className="placeholder:text-muted-foreground/50 min-w-0 flex-1 bg-transparent text-sm tabular-nums tracking-[0.15em] outline-none"
            />
          </div>
          <div className="flex min-h-[24px] items-center px-1 text-xs" aria-live="polite">
            {holder.isFetching ? (
              <span className="text-muted-foreground flex items-center gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />
                Checking with the {holderWord}…
              </span>
            ) : holder.data !== undefined && accountReady ? (
              <motion.span
                initial={{ opacity: 0, y: -2 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex items-center gap-1.5"
              >
                {isRealHolderName(holder.data) ? (
                  <>
                    <span className="font-medium">{titleCase(holder.data)}</span>
                    <BadgeCheck
                      className="text-brand h-3.5 w-3.5"
                      aria-label={`Verified by the ${holderWord}`}
                    />
                  </>
                ) : (
                  <span className="text-warning">
                    The {holderWord} can&apos;t confirm a name here, so check this number carefully.
                  </span>
                )}
              </motion.span>
            ) : holder.isError ? (
              <span className="text-destructive">{(holder.error as Error).message}</span>
            ) : null}
          </div>
        </div>
      </div>

      <button
        type="button"
        disabled={!canReview || creating}
        onClick={() =>
          cashout.create({
            currency,
            institution: bankCode,
            accountIdentifier: accountNumber,
            amount,
          })
        }
        className="bg-bubble-me text-bubble-me-foreground hover:bg-brand hover:text-brand-foreground disabled:hover:bg-bubble-me disabled:hover:text-bubble-me-foreground flex h-12 items-center justify-center gap-2 rounded-full text-sm font-medium transition-colors disabled:opacity-50"
      >
        {creating ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : null}
        {creating
          ? 'Setting up your payout…'
          : bankName !== undefined
            ? `Review payout to ${bankName}`
            : 'Review payout'}
      </button>
    </div>
  )
}
