'use client'
import { Card, Skeleton } from '@intent/ui'

export function ProposalTable(): JSX.Element {
  return (
    <Card className="flex flex-col gap-3 p-5">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex items-center justify-between gap-4">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
    </Card>
  )
}
