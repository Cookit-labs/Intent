'use client'

import { Button, Card } from '@intent/ui'
import { ArrowRight, CheckCircle2, ExternalLink, Loader2, TriangleAlert } from 'lucide-react'

import type { SwapPhase } from '../../hooks/use-swap'
import type { SwapQuote } from '../../lib/swap/quote'

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
        <p className="text-muted-foreground text-sm">
          {amount(sendDisplay)} {quote?.from.code} became {amount(receiveDisplay)}{' '}
          {quote?.to.code}.
        </p>
        {explorerUrl !== undefined ? (
          <a
            href={explorerUrl}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 font-mono text-xs underline underline-offset-2"
          >
            {hash?.slice(0, 16)}…
            <ExternalLink className="h-3 w-3" />
          </a>
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

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-col">
          <span className="text-muted-foreground text-xs">You pay</span>
          <span className="font-mono text-lg tabular-nums">
            {amount(sendDisplay)} {quote?.from.code}
          </span>
        </div>
        <ArrowRight className="text-muted-foreground h-4 w-4 shrink-0" />
        <div className="flex flex-col items-end">
          <span className="text-muted-foreground text-xs">You receive, about</span>
          <span className="font-mono text-lg tabular-nums">
            {amount(receiveDisplay)} {quote?.to.code}
          </span>
        </div>
      </div>

      <div className="text-muted-foreground border-border flex flex-wrap gap-x-4 gap-y-1 border-t pt-3 text-xs">
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

      {/* Said plainly rather than buried: the amount is an estimate, and the
          floor is enforced by the network, not by this screen. */}
      <p className="text-muted-foreground text-xs">
        The received amount is an estimate. If the price moves more than 0.5%, the swap is
        cancelled and nothing is spent.
      </p>
    </Card>
  )
}
