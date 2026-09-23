'use client'

import { Button, Card } from '@intent/ui'
import { CheckCircle2, ExternalLink, Loader2, TriangleAlert } from 'lucide-react'
import { useEffect } from 'react'

import type { PlanExecution } from '../../hooks/use-plan-execution'
import { LedgerPreview } from './ledger-preview'

/**
 * Reviewing a plan before signing it.
 *
 * A swap has one number to check. A plan has an ordered list, and the order is
 * meaning — resting the remainder before swapping would commit funds the swap
 * still needs.
 *
 * The numbered steps are the safety property, not decoration. One signature
 * covers several operations, and the validator's guarantee only holds if the
 * person signing can see what they are approving. "3 steps" without saying
 * which three would make multi-step less safe than single operations rather
 * than more.
 */
export function PlanConfirm({
  plan,
  onSettled,
}: {
  plan: PlanExecution
  onSettled?: (hash: string) => void
}): JSX.Element | null {
  const { phase, hash } = plan

  useEffect(() => {
    if (phase === 'settled' && hash !== undefined) onSettled?.(hash)
  }, [phase, hash, onSettled])

  if (phase === 'idle') return null

  if (phase === 'building') {
    return (
      <Card className="text-muted-foreground flex items-center gap-2 p-5 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        Building the plan…
      </Card>
    )
  }

  if (phase === 'failed') {
    return (
      <Card className="flex flex-col gap-3 p-5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <TriangleAlert className="h-4 w-4" />
          This plan could not be built
        </div>
        <p className="text-muted-foreground text-sm">{plan.error ?? 'Something went wrong.'}</p>
        <Button variant="outline" size="sm" onClick={plan.reset} className="self-start">
          Try again
        </Button>
      </Card>
    )
  }

  if (phase === 'settled') {
    return (
      <Card className="flex flex-col gap-3 p-5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <CheckCircle2 className="h-4 w-4" />
          Plan executed
        </div>
        {/* Every step, or none. Worth saying: it is the reason a plan is one
            transaction rather than several, and it means there is no partial
            state to explain. */}
        <p className="text-muted-foreground text-sm">
          All {plan.description?.length ?? 0} steps settled together in one transaction.
        </p>
        {plan.explorerUrl !== undefined ? (
          <a
            href={plan.explorerUrl}
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
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium">
          {plan.description?.length ?? 0} steps, one signature
        </span>
        <span className="text-muted-foreground text-xs">
          They run together — either all of them happen or none does.
        </span>
      </div>

      {/* The list is the point of the card. */}
      <ol className="border-border flex flex-col gap-1.5 border-l pl-4 text-sm">
        {(plan.description ?? []).map((step) => (
          <li key={step} className="text-foreground">
            {step}
          </li>
        ))}
      </ol>

      <LedgerPreview preview={plan.preview} />

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={plan.confirm} disabled={busy}>
          {busy ? (
            <span className="flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {phase === 'signing' ? 'Waiting for your wallet…' : 'Submitting…'}
            </span>
          ) : (
            'Sign all steps'
          )}
        </Button>
        {!busy ? (
          <Button variant="ghost" size="sm" onClick={plan.reset}>
            Cancel
          </Button>
        ) : null}
      </div>
    </Card>
  )
}
