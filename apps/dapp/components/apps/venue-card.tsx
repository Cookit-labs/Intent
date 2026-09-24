'use client'

import type { Venue, VenueCategory, VenueIntegration } from '@intent/types'
import { Badge, Card, ChainMark } from '@intent/ui'
import { ArrowUpRight, Check } from 'lucide-react'
import Image from 'next/image'
import { useState } from 'react'

import { notOnNetworkLabel } from '../../lib/venues'

const categoryLabel: Record<VenueCategory, string> = {
  swap: 'Swap',
  aggregator: 'Aggregator',
  orderbook: 'Order book',
  lending: 'Lending',
  rwa: 'Real-world assets',
  pool: 'Liquidity pool',
  offramp: 'Off-ramp',
  perps: 'Perpetuals',
  names: 'Names',
}

/**
 * How far a venue is wired in, said plainly.
 *
 * The page used to list every venue identically, so a user could not tell that
 * intents could be signed through Soroswap and, at the time, only priced on
 * Aquarius. That is the most useful thing this page can say, and it was the
 * one thing missing.
 */
const integrationLabel: Record<VenueIntegration, string> = {
  executes: 'Integrated',
  quotes: 'Quoting only',
  listed: '',
}

function chainSlug(chain: string): string {
  return chain
    .toLowerCase()
    .replace(/\s*chain$/, '')
    .trim()
}

/**
 * Venue logo, falling back to a lettermark.
 *
 * Logos live at /images/venues/<id>.webp. A venue without one degrades to its
 * initial rather than a broken frame, which is what an anchor added before its
 * logo was sourced looks like — deliberate enough to ship, and obviously
 * incomplete enough that nobody mistakes it for the final treatment.
 */
function VenueLogo({ venue }: { venue: Venue }): JSX.Element {
  const [failed, setFailed] = useState(false)

  if (failed) {
    return (
      <span className="bg-muted text-muted-foreground font-display flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-base font-semibold">
        {venue.name.charAt(0)}
      </span>
    )
  }

  return (
    <Image
      src={`/images/venues/${venue.id}.webp`}
      alt={`${venue.name} logo`}
      width={40}
      height={40}
      onError={() => setFailed(true)}
      className="h-10 w-10 shrink-0 rounded-md object-contain"
    />
  )
}

export function VenueCard({
  venue,
  onNetwork,
}: {
  venue: Venue
  /** Whether the venue exists on the active network, as the server decided. */
  onNetwork: boolean
}): JSX.Element {
  // Absent means listed. A venue nobody wired in is exactly that, and
  // defaulting the other way would claim integrations that do not exist.
  const integration = venue.integration ?? 'listed'
  // Quiet, and only where it is true: a venue wired in against testnet whose
  // mainnet contracts are not yet verified is not "Integrated" on mainnet.
  const notHere = notOnNetworkLabel(venue, undefined, onNetwork)

  return (
    <a href={venue.url} target="_blank" rel="noopener noreferrer" className="block">
      <Card className="hover:border-foreground/40 flex h-full flex-col gap-4 p-5 transition-colors">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <VenueLogo venue={venue} />
            <div>
              <p className="font-display text-base font-semibold leading-tight">{venue.name}</p>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <Badge variant="outline">{categoryLabel[venue.category]}</Badge>
                {/* Filled for a venue the app actually uses, outlined for one it
                    only prices. A venue it merely links to gets no badge at
                    all — absence is the honest signal, and a third label would
                    imply a relationship that does not exist. */}
                {notHere !== undefined ? (
                  <Badge variant="outline" className="text-muted-foreground">
                    {notHere}
                  </Badge>
                ) : integration === 'executes' ? (
                  <Badge className="gap-1">
                    <Check className="h-3 w-3" />
                    {integrationLabel.executes}
                  </Badge>
                ) : integration === 'quotes' ? (
                  <Badge variant="secondary">{integrationLabel.quotes}</Badge>
                ) : null}
              </div>
            </div>
          </div>
          <ArrowUpRight className="text-muted-foreground h-4 w-4 shrink-0" />
        </div>

        <p className="text-muted-foreground text-sm">{venue.bestFor}</p>

        {/* What the app can actually do here. Shown only when there is
            something to say: a badge without this is decoration. */}
        {venue.capability !== undefined ? (
          <p className="border-border text-muted-foreground border-l-2 pl-3 text-xs leading-relaxed">
            {venue.capability}
          </p>
        ) : null}

        <div className="mt-auto flex items-center -space-x-1.5">
          {venue.chains.map((chain) =>
            // The chains this app runs on draw the shared mark, which scales
            // better than a bitmap at 20px and matches the switcher exactly.
            chainSlug(chain) === 'stellar' || chainSlug(chain) === 'arc' ? (
              <ChainMark
                key={chain}
                chain={chainSlug(chain) as 'stellar' | 'arc'}
                className="ring-background h-5 w-5 rounded-full ring-2"
              />
            ) : (
              <Image
                key={chain}
                src={`/images/chains/${chainSlug(chain)}.webp`}
                alt={chain}
                title={chain}
                width={20}
                height={20}
                className="ring-background h-5 w-5 rounded-full ring-2"
              />
            )
          )}
        </div>
      </Card>
    </a>
  )
}
