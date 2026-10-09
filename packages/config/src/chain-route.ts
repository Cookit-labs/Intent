import type { ChainSlug } from '@intent/types'

import {
  defaultNetwork,
  enabledNetworks,
  isMultiNetwork,
  type StellarNetworkName,
} from './network-select'

/**
 * The first path segment of every app page, read as a chain and a network.
 *
 *   arc              -> Arc
 *   stellar          -> Stellar on the deployment's default network
 *   stellar-mainnet  -> Stellar on mainnet
 *   stellar-testnet  -> Stellar on testnet
 *
 * A Stellar network segment is only valid when the deployment serves it. With
 * one network served, `/stellar` stays the one address, as it has always been;
 * with several, `/stellar` is a legacy address that redirects to the default
 * network's own.
 */
export interface ChainRoute {
  slug: ChainSlug
  /** Set for Stellar; absent for Arc. */
  network?: StellarNetworkName
  /** The bare `/stellar` segment, with the network left to the default. */
  legacy?: true
}

export function parseChainSegment(
  segment: string,
  enabled: readonly StellarNetworkName[] = enabledNetworks()
): ChainRoute | undefined {
  if (segment === 'arc') return { slug: 'arc' }
  if (segment === 'stellar') return { slug: 'stellar', legacy: true }
  if (segment === 'stellar-mainnet' && enabled.includes('mainnet')) {
    return { slug: 'stellar', network: 'mainnet' }
  }
  if (segment === 'stellar-testnet' && enabled.includes('testnet')) {
    return { slug: 'stellar', network: 'testnet' }
  }
  return undefined
}

/** The path segment for a chain: network-specific when several networks are served. */
export function chainSegment(slug: ChainSlug, network?: StellarNetworkName): string {
  if (slug === 'arc' || !isMultiNetwork()) return slug
  return `stellar-${network ?? defaultNetwork()}`
}

/**
 * The chain segment the app opens on: Stellar, on mainnet whenever the deployment
 * serves it. A deployment that serves one network keeps its one `/stellar` address,
 * which is that network, whichever it is.
 */
export function homeSegment(enabled: readonly StellarNetworkName[] = enabledNetworks()): string {
  return enabled.length > 1 && enabled.includes('mainnet') ? 'stellar-mainnet' : 'stellar'
}

/** Where the bare root of the app goes. */
export function homePath(enabled: readonly StellarNetworkName[] = enabledNetworks()): string {
  return `/${homeSegment(enabled)}/intents`
}

/** Every segment this deployment answers to, for static generation and menus. */
export function chainSegments(): string[] {
  if (!isMultiNetwork()) return ['arc', 'stellar']
  return ['arc', ...enabledNetworks().map((n) => `stellar-${n}`)]
}
