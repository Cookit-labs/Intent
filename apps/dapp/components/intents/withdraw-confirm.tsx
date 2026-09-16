'use client'

import { Button, Card } from '@intent/ui'
import { CheckCircle2, ExternalLink, Loader2, TriangleAlert } from 'lucide-react'

import type { Withdraw } from '../../hooks/use-withdraw'

/**
 * Reviewing a withdrawal from Blend.
 *
 * Deliberately lighter than the supply card. Supplying puts money somewhere new
 * and owes the user an account of what they are taking on; withdrawing brings
 * it back to a wallet they already control, and takes no risk on.
 *
 * The one thing it does owe them is the failure case, which is unlike anything
 * a supply meets: Blend refuses a withdrawal that would push the reserve past
 * its utilisation ceiling. That is a property of how much the pool has lent
 * out, not of the position — so the money is neither gone nor stuck, and the
 * wording has to say that rather than implying either.
 */
function display(baseUnits: string | undefined): string | undefined {
  if (baseUnits === undefined) return undefined
  const n = Number(baseUnits) / 1e7
  if (!Number.isFinite(n)) return undefined
  return n.toLocaleString(undefined, { maximumFractionDigits: 7 })
}

export function WithdrawConfirm({ withdraw }: { withdraw: Withdraw }): JSX.Element | null {
  const { phase } = withdraw

  if (phase === 'idle') return null

  if (phase === 'building') {
    return (
      <Card className="text-muted-foreground flex items-center gap-2 p-5 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        Checking the pool can pay it out…
      </Card>
    )
  }

  if (phase === 'failed') {
    return (
      <Card className="flex flex-col gap-3 p-5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <TriangleAlert className="h-4 w-4" />
          This withdrawal did not go ahead
        </div>
        <p className="text-muted-foreground text-sm">{withdraw.error ?? 'Something went wrong.'}</p>
        {/* Said plainly, because a failed withdrawal is the moment someone
            wonders whether their money is gone. It is not: a refusal happens
            before anything moves, and the position is untouched. */}
        <p className="text-muted-foreground text-xs">
          Your position is unchanged — a refused withdrawal never moves funds.
        </p>
        <Button variant="outline" size="sm" onClick={withdraw.reset} className="self-start">
          Start over
        </Button>
      </Card>
    )
  }

  if (phase === 'settled') {
    return (
      <Card className="flex flex-col gap-3 p-5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <CheckCircle2 className="h-4 w-4" />
          Withdrawn to your wallet
        </div>
        <p className="text-muted-foreground text-sm">
          {withdraw.everything === true
            ? `Your ${withdraw.asset ?? ''} position in Blend is closed.`
            : `${display(withdraw.amount) ?? ''} ${withdraw.asset ?? ''} is back in your wallet.`}
        </p>
        <div className="flex items-center gap-3">
          {withdraw.explorerUrl !== undefined ? (
            <a
              href={withdraw.explorerUrl}
              target="_blank"
              rel="noreferrer"
              className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs transition-colors"
            >
              View transaction
              <ExternalLink className="h-3 w-3" />
            </a>
          ) : null}
          <Button variant="outline" size="sm" onClick={withdraw.reset}>
            Done
          </Button>
        </div>
      </Card>
    )
  }

  const busy = phase === 'signing' || phase === 'submitting'
  const emptied = withdraw.everything === true || withdraw.remaining === '0'

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div>
        <div className="text-sm font-semibold">
          Withdraw {withdraw.everything === true ? 'everything' : (display(withdraw.amount) ?? '')}{' '}
          {withdraw.asset ?? ''}
        </div>
        <p className="text-muted-foreground mt-1 text-sm">
          From the Blend pool back to your wallet. One transaction, one signature.
        </p>
      </div>

      {/* The simulated remainder, which is the honest way to say "all of it".
          An exact figure would be stale by the time it is signed, since the
          position earns every ledger — so what is promised is the end state,
          not the sum. */}
      <p className="text-muted-foreground text-xs">
        {emptied
          ? 'This closes the position. Interest earned right up to the moment it settles comes with it.'
          : `About ${display(withdraw.remaining) ?? 'some'} ${withdraw.asset ?? ''} stays supplied and keeps earning.`}
      </p>

      <div className="flex items-center gap-3">
        <Button size="sm" onClick={withdraw.confirm} disabled={busy}>
          {busy ? (
            <span className="flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {phase === 'signing' ? 'Waiting for your wallet…' : 'Submitting…'}
            </span>
          ) : (
            'Withdraw'
          )}
        </Button>
        {!busy ? (
          <Button variant="outline" size="sm" onClick={withdraw.reset}>
            Cancel
          </Button>
        ) : null}
      </div>
    </Card>
  )
}
