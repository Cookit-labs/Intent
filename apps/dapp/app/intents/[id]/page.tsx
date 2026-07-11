'use client'

import type { IntentStatus } from '@intent/types'
import { Badge, Button, Card, Separator, cn } from '@intent/ui'
import { ArrowRight, Check, ExternalLink, Loader2 } from 'lucide-react'
import Link from 'next/link'
import { useParams } from 'next/navigation'

import { IntentStatusBadge } from '../../../components/intents/intent-status-badge'
import { useIntent } from '../../../hooks/use-intent'
import { intentTypeLabel } from '../../../lib/intent-format'

const STEPS: { status: IntentStatus; label: string }[] = [
  { status: 'pending', label: 'Escrowed' },
  { status: 'competition', label: 'Agents competing' },
  { status: 'executing', label: 'Executing' },
  { status: 'settled', label: 'Settled' },
]

function stepIndex(status: IntentStatus): number {
  const i = STEPS.findIndex((s) => s.status === status)
  return i === -1 ? 0 : i
}

export default function IntentDetailPage(): JSX.Element {
  const params = useParams<{ id: string }>()
  const { data: intent, isLoading, isError, error } = useIntent(params.id)

  if (isLoading) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-10">
        <Card className="bg-muted/40 h-64 animate-pulse" />
      </div>
    )
  }

  if (isError || !intent) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-10">
        <Card className="text-foreground p-6 text-sm">
          {(error as Error)?.message ?? 'Intent not found.'}
        </Card>
      </div>
    )
  }

  const failed = intent.status === 'failed' || intent.status === 'cancelled'
  const current = stepIndex(intent.status)
  const settled = intent.status === 'settled'

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            {intentTypeLabel(intent.type)}
          </h1>
          <IntentStatusBadge status={intent.status} />
        </div>
        <span className="text-muted-foreground font-mono text-xs">{intent.id}</span>
      </div>

      {/* Lifecycle stepper */}
      {!failed ? (
        <Card className="mb-4 p-6">
          <ol className="flex items-center">
            {STEPS.map((step, i) => {
              const done = i < current
              const active = i === current && !settled
              const complete = i < current || (settled && i <= current)
              return (
                <li key={step.status} className="flex flex-1 items-center last:flex-none">
                  <div className="flex flex-col items-center gap-2">
                    <div
                      className={cn(
                        'flex h-8 w-8 items-center justify-center rounded-full border text-xs',
                        complete
                          ? 'border-foreground bg-foreground text-background'
                          : active
                            ? 'border-foreground text-foreground'
                            : 'border-border text-muted-foreground'
                      )}
                    >
                      {complete ? (
                        <Check className="h-4 w-4" />
                      ) : active ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        i + 1
                      )}
                    </div>
                    <span
                      className={cn(
                        'whitespace-nowrap text-xs',
                        complete || active ? 'text-foreground' : 'text-muted-foreground'
                      )}
                    >
                      {step.label}
                    </span>
                  </div>
                  {i < STEPS.length - 1 ? (
                    <div
                      className={cn(
                        'mx-2 h-px flex-1',
                        i < current ? 'bg-foreground' : 'bg-border'
                      )}
                    />
                  ) : null}
                </li>
              )
            })}
          </ol>
        </Card>
      ) : (
        <Card className="mb-4 p-6">
          <p className="text-foreground text-sm font-medium">
            {intent.status === 'failed'
              ? 'Execution failed — your escrowed funds were returned. No fee was charged.'
              : 'Intent cancelled. Escrowed funds returned.'}
          </p>
        </Card>
      )}

      {/* Details */}
      <Card className="p-6">
        <div className="grid grid-cols-2 gap-4 font-mono text-sm">
          <div>
            <p className="text-muted-foreground text-xs">You pay</p>
            <p className="text-foreground">
              {intent.amountIn} {intent.tokenIn}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Minimum received</p>
            <p className="text-foreground">
              {intent.minAmountOut} {intent.tokenOut}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Deadline</p>
            <p className="text-foreground">{new Date(intent.deadline).toLocaleString()}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Settlement</p>
            <p className="text-foreground flex items-center gap-1">
              USDC on Arc <Badge variant="outline">testnet</Badge>
            </p>
          </div>
        </div>

        {(intent.escrowTxHash || intent.settlementTxHash) && (
          <>
            <Separator className="my-5" />
            <div className="flex flex-col gap-2 font-mono text-xs">
              {intent.escrowTxHash ? (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Escrow tx</span>
                  <span className="text-foreground flex items-center gap-1">
                    {intent.escrowTxHash.slice(0, 10)}…{intent.escrowTxHash.slice(-6)}
                    <ExternalLink className="h-3 w-3" />
                  </span>
                </div>
              ) : null}
              {intent.settlementTxHash ? (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Settlement tx</span>
                  <span className="text-foreground flex items-center gap-1">
                    {intent.settlementTxHash.slice(0, 10)}…{intent.settlementTxHash.slice(-6)}
                    <ExternalLink className="h-3 w-3" />
                  </span>
                </div>
              ) : null}
            </div>
          </>
        )}
      </Card>

      {/* Watch agents compete — Slice 2 teaser */}
      {intent.status === 'competition' ? (
        <Card className="mt-4 flex items-center justify-between p-5">
          <div>
            <p className="text-sm font-medium">Agents are competing for this intent</p>
            <p className="text-muted-foreground text-xs">
              Watch the live auction — bids, scoring, and why the winner won.
            </p>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link href="/competitions">
              Watch <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        </Card>
      ) : null}

      <p className="text-muted-foreground mt-6 text-center font-mono text-[11px]">
        Non-custodial · always verify the URL before connecting your wallet.
      </p>
    </div>
  )
}
