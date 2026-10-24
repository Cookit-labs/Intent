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
      className={cn('h-4 w-4 shrink-0 fill-[#1d9bf0] text-white', className)}
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

  return (
    <a
      href={venue.url}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'bg-bubble-agent text-bubble-agent-foreground border-bubble-agent-border group relative flex h-full flex-col gap-4 rounded-3xl border p-5 transition-all duration-200',
        live
          ? 'hover:border-brand/30 hover:-translate-y-0.5 hover:shadow-[0_12px_32px_-12px_hsl(var(--brand)/0.35)]'
          : 'hover:border-brand/20 opacity-80 hover:opacity-100'
      )}
    >
      <div className="flex items-center gap-3">
        <VenueLogo venue={venue} className={cn('h-11 w-11', !live && 'grayscale-[40%]')} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-base font-semibold">{venue.name}</span>
            {live && integration === 'executes' ? <VerifiedTick /> : null}
            {venue.beta === true ? (
              <span className="bg-warning/15 text-warning rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
                Beta
              </span>
            ) : null}
          </div>
          <div className="text-muted-foreground flex items-center gap-1.5 truncate text-xs">
            <span>{categoryLabel[venue.category]}</span>
            {live && integration === 'quotes' ? (
              <>
                <span aria-hidden>·</span>
                <span>Quotes only</span>
              </>
            ) : null}
            {notHere !== undefined ? (
              <>
                <span aria-hidden>·</span>
                <span>{notHere}</span>
              </>
            ) : null}
          </div>
        </div>
        <span className="text-muted-foreground group-hover:bg-brand group-hover:text-brand-foreground flex h-8 w-8 shrink-0 items-center justify-center self-start rounded-full transition-colors">
          <ArrowUpRight className="h-4 w-4 transition-transform group-hover:-translate-y-px group-hover:translate-x-px" />
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        <p className="text-sm font-medium leading-snug">{venue.bestFor}</p>
        {/* What the app can actually do here. Shown only when there is
            something to say. */}
        {venue.capability !== undefined ? (
          <p
            className="text-muted-foreground line-clamp-3 text-xs leading-relaxed"
            title={venue.capability}
          >
            {venue.capability}
          </p>
        ) : null}
      </div>

      <div className="mt-auto flex items-center -space-x-1.5 pt-1">
        {venue.chains.map((chain) =>
          // The chains this app runs on draw the shared mark, which scales
          // better than a bitmap at 20px and matches the switcher exactly.
          chainSlug(chain) === 'stellar' || chainSlug(chain) === 'arc' ? (
            <ChainMark
              key={chain}
              chain={chainSlug(chain) as 'stellar' | 'arc'}
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
    </a>
  )
}
