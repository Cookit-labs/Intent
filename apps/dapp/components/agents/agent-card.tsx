'use client'
import { Card, Skeleton } from '@intent/ui'

export function AgentCard(): JSX.Element {
  return (
    <Card className="flex items-center gap-4 p-5">
      <Skeleton className="h-10 w-10 rounded-full" />
      <div className="flex flex-1 flex-col gap-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3 w-20" />
      </div>
      <Skeleton className="h-6 w-14" />
    </Card>
  )
}
