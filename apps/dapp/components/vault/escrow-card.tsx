'use client'
import { Card, Skeleton } from '@intent/ui'

export function EscrowCard(): JSX.Element {
  return (
    <Card className="flex flex-col gap-3 p-5">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-4 w-full" />
    </Card>
  )
}
