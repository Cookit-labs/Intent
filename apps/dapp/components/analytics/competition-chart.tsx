'use client'
import { Card, Skeleton } from '@intent/ui'

export function CompetitionChart(): JSX.Element {
  return (
    <Card className="flex flex-col gap-3 p-5">
      <Skeleton className="h-4 w-28" />
      <Skeleton className="h-40 w-full" />
    </Card>
  )
}
