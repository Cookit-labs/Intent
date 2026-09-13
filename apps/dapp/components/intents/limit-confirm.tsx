'use client'

import { Button, Card, cn } from '@intent/ui'
import { AlertTriangle, ArrowRight, CheckCircle2, ExternalLink, Loader2 } from 'lucide-react'
import { useEffect } from 'react'

import type { LimitOrder } from '../../hooks/use-limit-order'
import { TokenIcon } from '../ui/token-icon'

/**
 * Reviewing an order before it goes on the book.
 *
 * A resting order commits differently from a swap, and the card says so rather
 * than reusing the swap language. Three things a user has to know before
 * signing, none of which apply to an immediate trade: the funds are locked
 * while the order waits, each open order reserves 0.5 XLM, and the price is
 * fixed at placement rather than tracking the dollar.
 *
 * The refusal state is the one that matters most. An order priced through the
 * spread is turned away here with both numbers shown, because the alternative
 * — placing it and watching it fill instantly — is what made limit orders look
 * broken in the first place.
 */

/** Each open offer holds this much XLM in reserve until it is cancelled. */
const OFFER_RESERVE_XLM = 0.5

function price(value: number | undefined): string {
  if (value === undefined) return '—'
  return `$${value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`
}

export function LimitConfirm({
  order,
  sellSymbol,
  buySymbol,
  onPlaced,
}: {
  order: LimitOrder
  sellSymbol: string
  buySymbol: string
  onPlaced?: (hash: string) => void
}): JSX.Element | null {
  const { phase, hash } = order

  // Reporting the hash is a side effect and belongs in an effect, not in the
  // render path where it would fire again on every repaint.
  useEffect(() => {
    if (phase === 'placed' && hash !== undefined) onPlaced?.(hash)
  }, [phase, hash, onPlaced])

  if (phase === 'idle') return null

  if (phase === 'checking') {
    return (
      <Card className="text-muted-foreground flex items-center gap-2 p-5 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        Checking the order book…
      </Card>
    )
  }

  if (phase === 'refused') {
    return (
      <Card className="flex flex-col gap-3 p-5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <AlertTriangle className="h-4 w-4" />
          {order.refusal === 'would_fill_now'
            ? 'This would trade immediately'
            : order.refusal === 'no_market'
              ? 'Nobody is quoting this pair'
              : 'That price cannot be used'}
        </div>

        <p className="text-muted-foreground text-sm">{order.error}</p>

        {order.refusal === 'would_fill_now' ? (
          <p className="text-muted-foreground text-xs">
            An order that fills the moment it is placed is a market swap, not a limit order. Pick a
            price further from the market, or swap at the current rate instead.
          </p>
        ) : null}

        <Button variant="outline" size="sm" onClick={order.reset} className="self-start">
          Change the price
        </Button>
      </Card>
    )
  }

  if (phase === 'failed') {
    return (
      <Card className="flex flex-col gap-3 p-5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <AlertTriangle className="h-4 w-4" />
          The order was not placed
        </div>
        <p className="text-muted-foreground text-sm">{order.error ?? 'Something went wrong.'}</p>
        <Button variant="outline" size="sm" onClick={order.reset} className="self-start">
          Try again
        </Button>
      </Card>
    )
  }

  if (phase === 'placed') {
    return (
      <Card className="flex flex-col gap-3 p-5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <CheckCircle2 className="h-4 w-4" />
          Order is resting on the book
        </div>

        <p className="text-muted-foreground text-sm">
          It will fill on its own if the market reaches {price(order.priceDecimal)}. You can
          withdraw it at any time.
        </p>

        {order.explorerUrl !== undefined ? (
          <a
            href={order.explorerUrl}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 self-start text-xs underline underline-offset-2"
          >
            View transaction
            <ExternalLink className="h-3 w-3" />
          </a>
        ) : null}
      </Card>
    )
  }

  const busy = phase === 'signing' || phase === 'submitting'

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-col">
          <span className="text-muted-foreground text-xs">You offer</span>
          <span className="flex items-center gap-2 font-mono text-lg tabular-nums">
            <TokenIcon symbol={sellSymbol} size={22} />
            {order.amount ?? '—'} {sellSymbol}
          </span>
        </div>
        <ArrowRight className="text-muted-foreground h-4 w-4 shrink-0" />
        <div className="flex flex-col items-end">
          <span className="text-muted-foreground text-xs">Only at</span>
          <span className="flex items-center gap-2 font-mono text-lg tabular-nums">
            <TokenIcon symbol={buySymbol} size={22} />
            {price(order.priceDecimal)}
          </span>
        </div>
      </div>

      {/* Both numbers, always. The app reads USD from mainnet and executes on
          testnet, where the same asset trades somewhere else — hiding either
          one would make the order look mispriced rather than deliberate. */}
      <div className="text-muted-foreground border-border flex flex-wrap gap-x-4 gap-y-1 border-t pt-3 text-xs tabular-nums">
        <span>
          your price <span className="text-foreground">{price(order.priceDecimal)}</span>
        </span>
        <span>
          market now <span className="text-foreground">{price(order.marketPriceUsd)}</span>
        </span>
        <span>rests until filled or withdrawn</span>
      </div>

      <p className="text-muted-foreground text-xs">
        The {sellSymbol} stays in your wallet but is committed while the order waits, and{' '}
        {OFFER_RESERVE_XLM} XLM is held in reserve until you withdraw it. The price is fixed when
        placed; it does not follow the dollar.
      </p>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={order.confirm}
          disabled={busy}
          className={cn(busy && 'opacity-70')}
        >
          {busy ? (
            <span className="flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {phase === 'signing' ? 'Waiting for your wallet…' : 'Placing…'}
            </span>
          ) : (
            'Place order'
          )}
        </Button>
        {!busy ? (
          <Button variant="ghost" size="sm" onClick={order.reset}>
            Cancel
          </Button>
        ) : null}
      </div>
    </Card>
  )
}
