'use client'

import { Button, Card } from '@intent/ui'
import { ArrowRight, CheckCircle2, ExternalLink, Loader2, TriangleAlert } from 'lucide-react'

import type { SwapPhase } from '../../hooks/use-swap'
import type { SwapQuote } from '../../lib/swap/quote'
import { TokenIcon } from '../ui/token-icon'

/**
 * The last screen before money moves.
 *
 * Written on the assumption that a user reads exactly one thing before signing:
 * what they give and what they get. Those are the largest elements; everything
 * else — route, source, slippage — is present but subordinate.
 *
 * The wallet is the real confirmation step, so this deliberately does not try
 * to be one. It shows the numbers, then hands over.
 */

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
  onConfirm: () => void
  onReset: () => void
}): JSX.Element | null {
  if (phase === 'idle') return null

  if (phase === 'quoting') {
    return (
      <Card className="text-muted-foreground flex items-center gap-2 p-4 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        Finding the best route…
      </Card>
    )
  }

  if (phase === 'settled') {
    return (
      <Card className="flex flex-col gap-3 p-5">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="text-success h-5 w-5" />
          <span className="font-medium">Swap complete</span>
        </div>
        <p className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-sm">
          <TokenIcon symbol={quote?.from.code} size={16} />
          {amount(sendDisplay)} {quote?.from.code} became
          <TokenIcon symbol={quote?.to.code} size={16} />
          {amount(receiveDisplay)} {quote?.to.code}.
        </p>
        {/* The explorer is the only independent proof the swap happened, so it
            is a button rather than a dim hash the eye slides past. */}
        {explorerUrl !== undefined ? (
          <a
            href={explorerUrl}
            target="_blank"
            rel="noreferrer"
            className="border-border hover:bg-muted/60 inline-flex w-fit items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition-colors"
          >
            View on Stellar Expert
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        ) : null}
        {hash !== undefined ? (
          <span className="text-muted-foreground font-mono text-xs">{hash}</span>
        ) : null}
        <Button variant="outline" size="sm" onClick={onReset} className="self-start">
          Done
        </Button>
      </Card>
    )
  }

  if (phase === 'failed') {
    return (
      <Card className="flex flex-col gap-3 p-5">
        <div className="flex items-center gap-2">
          <TriangleAlert className="text-warning h-5 w-5" />
          <span className="font-medium">Swap not completed</span>
        </div>
        {/* The message is already user-facing prose from FAILURE_MESSAGES. */}
        <p className="text-muted-foreground text-sm">{error ?? 'Something went wrong.'}</p>
        <Button variant="outline" size="sm" onClick={onReset} className="self-start">
          Try again
        </Button>
      </Card>
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

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-col">
          <span className="text-muted-foreground text-xs">You pay</span>
          <span className="flex items-center gap-2 font-mono text-lg tabular-nums">
            <TokenIcon symbol={quote?.from.code} size={22} />
            {amount(sendDisplay)} {quote?.from.code}
          </span>
          {sendUsd !== undefined ? (
            <span className="text-muted-foreground text-xs tabular-nums">{sendUsd}</span>
          ) : null}
        </div>
        <ArrowRight className="text-muted-foreground h-4 w-4 shrink-0" />
        <div className="flex flex-col items-end">
          <span className="text-muted-foreground text-xs">You receive, about</span>
          <span className="flex items-center gap-2 font-mono text-lg tabular-nums">
            <TokenIcon symbol={quote?.to.code} size={22} />
            {amount(receiveDisplay)} {quote?.to.code}
          </span>
          {receiveUsd !== undefined ? (
            <span className="text-muted-foreground text-xs tabular-nums">{receiveUsd}</span>
          ) : null}
        </div>
      </div>

      <div className="text-muted-foreground border-border flex flex-wrap gap-x-4 gap-y-1 border-t pt-3 text-xs">
        {agentName !== undefined ? <span className="text-foreground">{agentName}</span> : null}
        {/* The agents differ in how they execute, not in which route they can
            reach — one executable quote exists, so they all take it. */}
        {sliceCount === 1 ? <span>single fill</span> : null}
        <span>via {quote?.source === 'horizon' ? 'Stellar DEX' : quote?.source}</span>
        <span>
          {quote?.path.length === 0
            ? 'direct'
            : `${quote?.path.length ?? 0} hop${quote?.path.length === 1 ? '' : 's'}`}
        </span>
        <span>0.5% max slippage</span>
      </div>

      <div className="flex items-center gap-2">
        <Button onClick={onConfirm} disabled={busy}>
          {phase === 'signing' ? (
            <>
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              Confirm in your wallet
            </>
          ) : phase === 'submitting' ? (
            <>
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              Submitting…
            </>
          ) : (
            'Sign & swap'
          )}
        </Button>
        {!busy ? (
          <Button variant="outline" onClick={onReset}>
            Cancel
          </Button>
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
    </Card>
  )
}
