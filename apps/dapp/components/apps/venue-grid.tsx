'use client'

import { EmptyState, Input } from '@intent/ui'
import { Search } from 'lucide-react'
import { useMemo, useState } from 'react'

import { useChain } from '../../providers/chain-provider'
import { venues } from '../../lib/venues'
import { VenueCard } from './venue-card'

/** Integrated first, then quoted, then merely listed. */
function rank(venue: { integration?: string }): number {
  switch (venue.integration) {
    case 'executes':
      return 2
    case 'quotes':
      return 1
    default:
      return 0
  }
}

export function VenueGrid(): JSX.Element {
  const [query, setQuery] = useState('')
  const { descriptor } = useChain()

  const filtered = useMemo(() => {
    // Only venues that exist on the active chain's family: a Stellar user has
    // no way to trade on Uniswap, so listing it would be noise.
    const onChain = venues.filter((v) => v.family === descriptor.family)

    // Venues the app can actually use come first. Alphabetical order put
    // Aquarius — which intents have never touched — above Soroswap, which they
    // route through, so the most useful thing the page knows was buried.
    const ranked = [...onChain].sort((a, b) => rank(b) - rank(a))

    const q = query.trim().toLowerCase()
    if (!q) return ranked
    return ranked.filter((v) =>
      // Capability is searchable too: someone looking for "treasuries" or
      // "lending" is describing what they want done, not naming a venue.
      [v.name, v.category, v.bestFor, v.capability ?? ''].some((field) =>
        field.toLowerCase().includes(q)
      )
    )
  }, [query, descriptor.family])

  return (
    <div className="flex flex-col gap-5">
      <div className="relative max-w-sm">
        <Search className="text-muted-foreground pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search venues"
          className="pl-9"
          aria-label="Search venues"
        />
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title="No venues found"
          description={`Nothing matches "${query}". Try a different name or category.`}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((venue) => (
            <VenueCard key={venue.id} venue={venue} />
          ))}
        </div>
      )}
    </div>
  )
}
