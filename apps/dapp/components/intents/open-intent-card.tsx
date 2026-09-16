'use client'

import { Card } from '@intent/ui'
import { Clock, Loader2 } from 'lucide-react'

import { useIntent } from '../../hooks/use-intent'
import { TokenIcon } from '../ui/token-icon'

/**
 * A resting order, shown inside the conversation that placed it.
 *
 * A limit order does not finish when it is submitted — it waits, sometimes for
 * a long time, and the user needs to see what it is waiting for and be able to
 * take it back. Putting that on a separate page split one action across two
 * screens; the order belongs in the thread where it was placed.
 *
 * Polls through `useIntent`, so a fill appears here without a reload.
 */
export function OpenIntentCard({
  intentId,
  onCancel,
  cancelling,
  cancelError,
}: {
  intentId: string
  onCancel: (id: string) => void
  cancelling: boolean
  cancelError: string | undefined
}): JSX.Element | null {
  const { data: intent } = useIntent(intentId)

  if (intent === undefined) return null

  const waiting = intent.status === 'pending' && intent.limitPriceUsd !== undefined
  const finished =
    intent.status === 'settled' || intent.status === 'cancelled' || intent.status === 'failed'

  // A market order's progress is already narrated by the swap card above; only
  // a resting order needs its own place in the thread.
  if (!waiting && !finished) return null

  if (finished) {
    return (
      <Card className="text-muted-foreground p-4 text-sm">
        {intent.status === 'settled'
          ? 'Order filled.'
          : intent.status === 'cancelled'
            ? 'Order cancelled. Nothing was spent.'
            : 'Order failed. Nothing was spent.'}
      </Card>
    )
  }

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2 text-sm">
        <Clock className="text-muted-foreground h-4 w-4 shrink-0" />
        <span className="font-medium">Order open</span>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm tabular-nums">
        <TokenIcon symbol={intent.tokenIn} size={18} />
        <span>
          {intent.amountIn} {intent.tokenIn}
        </span>
        <span className="text-muted-foreground">for</span>
        <TokenIcon symbol={intent.tokenOut} size={18} />
        <span className="text-muted-foreground">{intent.tokenOut}</span>
      </div>

      <p className="text-muted-foreground text-xs">
        Waiting for {intent.tokenOut} to reach $
        {intent.limitPriceUsd?.toLocaleString('en-US', { maximumFractionDigits: 6 })}. Nothing has
        been spent, and the order can be withdrawn at any time until it fills.
      </p>

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={cancelling}
          onClick={() => onCancel(intent.id)}
          className="border-border text-foreground hover:border-foreground/40 inline-flex items-center gap-1.5 rounded-full border px-4 py-1.5 text-sm transition-colors disabled:opacity-50"
        >
          {cancelling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Cancel order
        </button>
      </div>

      {cancelError !== undefined ? <p className="text-foreground text-xs">{cancelError}</p> : null}
    </Card>
  )
}
