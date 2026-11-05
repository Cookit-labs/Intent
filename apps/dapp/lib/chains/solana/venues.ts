import type { Venue } from '@intent/types'

import { jitoListing } from './jito-listing'
import { marinadeListing } from './marinade-listing'
import { solayerListing } from './solayer-listing'
import { streamflowVenue } from './streamflow-listing'

/**
 * The Solana apps the Apps screen shows, from the ranked table in the integration
 * report. `executes` means the app builds, checks, signs and submits here with no
 * extra configuration. Everything else is a listing and claims nothing. Client-safe.
 */
export const solanaVenues: Venue[] = [
  {
    id: 'jupiter',
    family: 'solana',
    name: 'Jupiter',
    category: 'aggregator',
    chains: ['Solana'],
    bestFor: 'Swapping between major Solana tokens at a routed price',
    url: 'https://jup.ag',
    integration: 'executes',
    capability:
      'Swaps USDC, USDT, SOL, JitoSOL, mSOL, sSOL and ONyc through Jupiter’s on-chain router. Refuses thin liquidity, and checks every transaction before you sign.',
  },
  {
    // Listed, as Lulo is: whether this runs depends on a secret this client-safe file can't read.
    id: '1click-solana',
    family: 'solana',
    name: 'NEAR Intents 1Click',
    category: 'swap',
    chains: ['Solana'],
    bestFor: 'A second swap price from competing market makers, spending USDC or USDT',
    url: 'https://docs.near-intents.org/integration/distribution-channels/1click-api/about-1click-api',
  },
  {
    id: 'jupiter-lend',
    family: 'solana',
    name: 'Jupiter Lend Earn',
    category: 'lending',
    chains: ['Solana'],
    bestFor: 'Earning a variable rate by lending USDC or USDT',
    url: 'https://jup.ag/lend',
    integration: 'executes',
    capability:
      'Deposits USDC or USDT and shows the current rate. Jupiter labels the API beta. Withdrawing isn’t wired here yet.',
  },
  {
    id: 'kamino',
    family: 'solana',
    name: 'Kamino Earn',
    category: 'lending',
    chains: ['Solana'],
    bestFor: 'Curated USDC vaults with a variable rate',
    url: 'https://kamino.com',
    integration: 'executes',
    capability:
      'Deposits USDC into Kamino’s largest USDC vault by deposits, and names it before you sign. Withdrawing isn’t wired here yet.',
  },
  {
    id: 'onre',
    family: 'solana',
    name: 'OnRe (ONyc)',
    category: 'rwa',
    chains: ['Solana'],
    bestFor: 'Tokenised reinsurance yield. Not a $1 token, and redemption has windows',
    url: 'https://www.onre.finance',
    integration: 'executes',
    capability:
      'Buys or sells ONyc on the market through a Jupiter swap only. Minting and redeeming with OnRe aren’t wired here.',
  },
  {
    id: 'linq-solana',
    family: 'solana',
    name: 'Linq (Solana USDC)',
    category: 'offramp',
    chains: ['Solana'],
    bestFor: 'Naira cash-out from Solana, once Linq confirms it and a payment path exists',
    url: 'https://switch.uselinq.xyz',
  },
  {
    id: 'paycrest',
    family: 'solana',
    name: 'Paycrest',
    category: 'offramp',
    chains: ['Solana'],
    bestFor: 'A candidate backup for naira cash-out, pending business verification',
    url: 'https://paycrest.io',
  },
  {
    id: 'lulo',
    family: 'solana',
    name: 'Lulo Protected',
    category: 'savings',
    chains: ['Solana'],
    bestFor: 'USDC lending with depositor-funded first-loss cover, which is not insurance',
    url: 'https://lulo.fi',
  },
  {
    id: 'jupiter-trigger',
    family: 'solana',
    name: 'Jupiter Trigger',
    category: 'orderbook',
    chains: ['Solana'],
    bestFor: 'Limit orders and recurring buys, with a $10 minimum per order or round',
    url: 'https://jup.ag',
  },
  {
    id: 'busha',
    family: 'solana',
    name: 'Busha',
    category: 'offramp',
    chains: ['Solana'],
    bestFor: 'A candidate for regulated naira cash-out. Its docs show USDT for selling, not USDC',
    url: 'https://busha.io',
  },
  {
    id: 'sanctum',
    family: 'solana',
    name: 'Sanctum',
    category: 'staking',
    chains: ['Solana'],
    bestFor: 'Liquid staking across many staked SOL tokens',
    url: 'https://sanctum.so',
  },
  {
    id: 'reflect',
    family: 'solana',
    name: 'Reflect (USDC+)',
    category: 'savings',
    chains: ['Solana'],
    bestFor: 'A yield-bearing dollar token. Sources disagree on what backs the yield',
    url: 'https://reflect.money',
  },
  {
    id: 'project-0',
    family: 'solana',
    name: 'Project 0',
    category: 'lending',
    chains: ['Solana'],
    bestFor: 'Borrowing and lending across venues, formerly marginfi',
    url: 'https://www.0.xyz',
  },
  {
    id: 'phoenix-perps',
    family: 'solana',
    name: 'Phoenix Perps',
    category: 'perps',
    chains: ['Solana'],
    bestFor: 'Order-book perpetuals. Leverage can lose your whole position',
    url: 'https://phoenix.trade',
  },
  {
    id: 'jupiter-perps',
    family: 'solana',
    name: 'Jupiter Perps',
    category: 'perps',
    chains: ['Solana'],
    bestFor: 'Oracle-priced perpetuals against a pool. Leverage can lose your whole position',
    url: 'https://jup.ag/perps',
  },
  jitoListing,
  marinadeListing,
  solayerListing,
  streamflowVenue,
]
