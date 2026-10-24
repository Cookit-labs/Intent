'use client'

import type { Venue, VenueCategory } from '@intent/types'
import { ChainMark, cn } from '@intent/ui'
import { ArrowUpRight, BadgeCheck } from 'lucide-react'
import Image from 'next/image'
import { useState } from 'react'

export const categoryLabel: Record<VenueCategory, string> = {
  swap: 'Swap',
  aggregator: 'Aggregator',
  orderbook: 'Order book',
  lending: 'Lending',
  rwa: 'Real-world assets',
  pool: 'Liquidity pool',
  offramp: 'Off-ramp',
  perps: 'Perpetuals',
  names: 'Names',
  infrastructure: 'Network',
}

function chainSlug(chain: string): string {
  return chain
    .toLowerCase()
    .replace(/\s*chain$/, '')
    .trim()
}

/**
 * The verified mark, for a venue intents can actually be signed through.
 *
 * The page used to list every venue identically, so a user could not tell that
 * intents could be signed through Soroswap and, at the time, only priced on
 * Aquarius. That is the most useful thing this page can say.
 */
export function VerifiedTick({ className }: { className?: string }): JSX.Element {
  return (
    <BadgeCheck
      className={cn('fill-brand text-brand-foreground h-4 w-4 shrink-0', className)}
      aria-label="Integrated: agents can execute here"
      role="img"
    />
  )
}

/**
 * Venue logo, falling back to a lettermark.
 *
 * Logos live at /images/venues/<id>.webp. The network itself draws the Stellar
 * mark; anything else without a logo degrades to its initial rather than a
 * broken frame.
 */
export function VenueLogo({
  venue,
  className = 'h-12 w-12',
}: {
  venue: Venue
  className?: string
}): JSX.Element {
  const [failed, setFailed] = useState(false)

  if (venue.category === 'infrastructure' && venue.family === 'stellar') {
    return <ChainMark chain="stellar" className={cn('shrink-0 rounded-2xl', className)} />
  }

  if (failed) {
    return (
      <span
        className={cn(
          'bg-bubble-me text-bubble-me-foreground flex shrink-0 items-center justify-center rounded-2xl text-lg font-semibold',
          className
        )}
      >
        {venue.name.charAt(0)}
      </span>
    )
  }

  return (
    <Image
      src={`/images/venues/${venue.id}.webp`}
      alt=""
      width={48}
      height={48}
      onError={() => setFailed(true)}
      className={cn('ring-border/60 shrink-0 rounded-2xl object-cover ring-1', className)}
    />
  )
}

/**
 * The venue's own colour, as light behind its tile: its logo, blown up and
 * blurred. Gives each tile depth without adding words. A venue with no logo
 * glows in the brand purple.
 */
function VenueGlow({ venue }: { venue: Venue }): JSX.Element {
  const [failed, setFailed] = useState(false)
  const base =
    'pointer-events-none absolute -left-10 -top-10 h-48 w-48 rounded-full opacity-25 blur-3xl transition-opacity duration-300 group-hover:opacity-45'
  if (failed || venue.category === 'infrastructure') {
    return <span aria-hidden className={cn(base, 'bg-brand')} />
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/images/venues/${venue.id}.webp`}
      alt=""
      aria-hidden
      onError={() => setFailed(true)}
      className={cn(base, 'object-cover')}
    />
  )
}

export function VenueCard({
  venue,
  live,
  notHere,
}: {
  venue: Venue
  /** Wired in and on this network, so agents can use it now. */
  live: boolean
  /** Why it is not usable here, when it is not. */
  notHere?: string | undefined
}): JSX.Element {
  // Absent means listed. A venue nobody wired in is exactly that, and
  // defaulting the other way would claim integrations that do not exist.
  const integration = venue.integration ?? 'listed'
  // Every Stellar venue is on Stellar, so its mark would say nothing here.
  const showChains = venue.family !== 'stellar'

  return (
    <a
      href={venue.url}
      target="_blank"
      rel="noopener noreferrer"
      // What the app can actually do here, for anyone who wants the detail.
      title={venue.capability ?? venue.bestFor}
      className={cn(
        'bg-bubble-agent text-bubble-agent-foreground border-bubble-agent-border group relative isolate flex flex-col justify-between gap-4 overflow-hidden rounded-3xl border p-4 transition-all duration-200 sm:aspect-square',
        live
          ? 'hover:border-brand/30 hover:-translate-y-0.5 hover:shadow-[0_12px_32px_-12px_hsl(var(--brand)/0.35)]'
          : 'hover:border-brand/20 opacity-80 hover:opacity-100'
      )}
    >
      <VenueGlow venue={venue} />
      <div className="relative flex items-start justify-between gap-2">
        <VenueLogo
          venue={venue}
          className={cn('h-12 w-12 shadow-lg shadow-black/20', !live && 'grayscale-[40%]')}
        />
        <div className="flex items-center gap-1.5">
          {showChains ? (
            <div className="flex -space-x-1.5">
              {venue.chains
                .slice(0, 3)
                .map((chain) =>
                  chainSlug(chain) === 'arc' ? (
                    <ChainMark
                      key={chain}
                      chain="arc"
                      className="ring-bubble-agent h-5 w-5 rounded-full ring-2"
                    />
                  ) : (
                    <Image
                      key={chain}
                      src={`/images/chains/${chainSlug(chain)}.webp`}
                      alt={chain}
                      title={chain}
                      width={20}
                      height={20}
                      className="ring-bubble-agent h-5 w-5 rounded-full ring-2"
                    />
                  )
                )}
            </div>
          ) : null}
          <span className="text-muted-foreground group-hover:bg-brand group-hover:text-brand-foreground flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors">
            <ArrowUpRight className="h-4 w-4 transition-transform group-hover:-translate-y-px group-hover:translate-x-px" />
          </span>
        </div>
      </div>

      <div className="relative flex min-w-0 flex-col gap-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[15px] font-semibold">{venue.name}</span>
          {live && integration === 'executes' ? <VerifiedTick /> : null}
          {venue.beta === true ? (
            <span className="bg-warning/15 text-warning rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
              Beta
            </span>
          ) : null}
        </div>
        <div className="text-muted-foreground truncate text-xs">
          {[
            categoryLabel[venue.category],
            live && integration === 'quotes' ? 'Quotes only' : undefined,
            notHere,
          ]
            .filter(Boolean)
            .join(' · ')}
        </div>
        <p className="mt-1.5 line-clamp-2 text-sm leading-snug">{venue.bestFor}</p>
        <div className="border-bubble-agent-foreground/10 mt-3 flex items-center gap-1.5 border-t pt-3 text-[11px] font-medium">
          {live ? (
            <>
              <span className="relative flex h-2 w-2">
                <span className="bg-success absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 motion-reduce:animate-none" />
                <span className="bg-success relative inline-flex h-2 w-2 rounded-full" />
              </span>
              <span>{integration === 'quotes' ? 'Prices live' : 'Agents trade here'}</span>
            </>
          ) : (
            <>
              <span className="bg-muted-foreground/50 h-2 w-2 rounded-full" />
              <span className="text-muted-foreground">
                {notHere !== undefined ? 'Coming soon' : 'Listed'}
              </span>
            </>
          )}
        </div>
      </div>
    </a>
  )
}
