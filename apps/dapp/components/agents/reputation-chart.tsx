'use client'
import { Card, Skeleton } from '@intent/ui'

export function ReputationChart(): JSX.Element {
  return (
    <Card className="p-5">
      <Skeleton className="h-48 w-full" />
    </Card>
  )
}
