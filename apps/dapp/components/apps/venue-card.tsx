'use client'

import type { Venue, VenueCategory } from '@intent/types'
import { Badge, Card } from '@intent/ui'
import { ArrowUpRight } from 'lucide-react'
import Image from 'next/image'

const categoryLabel: Record<VenueCategory, string> = {
  swap: 'Swap',
  aggregator: 'Aggregator',
  orderbook: 'Order book',
}

function chainSlug(chain: string): string {
  return chain
    .toLowerCase()
    .replace(/\s*chain$/, '')
    .trim()
}

export function VenueCard({ venue }: { venue: Venue }): JSX.Element {
  return (
    <a href={venue.url} target="_blank" rel="noopener noreferrer" className="block">
      <Card className="hover:border-foreground/40 flex h-full flex-col gap-4 p-5 transition-colors">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <Image
              src={`/images/venues/${venue.id}.webp`}
              alt={`${venue.name} logo`}
              width={40}
              height={40}
              className="h-10 w-10 shrink-0 rounded-md object-contain"
            />
            <div>
              <p className="font-display text-base font-semibold leading-tight">{venue.name}</p>
              <Badge variant="outline" className="mt-1">
                {categoryLabel[venue.category]}
              </Badge>
            </div>
          </div>
          <ArrowUpRight className="text-muted-foreground h-4 w-4 shrink-0" />
        </div>

        <p className="text-muted-foreground text-sm">{venue.bestFor}</p>

        <div className="mt-auto flex items-center -space-x-1.5">
          {venue.chains.map((chain) => (
            <Image
              key={chain}
              src={`/images/chains/${chainSlug(chain)}.webp`}
              alt={chain}
              title={chain}
              width={20}
              height={20}
              className="ring-background h-5 w-5 rounded-full ring-2"
            />
          ))}
        </div>
      </Card>
    </a>
  )
}
