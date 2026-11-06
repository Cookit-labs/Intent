import type { Venue } from '@intent/types'

import { aftermathListing } from './aftermath-listing'
import { deepbookListing } from './deepbook-listing'
import { momentumListing } from './momentum-listing'
import { scallopListing } from './scallop-listing'
import { suilendListing } from './suilend-listing'
import { walrusListing } from './walrus-listing'

function listed(
  id: string,
  name: string,
  category: Venue['category'],
  url: string,
  bestFor: string
): Venue {
  return { id, family: 'sui', name, category, chains: ['Sui'], url, bestFor }
}

export const suiVenues: Venue[] = [
  listed(
    'linq-sui',
    'Linq (Sui USDC, USDsui)',
    'offramp',
    'https://switch.uselinq.xyz',
    'Naira cash-out from Sui. Not connected yet: needs Linq to confirm Sui and a separate payment path'
  ),
  {
    id: 'cetus',
    family: 'sui',
    name: 'Cetus Aggregator',
    category: 'aggregator',
    chains: ['Sui'],
    url: 'https://app.cetus.zone',
    bestFor: "Swaps at the best route across Sui's main pools",
    integration: 'executes',
    capability: 'Swaps SUI, USDC, USDsui, USDT, WAL and the liquid staking tokens sSUI and afSUI',
  },
  // Listed, as Lulo is on Solana: whether this runs depends on a secret this client-safe file can't read.
  listed(
    '1click-sui',
    'NEAR Intents 1Click',
    'swap',
    'https://docs.near-intents.org/integration/distribution-channels/1click-api/about-1click-api',
    'A second swap price from competing market makers, spending USDC or USDT'
  ),
  {
    id: 'navi',
    family: 'sui',
    name: 'NAVI',
    category: 'lending',
    chains: ['Sui'],
    url: 'https://app.naviprotocol.io',
    bestFor: 'Earning on USDC, at a variable rate that can move quickly',
    integration: 'executes',
    capability:
      'Supplies USDC, withdraws, borrows and repays, shows the current rate, and refuses a loan your supply cannot safely back',
  },
  listed(
    'bluefin-aggregator',
    'Bluefin Aggregator',
    'aggregator',
    'https://trade.bluefin.io/swap',
    'Swaps with quotes from market makers, formerly 7K'
  ),
  suilendListing,
  listed(
    'current-finance',
    'Current Finance',
    'lending',
    'https://current.finance',
    'Larger USDC lending market, where much of the rate is rewards that can end'
  ),
  listed(
    'payment-kit',
    'Sui Payment Kit',
    'payments',
    'https://docs.sui.io/standards/payment-kit',
    'Payment links and receipts, with USDsui or any coin. Still a 0.x release'
  ),
  listed(
    'ember',
    'Ember',
    'savings',
    'https://ember.so',
    'Higher-yield vaults with multi-day withdrawals and mixed strategies. Not plain savings'
  ),
  listed(
    'bucket',
    'Bucket',
    'savings',
    'https://www.bucketprotocol.io',
    'USDB savings, though the current rate may not compete'
  ),
  deepbookListing,
  momentumListing,
  walrusListing,
  {
    id: 'deepbook-limit',
    family: 'sui',
    name: 'DeepBook Limit Orders',
    category: 'orderbook',
    chains: ['Sui'],
    url: 'https://deepbook.xyz',
    bestFor: 'Selling or buying SUI at a price you name, for up to 7 days',
    integration: 'executes',
    capability:
      'Places, reads, cancels and collects SUI orders against USDC, and checks every transaction before you sign. Filled tokens wait in your DeepBook account until you collect them.',
  },
  {
    id: 'springsui',
    family: 'sui',
    name: 'SpringSui',
    category: 'staking',
    chains: ['Sui'],
    url: 'https://www.springsui.com',
    bestFor: 'Liquid staking with the largest pool on Sui',
    integration: 'executes',
    capability: 'Stakes SUI for sSUI, and unstakes sSUI right away for a small fee',
  },
  aftermathListing,
  scallopListing,
]
