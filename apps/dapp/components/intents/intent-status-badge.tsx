'use client'

import type { IntentStatus } from '@intent/types'
import { Badge, type BadgeProps } from '@intent/ui'

const meta: Record<
  IntentStatus,
  { label: string; variant: BadgeProps['variant']; pulse?: boolean }
> = {
  pending: { label: 'Pending', variant: 'outline' },
  competition: { label: 'In competition', variant: 'outline', pulse: true },
  executing: { label: 'Executing', variant: 'outline', pulse: true },
  settled: { label: 'Settled', variant: 'outline' },
  failed: { label: 'Failed', variant: 'outline' },
  cancelled: { label: 'Cancelled', variant: 'outline' },
}

export function IntentStatusBadge({ status }: { status: IntentStatus }): JSX.Element {
  const { label, variant, pulse } = meta[status]
  return (
    <Badge variant={variant}>
      {pulse ? (
        <span className="mr-0.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
      ) : null}
      {label}
    </Badge>
  )
}
