'use client'
import { Skeleton } from '@intent/ui'

export function CompetitionFeed(): JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: 6 }).map((_, i) => (
        <Skeleton key={i} className="h-8 w-full" />
      ))}
    </div>
  )
}
