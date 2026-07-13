'use client'

import type { Intent, IntentStatus } from '@intent/types'
import { Card, cn } from '@intent/ui'
import { ArrowRight } from 'lucide-react'
import Link from 'next/link'
import { Fragment } from 'react'

import { intentTypeLabel } from '../../lib/intent-format'

const PRICE_USD: Record<string, number> = {
  USDC: 1,
  USDT: 1,
  WETH: 3500,
  ETH: 3500,
  ARB: 1.25,
  WBTC: 95000,
}

const COMPETING_AGENTS = 4

const STAGES: IntentStatus[] = ['pending', 'competition', 'executing', 'settled']

interface StatusView {
  stage: number
  live: boolean
  failed: boolean
}

function statusView(status: IntentStatus): StatusView {
  if (status === 'failed' || status === 'cancelled') return { stage: 0, live: false, failed: true }
  const stage = STAGES.indexOf(status)
  return {
    stage: stage === -1 ? 0 : stage,
    live: status === 'competition' || status === 'executing',
    failed: false,
  }
}

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

function statusLabel(intent: Intent): string {
  switch (intent.status) {
    case 'competition':
      return `Competing · ${COMPETING_AGENTS} agents`
    case 'executing':
      return 'Executing · live'
    case 'pending':
      return 'Escrowed'
    case 'settled':
      return `Settled · ${timeAgo(intent.createdAt)}`
    case 'failed':
      return `Failed · ${timeAgo(intent.createdAt)}`
    case 'cancelled':
      return `Cancelled · ${timeAgo(intent.createdAt)}`
  }
}

function usd(intent: Intent): string {
  const n = Number(intent.amountIn) * (PRICE_USD[intent.tokenIn] ?? 0)
  if (!Number.isFinite(n) || n <= 0) return '—'
  return `~$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}

function ExecutionTrack({ view }: { view: StatusView }): JSX.Element {
  return (
    <div className="flex items-center gap-1.5" aria-hidden>
      {STAGES.map((stage, i) => {
        const done = !view.failed && i <= view.stage
        const active = view.live && i === view.stage
        return (
          <Fragment key={stage}>
            {i > 0 ? (
              <span className={cn('h-px w-5', done ? 'bg-foreground' : 'bg-border')} />
            ) : null}
            <span className="relative flex h-2 w-2 items-center justify-center">
              {active ? (
                <span className="border-foreground/50 absolute inline-flex h-3 w-3 animate-ping rounded-full border motion-reduce:hidden" />
              ) : null}
              <span
                className={cn(
                  'h-2 w-2 rounded-full',
                  done ? 'bg-foreground' : 'border-border border bg-transparent'
                )}
              />
            </span>
          </Fragment>
        )
      })}
    </div>
  )
}

export function IntentCard({ intent }: { intent: Intent }): JSX.Element {
  const view = statusView(intent.status)
  return (
    <Link href={`/intents/${intent.id}`} className="block">
      <Card className="hover:border-foreground/40 flex gap-4 p-5 transition-colors">
        <span
          className={cn(
            'flex h-11 w-11 shrink-0 items-center justify-center rounded-md border text-sm font-semibold',
            view.failed ? 'border-border text-muted-foreground' : 'border-border text-foreground'
          )}
        >
          {intent.tokenOut.charAt(0)}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-semibold">{intentTypeLabel(intent.type)}</span>
            <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
              {view.live ? (
                <span className="bg-foreground h-1.5 w-1.5 animate-pulse rounded-full motion-reduce:animate-none" />
              ) : null}
              {statusLabel(intent)}
            </span>
          </div>

          <div className="mt-1.5 flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2 text-sm tabular-nums">
              <span className="font-medium">
                {intent.amountIn} {intent.tokenIn}
              </span>
              <ArrowRight className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
              <span className="text-muted-foreground truncate">
                {intent.minAmountOut} {intent.tokenOut}
              </span>
            </div>
            <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
              {usd(intent)}
            </span>
          </div>

          <div className="mt-3">
            <ExecutionTrack view={view} />
          </div>
        </div>
      </Card>
    </Link>
  )
}
