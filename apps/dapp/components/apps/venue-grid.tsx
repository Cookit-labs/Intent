'use client'

import type { Venue, VenueCategory } from '@intent/types'
import { cn } from '@intent/ui'
import { Search, X } from 'lucide-react'
import { useMemo, useState } from 'react'

import { useChain } from '../../providers/chain-provider'
import { notOnNetworkLabel, venues } from '../../lib/venues'
import { categoryLabel, VenueCard, VenueLogo, VerifiedTick } from './venue-card'

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

interface Row {
  venue: Venue
  live: boolean
  notHere: string | undefined
}

export function VenueGrid({
  availableIds,
}: {
  /** Venue ids that exist on the active network, as the server decided. */
  availableIds: string[]
}): JSX.Element {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<VenueCategory | 'all'>('all')
  const { descriptor } = useChain()

  // Only venues that exist on the active chain's family: a Stellar user has
  // no way to trade on Uniswap, so listing it would be noise.
  const rows = useMemo<Row[]>(
    () =>
      venues
        .filter((v) => v.family === descriptor.family)
        // Venues the app can actually use come first. Alphabetical order put
        // Aquarius — then only priced, never signed — above Soroswap, which
        // intents routed through, so the most useful thing was buried.
        .sort((a, b) => rank(b) - rank(a))
        .map((venue) => {
          const notHere = notOnNetworkLabel(venue, undefined, availableIds.includes(venue.id))
          return {
            venue,
            notHere,
            live: notHere === undefined && (venue.integration ?? 'listed') !== 'listed',
          }
        }),
    [descriptor.family, availableIds]
  )

  const categories = useMemo(() => {
    const counts = new Map<VenueCategory, number>()
    for (const r of rows) counts.set(r.venue.category, (counts.get(r.venue.category) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [rows])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter(({ venue: v }) => {
      if (category !== 'all' && v.category !== category) return false
      // Capability is searchable too: someone looking for "treasuries" or
      // "lending" is describing what they want done, not naming a venue.
      return (
        q === '' ||
        [v.name, categoryLabel[v.category], v.bestFor, v.capability ?? ''].some((f) =>
          f.toLowerCase().includes(q)
        )
      )
    })
  }, [rows, query, category])

  const liveRows = rows.filter((r) => r.live)
  const liveShown = shown.filter((r) => r.live)
  const restShown = shown.filter((r) => !r.live)
  const restTitle = restShown.some((r) => r.notHere !== undefined)
    ? 'Coming to mainnet'
    : 'More venues'

  return (
    <div className="flex flex-col gap-6">
      {liveRows.length > 0 ? (
        <div className="bg-bubble-agent border-bubble-agent-border flex flex-wrap items-center gap-4 rounded-3xl border px-5 py-4">
          <div className="flex -space-x-2.5">
            {liveRows.slice(0, 6).map(({ venue }) => (
              <VenueLogo
                key={venue.id}
                venue={venue}
                className="ring-bubble-agent h-9 w-9 rounded-full ring-2"
              />
            ))}
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="flex items-center gap-1.5 text-sm font-semibold">
              {liveRows.length} live venues <VerifiedTick />
            </span>
            <span className="text-muted-foreground text-xs">
              Agents compete across all of them on every intent. You never pick one yourself.
            </span>
          </div>
          {rows.length > liveRows.length ? (
            <span className="bg-muted/70 text-muted-foreground rounded-full px-3 py-1 text-xs">
              {rows.length - liveRows.length} more on the way
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-col gap-3">
        <label className="bg-muted/60 focus-within:bg-background focus-within:border-brand/40 flex items-center gap-2 rounded-full border border-transparent px-4 py-2 transition-colors md:max-w-md">
          <Search className="text-muted-foreground h-4 w-4" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search venues or what they do"
            aria-label="Search venues"
            className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-sm outline-none"
          />
          {query !== '' ? (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Clear search"
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </label>
        <div className="flex flex-wrap gap-1.5">
          {([['all', rows.length], ...categories] as [VenueCategory | 'all', number][]).map(
            ([value, count]) => (
              <button
                key={value}
                type="button"
                onClick={() => setCategory(value)}
                aria-pressed={category === value}
                className={cn(
                  'flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                  category === value
                    ? 'bg-foreground text-background'
                    : 'bg-muted/60 text-muted-foreground hover:text-foreground'
                )}
              >
                {value === 'all' ? 'All' : categoryLabel[value]}
                <span className="tabular-nums opacity-60">{count}</span>
              </button>
            )
          )}
        </div>
      </div>

      {shown.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-16 text-center">
          <p className="text-sm font-medium">No venues found</p>
          <p className="text-muted-foreground text-xs">
            Nothing matches{query !== '' ? ` “${query}”` : ''}. Try a different name or category.
          </p>
        </div>
      ) : null}

      {liveShown.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-muted-foreground flex items-center gap-2 text-xs font-semibold uppercase tracking-wider">
            <span className="bg-success h-1.5 w-1.5 rounded-full" /> Live now
            <span className="tabular-nums opacity-60">{liveShown.length}</span>
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(220px,1fr))] sm:gap-4">
            {liveShown.map((r) => (
              <VenueCard key={r.venue.id} venue={r.venue} live notHere={r.notHere} />
            ))}
          </div>
        </section>
      ) : null}

      {restShown.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-muted-foreground flex items-center gap-2 text-xs font-semibold uppercase tracking-wider">
            {restTitle}
            <span className="tabular-nums opacity-60">{restShown.length}</span>
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(220px,1fr))] sm:gap-4">
            {restShown.map((r) => (
              <VenueCard key={r.venue.id} venue={r.venue} live={false} notHere={r.notHere} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  )
}
