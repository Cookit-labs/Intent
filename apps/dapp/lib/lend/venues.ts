import { isDefindexConfigured, type Env } from './defindex/config'

/**
 * The lending venues this app integrates, and which of them a deployment can
 * actually reach.
 *
 * Two today. Blend is a public pool read over public RPC and needs nothing.
 * DeFindex builds its deposits through a keyed API, so it exists here only
 * when the key does. Everything that lists lending venues — the market
 * context, the agents' validation, the parser's allowlist — reads this rather
 * than naming `'blend'`, which is how a second venue arrives without a search
 * for every place the first was assumed.
 *
 * Blend is first on purpose: it is the default when a sentence names no
 * venue, and it always exists.
 */

export type LendingVenueId = 'blend' | 'defindex'

interface LendingVenueEntry {
  id: LendingVenueId
  /** How the venue is named in a sentence: "then supply the XLM to Blend". */
  name: string
  isConfigured: (env: Env) => boolean
}

const LENDING_VENUES: Record<LendingVenueId, LendingVenueEntry> = {
  blend: { id: 'blend', name: 'Blend', isConfigured: () => true },
  defindex: { id: 'defindex', name: 'DeFindex', isConfigured: isDefindexConfigured },
}

/** In display and precedence order. */
const ALL_LENDING_VENUES: readonly LendingVenueId[] = ['blend', 'defindex']

/** Where "supply it" goes when no venue is named. */
export const DEFAULT_LENDING_VENUE: LendingVenueId = 'blend'

export function isLendingVenueId(value: string): value is LendingVenueId {
  return Object.prototype.hasOwnProperty.call(LENDING_VENUES, value)
}

/** The venues this deployment can execute a supply on, Blend first. */
export function configuredLendingVenues(env: Env = process.env): LendingVenueId[] {
  return ALL_LENDING_VENUES.filter((id) => LENDING_VENUES[id].isConfigured(env))
}

/** The venue's name, or the id when it is not one of ours. */
export function lendingVenueName(id: string): string {
  return isLendingVenueId(id) ? LENDING_VENUES[id].name : id
}
