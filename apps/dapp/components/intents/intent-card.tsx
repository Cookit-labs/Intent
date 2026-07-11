'use client'

import type { Intent } from '@intent/types'
import { Card } from '@intent/ui'
import { ArrowRight } from 'lucide-react'
import Link from 'next/link'

import { intentTypeLabel } from '../../lib/intent-format'
import { IntentStatusBadge } from './intent-status-badge'

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export function IntentCard({ intent }: { intent: Intent }): JSX.Element {
  return (
    <Link href={`/intents/${intent.id}`} className="block">
      <Card className="hover:border-foreground/40 p-5 transition-colors">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-display text-base font-semibold">
                {intentTypeLabel(intent.type)}
              </span>
              <IntentStatusBadge status={intent.status} />
            </div>

            <div className="text-muted-foreground mt-2 flex items-center gap-2 font-mono text-sm">
              <span className="text-foreground">
                {intent.amountIn} {intent.tokenIn}
              </span>
              <ArrowRight className="h-3.5 w-3.5" />
              <span>
                min {intent.minAmountOut} {intent.tokenOut}
              </span>
            </div>
          </div>

          <span className="text-muted-foreground shrink-0 font-mono text-xs">
            {timeAgo(intent.createdAt)}
          </span>
        </div>
      </Card>
    </Link>
  )
}
