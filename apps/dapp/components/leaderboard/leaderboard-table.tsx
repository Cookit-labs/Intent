'use client'
import { Card, Skeleton } from '@intent/ui'

export function LeaderboardTable(): JSX.Element {
  return (
    <Card className="flex flex-col gap-3 p-5">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4">
          <Skeleton className="h-5 w-6" />
          <Skeleton className="h-8 w-8 rounded-full" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
    </Card>
  )
}
