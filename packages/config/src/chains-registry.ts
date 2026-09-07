import type { ChainDescriptor, ChainSlug } from '@intent/types'

import { arcTestnet } from './chain'
import { stellarDescriptor } from './stellar'

export const arcDescriptor: ChainDescriptor = {
  slug: 'arc',
  family: 'evm',
  name: 'Arc',
  network: 'arc-testnet',
  networkLabel: 'Arc testnet',
  nativeCurrency: arcTestnet.nativeCurrency,
  blockExplorerUrl: arcTestnet.blockExplorerUrl,
  enabled: true,
}

export const CHAIN_DESCRIPTORS: Record<ChainSlug, ChainDescriptor> = {
  arc: arcDescriptor,
  stellar: stellarDescriptor,
}

/** Display order for switchers and menus. */
export const CHAIN_ORDER: readonly ChainSlug[] = ['arc', 'stellar']

export const DEFAULT_CHAIN: ChainSlug = 'arc'

export function isChainSlug(value: string): value is ChainSlug {
  return value === 'arc' || value === 'stellar'
}

export function getChainDescriptor(slug: ChainSlug): ChainDescriptor {
  return CHAIN_DESCRIPTORS[slug]
}

/**
 * Explorer URL for an account. The two chains disagree on both path and address
 * shape, so callers must not build these by hand.
 */
export function accountExplorerUrl(slug: ChainSlug, address: string): string {
  const base = CHAIN_DESCRIPTORS[slug].blockExplorerUrl
  return slug === 'stellar' ? `${base}/account/${address}` : `${base}/address/${address}`
}
