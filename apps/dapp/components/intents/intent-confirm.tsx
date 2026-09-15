'use client'

import { Button, Card } from '@intent/ui'
import { Loader2 } from 'lucide-react'

import type { FollowOnAction } from '../../lib/parse-compound'

/**
 * Showing what was understood, before anything runs.
 *
 * The parser reads meaning rather than matching wording, which is what lets it
 * handle the many ways people write the same instruction. The cost of that
 * flexibility is that its confidence is no longer visible in the text: a regex
 * that matched is obviously right, and a model that interpreted might not be.
 *
 * So an instruction that carries a second action is read back before a
 * competition starts. The moment to catch a misreading is here, not at the
 * signing card — by then the user has waited a minute for agents to argue about
 * a trade that was never the one they asked for.
 *
 * Only shown when there is something worth confirming. An ordinary swap reads
 * the same whichever parser handled it, and interrupting that would be a tax on
 * the common case for the benefit of the rare one.
 */
export interface UnderstoodIntent {
  /** The sentence as typed, so the user can compare against it. */
  text: string
  tokenIn: string
  tokenOut: string
  /** Zero when no size was named. */
  amountUsd: number
  amountStated: boolean
  followOn: FollowOnAction | null
}

export function IntentConfirm({
  understood,
  busy,
  onConfirm,
  onReject,
}: {
  understood: UnderstoodIntent
  busy?: boolean
  /** Run it as read. */
  onConfirm: () => void
  /** Run only the trade, dropping the follow-on. */
  onReject: () => void
}): JSX.Element {
  const size = understood.amountStated ? `$${understood.amountUsd.toLocaleString()} of ` : 'your '

  const venue = understood.followOn?.venue
  const venueName = venue === 'blend' ? 'Blend' : (venue ?? 'a lending pool')

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium">Is this what you meant?</span>
        <span className="text-muted-foreground text-xs">
          This asks for two things, so it is worth checking before the agents start.
        </span>
      </div>

      {/* The numbered list is the point: a follow-on silently dropped or
          silently added is exactly the misreading this card exists to catch. */}
      <ol className="border-border flex flex-col gap-1.5 border-l pl-4 text-sm">
        <li>
          1. Swap {size}
          {understood.tokenIn} for {understood.tokenOut}
        </li>
        {understood.followOn !== null ? (
          <li>
            2. Supply the {understood.tokenOut} to {venueName}
          </li>
        ) : null}
      </ol>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={onConfirm} disabled={busy}>
          {busy === true ? (
            <span className="flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Starting…
            </span>
          ) : (
            'Yes, do that'
          )}
        </Button>
        {/* Named for what it does rather than "No". Someone who meant only the
            trade should not have to retype the sentence to get it. */}
        <Button variant="outline" size="sm" onClick={onReject} disabled={busy}>
          Just the swap
        </Button>
      </div>
    </Card>
  )
}
