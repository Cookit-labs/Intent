import type { Venue } from '@intent/types'

import { aaveListings } from './aave-listing'
import { beefyMonadListing } from './beefy-listing'
import { bullaListing } from './bulla-listing'
import { curvanceListing } from './curvance-listing'
import { eulerMonadListing } from './euler-listing'
import { fastlaneListing } from './fastlane-listing'
import { morphoListing } from './morpho-listing'
import { neverlandListing } from './neverland-listing'
import { pharaohVenue } from './pharaoh-listing'
import { sablierVenues } from './sablier-listing'
import { uniswapAvalancheVenue, uniswapMonadVenue } from './uniswap-listing'

const ONECLICK_DOCS =
  'https://docs.near-intents.org/integration/distribution-channels/1click-api/about-1click-api'

// Listed, as Lulo is on Solana: whether this runs depends on a secret this client-safe file can't read.
export const evmVenues: Venue[] = [
  {
    id: '1click-avalanche',
    family: 'evm',
    name: 'NEAR Intents 1Click',
    category: 'swap',
    chains: ['Avalanche'],
    url: ONECLICK_DOCS,
    bestFor: 'Swaps between AVAX, USDC and USDT, priced by competing market makers',
  },
  {
    id: '1click-monad',
    family: 'evm',
    name: 'NEAR Intents 1Click',
    category: 'swap',
    chains: ['Monad'],
    url: ONECLICK_DOCS,
    bestFor: 'Swaps between MON, USDC and USDT0, priced by competing market makers',
  },
  uniswapAvalancheVenue,
  uniswapMonadVenue,
  pharaohVenue,
  ...aaveListings,
  neverlandListing,
  morphoListing,
  eulerMonadListing,
  curvanceListing,
  beefyMonadListing,
  fastlaneListing,
  ...sablierVenues,
  bullaListing,
]
