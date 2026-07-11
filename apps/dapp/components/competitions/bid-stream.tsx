'use client'
import { Skeleton } from '@intent/ui'

export function BidStream(): JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  )
}
