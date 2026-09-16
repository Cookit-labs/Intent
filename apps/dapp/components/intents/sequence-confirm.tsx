'use client'

import { Button, Card } from '@intent/ui'
import { CheckCircle2, Circle, ExternalLink, Loader2, TriangleAlert } from 'lucide-react'

import type { Sequence } from '../../hooks/use-sequence'

/**
 * Reviewing a sequence before signing the first of its steps.
 *
 * A plan card can promise atomicity: Stellar runs every operation or none.
 * A sequence cannot, because **Soroban permits exactly one operation per
 * transaction**, so a swap and a Blend supply are genuinely two signatures.
 *
 * That makes this card's job different. It has to show both steps *before* the
 * first signature, so nobody approves step one without knowing a second is
 * coming, and it has to say plainly where someone stands if they stop partway.
 *
 * Stopping is not a failure. Someone who signs the swap and declines the supply
 * holds the asset — a position, not a stuck state — and this must say so.
 */
export function SequenceConfirm({ sequence }: { sequence: Sequence }): JSX.Element | null {
  const { phase, steps, current } = sequence

  if (phase === 'idle') return null

  if (phase === 'failed') {
    return (
      <Card className="flex flex-col gap-3 p-5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <TriangleAlert className="h-4 w-4" />
          This sequence stopped
        </div>
        <p className="text-muted-foreground text-sm">{sequence.error ?? 'Something went wrong.'}</p>
        <StepList steps={steps} current={current} />
        <Button variant="outline" size="sm" onClick={sequence.reset} className="self-start">
          Start over
        </Button>
      </Card>
    )
  }

  if (phase === 'stopped') {
    return (
      <Card className="flex flex-col gap-3 p-5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <CheckCircle2 className="h-4 w-4" />
          Stopped after step {current}
        </div>
        {/* The sentence that keeps a normal outcome from reading as a fault. */}
        <p className="text-muted-foreground text-sm">
          Nothing went wrong. What has already settled stands, and you are holding the asset from it
          rather than a lending position.
        </p>
        <StepList steps={steps} current={current} />
        <Button variant="outline" size="sm" onClick={sequence.reset} className="self-start">
          Done
        </Button>
      </Card>
    )
  }

  if (phase === 'settled') {
    return (
      <Card className="flex flex-col gap-3 p-5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <CheckCircle2 className="h-4 w-4" />
          Both steps settled
        </div>
        <StepList steps={steps} current={steps.length} />
        <Button variant="outline" size="sm" onClick={sequence.reset} className="self-start">
          Done
        </Button>
      </Card>
    )
  }

  if (phase === 'building') {
    return (
      <Card className="text-muted-foreground flex items-center gap-2 p-5 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        {current === 0 ? 'Building the sequence…' : 'Sizing the supply to what you received…'}
      </Card>
    )
  }

  const busy = phase === 'signing' || phase === 'submitting'

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium">
          {steps.length} steps, {steps.length} signatures
        </span>
        {/* Stated rather than implied. A user who has signed multi-step plans
            here would otherwise reasonably expect one signature. */}
        <span className="text-muted-foreground text-xs">
          These cannot share a signature, so your wallet asks once per step. Approving here starts
          the run and the next prompt follows on its own. Declining any prompt stops it, leaving you
          with whatever the earlier steps produced.
        </span>
      </div>

      <StepList steps={steps} current={current} />

      {/* Only once the supply is the step in hand: the risks below are about
          lending, and showing them beside a swap would misattribute them. */}
      {current > 0 ? <SupplyRisks /> : null}

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={sequence.confirm} disabled={busy}>
          {busy ? (
            <span className="flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {phase === 'signing' ? 'Waiting for your wallet…' : 'Submitting…'}
            </span>
          ) : current === 0 ? (
            `Approve and sign ${steps.length} steps`
          ) : (
            `Sign step ${current + 1} of ${steps.length}`
          )}
        </Button>
        {!busy ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={current === 0 ? sequence.reset : sequence.stop}
          >
            {current === 0 ? 'Cancel' : 'Stop here'}
          </Button>
        ) : null}
      </div>
    </Card>
  )
}

function StepList({
  steps,
  current,
}: {
  steps: { label: string; hash?: string; explorerUrl?: string; positionUrl?: string }[]
  current: number
}): JSX.Element {
  return (
    <ol className="border-border flex flex-col gap-2 border-l pl-4 text-sm">
      {steps.map((step, i) => {
        const done = i < current || step.hash !== undefined
        return (
          <li key={step.label} className="flex items-start gap-2">
            {done ? (
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            ) : (
              <Circle className="text-muted-foreground mt-0.5 h-3.5 w-3.5 shrink-0" />
            )}
            <span className={done ? 'text-foreground' : 'text-muted-foreground'}>
              {i + 1}. {step.label}
              {step.explorerUrl !== undefined ? (
                <a
                  href={step.explorerUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-muted-foreground hover:text-foreground ml-2 inline-flex items-center gap-1 text-xs underline underline-offset-2"
                >
                  Transaction
                  <ExternalLink className="h-3 w-3" />
                </a>
              ) : null}
              {/* The position, not the receipt. A supply's explorer link
                  proves it happened and shows nothing about what it earns. */}
              {step.positionUrl !== undefined ? (
                <a
                  href={step.positionUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-muted-foreground hover:text-foreground ml-2 inline-flex items-center gap-1 text-xs underline underline-offset-2"
                >
                  View position on Blend
                  <ExternalLink className="h-3 w-3" />
                </a>
              ) : null}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/**
 * What supplying actually risks.
 *
 * **No liquidation warning, deliberately.** A supply-only position cannot be
 * liquidated: the pool never checks health on a supply, and it panics outright
 * when asked to open a liquidation auction against an account with no
 * liabilities. Confirmed in two independent gates in the pool source. Warning
 * about it would train people to ignore a warning that is false here and true
 * elsewhere.
 *
 * The real risks are different, and less familiar, which is exactly why they
 * are worth the space.
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
