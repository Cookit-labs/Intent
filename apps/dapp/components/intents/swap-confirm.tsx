'use client'

import { ChainMark, cn } from '@intent/ui'
import {
  ArrowDown,
  ArrowLeftRight,
  BadgeCheck,
  Check,
  Copy,
  ExternalLink,
  Loader2,
  TriangleAlert,
} from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'

import type { SwapPhase } from '../../hooks/use-swap'
import { confirmPauseUsd, needsConfirmPause } from '../../lib/swap/confirm-pause'
import type { LedgerPreview as LedgerPreviewData } from '../../lib/swap/preview'
import { sourceDisplayName, type SwapQuote } from '../../lib/swap/quote'
import { needsTrustCaution, trustSummary, verificationOf } from '../../lib/swap/asset-registry'
import { TokenIcon } from '../ui/token-icon'
import { toolCard, toolPanel } from './bubble'
import { LedgerPreview } from './ledger-preview'

/**
 * The last screen before money moves.
 *
 * Written on the assumption that a user reads exactly one thing before signing:
 * what they give and what they get. Those are the largest elements; everything
 * else — route, source, slippage — is present but subordinate.
 *
 * The wallet is the real confirmation step, so this deliberately does not try
 * to be one. It shows the numbers, then hands over.
 *
 * One exception: a trade whose USD value crosses a threshold holds the
 * primary button disabled for a couple of seconds, with a visible countdown
 * and a one-line reason. Not a second signature gate — the wallet still owns
 * that — but a forced pause on the one screen most likely to be misread in a
 * hurry, for the one class of mistake (a fat-fingered amount, a plan that
 * looks fine at a glance but is worth acting slowly on) a wallet's own prompt
 * does nothing to catch.
 */

/**
 * The threshold itself, inlined at build time like every other
 * `NEXT_PUBLIC_` value in this app. Not read from `trade-cap.ts`'s
 * `MAINNET_MAX_TRADE_USD`: that is a server-side hard cap enforced at submit
 * time, checked against the live price table rather than the client's
 * `usdPrices` snapshot, and it exists to refuse a trade outright. This is a
 * client-side pause that exists to slow a human down, and the two moving
 * independently is deliberate — raising the hard cap to let bigger trades
 * through should not silently also raise how much friction a human sees
 * first, and vice versa.
 */
const CONFIRM_PAUSE_THRESHOLD_USD = Number(
  process.env.NEXT_PUBLIC_SWAP_CONFIRM_THRESHOLD_USD ?? '500'
)

/** Seconds the primary button stays disabled once the threshold is crossed. */
const CONFIRM_PAUSE_SECONDS = 2

/**
 * Counts down from `CONFIRM_PAUSE_SECONDS` once per distinct `(active, key)`
 * pair; resets to 0 — no pause — whenever `active` is false. `key` identifies
 * the specific amount being paused on, so a quote that refreshes to the same
 * numbers keeps whatever the countdown already reached, but an edited amount
 * — still over threshold, now a different number — gets a fresh pause rather
 * than inheriting a countdown that was timing a different trade.
 */
function useConfirmPause(active: boolean, key: string): number {
  const [secondsLeft, setSecondsLeft] = useState(active ? CONFIRM_PAUSE_SECONDS : 0)

  useEffect(() => {
    if (!active) {
      setSecondsLeft(0)
      return
    }
    setSecondsLeft(CONFIRM_PAUSE_SECONDS)
    const interval = setInterval(() => {
      setSecondsLeft((s) => Math.max(0, s - 1))
    }, 1000)
    return () => clearInterval(interval)
  }, [active, key])

  return secondsLeft
}

/** The USD value of an amount, or undefined when the price is unknown. */
function sendUsdRaw(
  value: string | undefined,
  symbol: string | undefined,
  prices: Record<string, number> | undefined
): number | undefined {
  if (value === undefined || symbol === undefined || prices === undefined) return undefined
  const price = prices[symbol]
  const qty = Number(value)
  if (price === undefined || !Number.isFinite(qty)) return undefined
  return qty * price
}

function usdValue(
  value: string | undefined,
  symbol: string | undefined,
  prices: Record<string, number> | undefined
): string | undefined {
  const usd = sendUsdRaw(value, symbol, prices)
  if (usd === undefined) return undefined
  return `~$${usd.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
}

function amount(value: string | undefined): string {
  if (value === undefined) return '—'
  const n = Number(value)
  // Seven decimals is exact but unreadable; four is enough to check a price.
  return n.toLocaleString('en-US', { maximumFractionDigits: 4 })
}

/** An icon in a round tint beside a title, as every tool card in the thread opens. */
function CardHeader({
  icon,
  tone = 'brand',
  title,
  subtitle,
}: {
  icon: ReactNode
  tone?: 'brand' | 'verified' | 'warning'
  title: string
  subtitle?: string | undefined
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
          {icon}
        </span>
      )}
      <div className="flex min-w-0 flex-col leading-tight">
        <span className="text-sm font-semibold">{title}</span>
        {subtitle !== undefined && subtitle !== '' ? (
          <span className="text-muted-foreground truncate text-xs">{subtitle}</span>
        ) : null}
      </div>
    </div>
  )
}

/** One side of the trade: label, amount large, token pill, dollar value small. */
function AmountRow({
  label,
  symbol,
  value,
  usd,
}: {
  label: string
  symbol: string | undefined
  value: string | undefined
  usd: string | undefined
}): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 flex-col">
        <span className="text-muted-foreground text-xs">{label}</span>
        <span className="truncate text-2xl font-semibold tabular-nums">{amount(value)}</span>
        {usd !== undefined ? (
          <span className="text-muted-foreground text-xs tabular-nums">{usd}</span>
        ) : null}
      </div>
      <span className="bg-muted flex shrink-0 items-center gap-1.5 rounded-full py-1 pl-1 pr-3 text-sm font-medium">
        <TokenIcon symbol={symbol} size={22} />
        {symbol}
      </span>
    </div>
  )
}

/** The transaction hash, short, with a copy button: 64 characters say nothing at a glance. */
function HashChip({ hash }: { hash: string }): JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      title={hash}
      onClick={() => {
        void navigator.clipboard.writeText(hash).then(() => {
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1500)
        })
      }}
      className="bg-muted text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 font-mono text-xs transition-colors"
    >
      {hash.slice(0, 6)}…{hash.slice(-6)}
      {copied ? <Check className="text-success h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  )
}

/**
 * The venue's mark beside its name. Stellar DEX is the network's own order
 * book, so it draws the Stellar mark; the others use their logos.
 */
function SourceLogo({ source }: { source: string | undefined }): JSX.Element | null {
  if (source === undefined) return null
  if (source === 'horizon') {
    return <ChainMark chain="stellar" className="h-4 w-4 shrink-0 rounded-full" />
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/images/venues/${source}.webp`}
      alt=""
      aria-hidden
      className="ring-border/60 h-4 w-4 shrink-0 rounded-full object-cover ring-1"
      onError={(e) => {
        e.currentTarget.style.display = 'none'
      }}
    />
  )
}

const PRIMARY =
  'bg-bubble-me text-bubble-me-foreground hover:bg-brand hover:text-brand-foreground flex h-11 items-center justify-center gap-2 rounded-full px-5 text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-60'
const SECONDARY =
  'border-bubble-agent-foreground/15 hover:bg-bubble-agent-foreground/5 h-11 shrink-0 rounded-full border px-5 text-sm transition-colors dark:border-white/15 dark:hover:bg-white/5'

export function SwapConfirm({
  phase,
  quote,
  sendDisplay,
  receiveDisplay,
  hash,
  explorerUrl,
  error,
  usdPrices,
  agentName,
  sliceCount,
  horizonMinutes,
  preview,
  onConfirm,
  onReset,
}: {
  phase: SwapPhase
  // Explicit `| undefined` rather than `?`: under exactOptionalPropertyTypes a
  // caller spreading state cannot pass an absent-or-undefined value into an
  // optional prop, and every one of these is genuinely absent before a quote.
  quote: SwapQuote | undefined
  sendDisplay: string | undefined
  receiveDisplay: string | undefined
  hash: string | undefined
  explorerUrl: string | undefined
  error: string | undefined
  /**
   * Real USD prices per symbol, for showing what the amounts are worth.
   *
   * On testnet the quoted rate is synthetic and can be an order of magnitude
   * off the real market, so showing the dollar value is what stops "88.4134
   * USDC" reading as a sensible return on a $30 order.
   */
  usdPrices: Record<string, number> | undefined
  /**
   * The agent whose plan is about to be signed.
   *
   * Every agent routes through the same quote today, so the amounts alone are
   * identical whoever is chosen — naming the agent and its plan is the only
   * thing on this card that reflects the choice the user just made.
   */
  agentName?: string | undefined
  sliceCount?: number | undefined
  horizonMinutes?: number | undefined
  preview?: LedgerPreviewData | undefined
  onConfirm: () => void
  onReset: () => void
}): JSX.Element | null {
  // Computed, and the hook called, before any early return: a conditional
  // hook call is a React error, and this one's inputs are all props, so
  // nothing here depends on the branching below.
  const pauseUsd = confirmPauseUsd(
    sendUsdRaw(sendDisplay, quote?.from.code, usdPrices),
    sendUsdRaw(receiveDisplay, quote?.to.code, usdPrices)
  )
  const pauseActive = phase === 'review' && needsConfirmPause(pauseUsd, CONFIRM_PAUSE_THRESHOLD_USD)
  const pauseSecondsLeft = useConfirmPause(
    pauseActive,
    `${sendDisplay ?? ''}:${receiveDisplay ?? ''}`
  )

  if (phase === 'idle') return null

  if (phase === 'quoting') {
    return (
      <div className={cn(toolCard, 'text-muted-foreground flex-row items-center gap-2 text-sm')}>
        <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
        Finding the best route…
      </div>
    )
  }

  if (phase === 'settled') {
    return (
      <div className={cn(toolCard, 'gap-4')}>
        <CardHeader
          tone="verified"
          icon={null}
          title="Swap complete"
          subtitle="Settled on Stellar"
        />
        <div
          className={cn(toolPanel, 'flex flex-wrap items-center justify-center gap-3 px-4 py-5')}
        >
          <span className="flex items-center gap-2 text-lg font-semibold tabular-nums">
            <TokenIcon symbol={quote?.from.code} size={24} />
            {amount(sendDisplay)} {quote?.from.code}
          </span>
          <ArrowLeftRight className="text-muted-foreground h-4 w-4" />
          <span className="flex items-center gap-2 text-lg font-semibold tabular-nums">
            <TokenIcon symbol={quote?.to.code} size={24} />
            {amount(receiveDisplay)} {quote?.to.code}
          </span>
        </div>
        {/* The explorer is the only independent proof the swap happened, so it
            is a button rather than a dim hash the eye slides past. */}
        <div className="flex flex-wrap items-center gap-2">
          {explorerUrl !== undefined ? (
            <a
              href={explorerUrl}
              target="_blank"
              rel="noreferrer"
              className="bg-bubble-me text-bubble-me-foreground hover:bg-brand hover:text-brand-foreground inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors"
            >
              View on Stellar Expert
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          ) : null}
          {hash !== undefined ? <HashChip hash={hash} /> : null}
          <button
            type="button"
            onClick={onReset}
            className="text-muted-foreground hover:text-foreground ml-auto rounded-full px-3 py-1.5 text-xs transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    )
  }

  if (phase === 'failed') {
    return (
      <div className={cn(toolCard, 'gap-4')}>
        <CardHeader
          tone="warning"
          icon={<TriangleAlert className="h-5 w-5" />}
          title="Swap not completed"
          subtitle={
            // A hash means it reached the network, so it may have spent a fee
            // or even settled: said as something to check, never as "nothing".
            explorerUrl !== undefined
              ? 'Check the transaction before trying again'
              : 'Nothing was spent'
          }
        />
        {/* The message is already user-facing prose from FAILURE_MESSAGES. */}
        <p className={cn(toolPanel, 'px-4 py-3 text-sm')}>{error ?? 'Something went wrong.'}</p>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={onReset} className={SECONDARY}>
            Try again
          </button>
          {explorerUrl !== undefined ? (
            <a
              href={explorerUrl}
              target="_blank"
              rel="noreferrer"
              className="bg-bubble-me text-bubble-me-foreground hover:bg-brand hover:text-brand-foreground inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors"
            >
              View on Stellar Expert
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          ) : null}
        </div>
      </div>
    )
  }

  const busy = phase === 'signing' || phase === 'submitting'
  const sendUsd = usdValue(sendDisplay, quote?.from.code, usdPrices)
  const receiveUsd = usdValue(receiveDisplay, quote?.to.code, usdPrices)
  // A wide gap between the two means the venue's rate disagrees with the real
  // market, which on testnet it always does. Saying so beats letting a user
  // read a synthetic return as a real one.
  const distorted =
    sendUsdRaw(sendDisplay, quote?.from.code, usdPrices) !== undefined &&
    sendUsdRaw(receiveDisplay, quote?.to.code, usdPrices) !== undefined &&
    Math.abs(
      (sendUsdRaw(receiveDisplay, quote?.to.code, usdPrices) as number) /
        (sendUsdRaw(sendDisplay, quote?.from.code, usdPrices) as number) -
        1
    ) > 0.25

  // The asset being *received* is the one worth explaining: that is what the
  // user ends up holding, and it is the side most likely to be unfamiliar.
  const receiving = quote?.to.code
  const assetNote =
    receiving !== undefined && verificationOf(receiving)?.category === 'rwa'
      ? verificationOf(receiving)?.description
      : undefined
  const trustCaution =
    receiving !== undefined && needsTrustCaution(receiving) ? trustSummary(receiving) : undefined

  const route = quote !== undefined ? sourceDisplayName(quote.source) : undefined
  const hops =
    quote?.path.length === 0
      ? 'direct'
      : `${quote?.path.length ?? 0} hop${quote?.path.length === 1 ? '' : 's'}`

  return (
    <div className={cn(toolCard, 'gap-4')}>
      <CardHeader
        icon={<ArrowLeftRight className="h-5 w-5" />}
        title="Review swap"
        subtitle={[agentName, route !== undefined ? `via ${route}` : undefined]
          .filter((v) => v !== undefined)
          .join(' · ')}
      />

      <div className={cn(toolPanel, 'flex flex-col gap-3 px-4 py-4')}>
        <AmountRow label="You pay" symbol={quote?.from.code} value={sendDisplay} usd={sendUsd} />
        <div className="relative flex items-center">
          <span className="border-bubble-agent-border w-full border-t dark:border-white/[0.07]" />
          <span className="bg-bubble-me text-bubble-me-foreground absolute left-1/2 flex h-7 w-7 -translate-x-1/2 items-center justify-center rounded-full">
            <ArrowDown className="h-3.5 w-3.5" />
          </span>
        </div>
        <AmountRow
          label="You receive, about"
          symbol={quote?.to.code}
          value={receiveDisplay}
          usd={receiveUsd}
        />
      </div>

      <dl className="divide-bubble-agent-border flex flex-col divide-y text-sm dark:divide-white/[0.07]">
        {/* The agents differ in how they execute, not in which route they can
            reach. Named per source, because "Soroswap" and "Soroswap
            Aggregator" are different claims about where a fill came from. */}
        <div className="flex items-center justify-between gap-4 py-2">
          <dt className="text-muted-foreground">Route</dt>
          <dd className="flex items-center justify-end gap-1.5 text-right font-medium">
            <SourceLogo source={quote?.source} />
            <span>
              {route ?? '—'} · {hops}
              {sliceCount === 1 ? ' · single fill' : ''}
            </span>
          </dd>
        </div>
        <div className="flex items-center justify-between gap-4 py-2">
          <dt className="text-muted-foreground">Max slippage</dt>
          <dd className="text-right font-medium">0.5%</dd>
        </div>
      </dl>

      <LedgerPreview preview={preview} />

      {/* What the asset is, and how well its issuer is established. A ticker
          says neither, and both matter more for a tokenized bond than for a
          currency the user already recognises. */}
      {assetNote !== undefined ? (
        <p className="text-muted-foreground text-xs">{assetNote}</p>
      ) : null}

      {/* Shown only when the issuer's domain has not confirmed it. Phrased as
          the specific gap rather than a generic warning: the vague version
          reads as "possibly a scam", and the canonical testnet USDC is not
          one — its issuer simply names a site that lists only mainnet. */}
      {trustCaution !== undefined ? (
        <div className="border-bubble-agent-border text-muted-foreground flex items-start gap-2 rounded-2xl border border-dashed p-3 text-xs dark:border-white/10">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{trustCaution}</span>
        </div>
      ) : null}

      {/* Not a second signature gate — the wallet prompt right after this is
          still the real one — but a forced pause before it, on the one
          screen most likely to be misread in a hurry on a trade this size. */}
      {pauseActive && pauseSecondsLeft > 0 ? (
        <p className="text-muted-foreground text-xs">
          This trade is worth about ${pauseUsd?.toFixed(0)}. Take a moment to check the amounts
          above before signing.
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy || (pauseActive && pauseSecondsLeft > 0)}
          className={cn(PRIMARY, 'flex-1')}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : null}
          {phase === 'signing'
            ? 'Confirm in your wallet'
            : phase === 'submitting'
              ? 'Submitting…'
              : pauseActive && pauseSecondsLeft > 0
                ? `Sign & swap (${pauseSecondsLeft})`
                : 'Sign & swap'}
        </button>
        {!busy ? (
          <button type="button" onClick={onReset} className={SECONDARY}>
            Cancel
          </button>
        ) : null}
      </div>

      {/* A sliced plan is what the agent proposed, not what this signature
          does: one path payment is built whatever the plan says. Showing "5
          slices" beside a single full-size transaction would misrepresent
          what is about to be signed. */}
      {sliceCount !== undefined && sliceCount > 1 ? (
        <p className="text-muted-foreground text-xs">
          {agentName ?? 'This agent'} proposed {sliceCount} slices
          {horizonMinutes !== undefined && horizonMinutes > 0
            ? ` over ${horizonMinutes} minutes`
            : ''}
          . Slicing is not executed yet — this signs the whole amount in one transaction.
        </p>
      ) : null}

      {distorted ? (
        <p className="text-warning text-xs">
          This testnet venue&apos;s rate differs sharply from the real market, so the amount you
          receive is not what this trade would return on mainnet.
        </p>
      ) : null}

      {/* Said plainly rather than buried: the amount is an estimate, and the
          floor is enforced by the network, not by this screen. */}
      <p className="text-muted-foreground text-xs">
        The received amount is an estimate. If the price moves more than 0.5%, the swap is cancelled
        and nothing is spent.
      </p>
    </div>
  )
}
