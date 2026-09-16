'use client'

import { Button, Card } from '@intent/ui'
import { CheckCircle2, ExternalLink, Loader2, TriangleAlert } from 'lucide-react'

import type { Supply } from '../../hooks/use-supply'
import { blendPositionUrl } from '../../lib/swap/contract-registry'

/**
 * Reviewing a supply of an asset the account already holds.
 *
 * Simpler than a sequence card, and deliberately so. There is no earlier step
 * whose output has to be carried, no second signature, and nothing to explain
 * about atomicity: one transaction, one signature, done or not done.
 *
 * What it still owes the user is the risk panel. Supplying is not trading — the
 * asset leaves the wallet and sits in a pool — and the honest risks are ones
 * most people have not met before.
 */
export function SupplyConfirm({ supply }: { supply: Supply }): JSX.Element | null {
  const { phase } = supply

  if (phase === 'idle') return null

  if (phase === 'building') {
    return (
      <Card className="text-muted-foreground flex items-center gap-2 p-5 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        Checking the pool will accept it…
      </Card>
    )
  }

  if (phase === 'failed') {
    return (
      <Card className="flex flex-col gap-3 p-5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <TriangleAlert className="h-4 w-4" />
          This supply did not go ahead
        </div>
        <p className="text-muted-foreground text-sm">{supply.error ?? 'Something went wrong.'}</p>
        <Button variant="outline" size="sm" onClick={supply.reset} className="self-start">
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
          Supplied to Blend
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {supply.explorerUrl !== undefined ? (
            <a
              href={supply.explorerUrl}
              target="_blank"
              rel="noreferrer"
              className="border-border hover:bg-muted/60 inline-flex items-center gap-2 rounded-md border px-3 py-2 text-xs font-medium transition-colors"
            >
              View transaction
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          ) : null}
          {/* The position, not the receipt. An explorer proves the supply
              reached a ledger and says nothing about what it now earns. */}
          <a
            href={blendPositionUrl()}
            target="_blank"
            rel="noreferrer"
            className="border-border hover:bg-muted/60 inline-flex items-center gap-2 rounded-md border px-3 py-2 text-xs font-medium transition-colors"
          >
            View position on Blend
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      </Card>
    )
  }

  const busy = phase === 'signing' || phase === 'submitting'

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium">
          Supply {supply.amount ?? ''} {supply.asset ?? ''} to Blend
        </span>
        {/* "About" is not hedging. Interest accrues every ledger and the pool
            takes no minimum-out, so the figure genuinely cannot be pinned. */}
        {supply.bTokens !== undefined ? (
          <span className="text-muted-foreground text-xs">
            You receive about {supply.bTokens} bTokens, which accrue interest.
          </span>
        ) : null}
      </div>

      <SupplyRisks />

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={supply.confirm} disabled={busy}>
          {busy ? (
            <span className="flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {phase === 'signing' ? 'Waiting for your wallet…' : 'Submitting…'}
            </span>
          ) : (
            'Sign and supply'
          )}
        </Button>
        {!busy ? (
          <Button variant="ghost" size="sm" onClick={supply.reset}>
            Cancel
          </Button>
        ) : null}
      </div>
    </Card>
  )
}

/**
 * What supplying actually risks.
 *
 * **No liquidation warning, deliberately.** A supply-only position cannot be
 * liquidated: the pool never checks health on a supply, and it panics outright
 * when asked to open a liquidation auction against an account with no
 * liabilities. Warning about it would train people to ignore a warning that is
 * false here and true elsewhere.
 */
function SupplyRisks(): JSX.Element {
  return (
    <div className="border-border text-muted-foreground flex flex-col gap-1.5 rounded-md border p-3 text-xs">
      <span className="text-foreground font-medium">Before you supply</span>
      <span>
        Withdrawals fail while the pool is near full use. This reserve is close to that line now, so
        getting funds out may not be immediate.
      </span>
      <span>
        If borrowers default beyond what the backstop covers, suppliers absorb the loss. Your
        principal is not guaranteed.
      </span>
      <span>The rate moves with borrowing demand. It is not fixed at the figure shown.</span>
    </div>
  )
}
