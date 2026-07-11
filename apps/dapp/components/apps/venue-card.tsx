'use client'

import type { Venue, VenueCategory } from '@intent/types'
import { Badge, Card } from '@intent/ui'
import { ArrowUpRight } from 'lucide-react'

const categoryLabel: Record<VenueCategory, string> = {
  swap: 'Swap',
  aggregator: 'Aggregator',
  orderbook: 'Order book',
}

const categoryVariant: Record<VenueCategory, 'secondary' | 'accent' | 'outline'> = {
  swap: 'secondary',
  aggregator: 'accent',
  orderbook: 'outline',
}

export function VenueCard({ venue }: { venue: Venue }): JSX.Element {
  return (
    <a href={venue.url} target="_blank" rel="noopener noreferrer" className="block">
      <Card className="hover:border-brand/40 hover:bg-muted/30 flex h-full flex-col gap-4 p-5 transition-colors">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="bg-brand/10 font-display text-brand flex h-10 w-10 items-center justify-center rounded-md text-lg font-semibold">
              {venue.name.charAt(0)}
            </span>
            <div>
              <p className="font-display text-base font-semibold leading-tight">{venue.name}</p>
              <Badge variant={categoryVariant[venue.category]} className="mt-1">
                {categoryLabel[venue.category]}
              </Badge>
            </div>
          </div>
          <ArrowUpRight className="text-muted-foreground h-4 w-4 shrink-0" />
        </div>

        <p className="text-muted-foreground text-sm">{venue.bestFor}</p>

        <div className="mt-auto flex flex-wrap gap-1.5">
          {venue.chains.map((chain) => (
            <span
              key={chain}
              className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-mono text-[11px]"
            >
              {chain}
            </span>
          ))}
        </div>
      </Card>
    </a>
  )
}
