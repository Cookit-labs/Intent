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

export const solanaDescriptor: ChainDescriptor = {
  slug: 'solana',
  family: 'solana',
  name: 'Solana',
  network: 'solana-mainnet',
  networkLabel: 'Solana mainnet',
  nativeCurrency: { name: 'Solana', symbol: 'SOL', decimals: 9 },
  blockExplorerUrl: 'https://solscan.io',
  enabled: true,
}

export const avalancheDescriptor: ChainDescriptor = {
  slug: 'avalanche',
  family: 'evm',
  name: 'Avalanche',
  network: 'avalanche-mainnet',
  networkLabel: 'Avalanche mainnet',
  nativeCurrency: { name: 'Avalanche', symbol: 'AVAX', decimals: 18 },
  blockExplorerUrl: 'https://snowtrace.io',
  enabled: true,
}

export const suiDescriptor: ChainDescriptor = {
  slug: 'sui',
  family: 'sui',
  name: 'Sui',
  network: 'sui-mainnet',
  networkLabel: 'Sui mainnet',
  nativeCurrency: { name: 'Sui', symbol: 'SUI', decimals: 9 },
  blockExplorerUrl: 'https://suiscan.xyz/mainnet',
  enabled: true,
}

export const monadDescriptor: ChainDescriptor = {
  slug: 'monad',
  family: 'evm',
  name: 'Monad',
  network: 'monad-mainnet',
  networkLabel: 'Monad mainnet',
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  blockExplorerUrl: 'https://monadvision.com',
  enabled: true,
}

export const nearDescriptor: ChainDescriptor = {
  slug: 'near',
  family: 'near',
  name: 'NEAR',
  network: 'near-mainnet',
  networkLabel: 'NEAR mainnet',
  nativeCurrency: { name: 'NEAR', symbol: 'NEAR', decimals: 24 },
  blockExplorerUrl: 'https://nearblocks.io',
  enabled: true,
}

export const CHAIN_DESCRIPTORS: Record<ChainSlug, ChainDescriptor> = {
  arc: arcDescriptor,
  stellar: stellarDescriptor,
  solana: solanaDescriptor,
  avalanche: avalancheDescriptor,
  sui: suiDescriptor,
  monad: monadDescriptor,
  near: nearDescriptor,
}

/** Every chain the app has an address for. */
export const CHAIN_ORDER: readonly ChainSlug[] = [
  'arc',
  'stellar',
  'solana',
  'avalanche',
  'sui',
  'monad',
  'near',
]

/** The chains a person can connect to, in the order the picker shows them. Arc is not offered. */
export const CONNECT_CHAINS: readonly ChainSlug[] = [
  'stellar',
  'solana',
  'avalanche',
  'sui',
  'monad',
  'near',
]

export const DEFAULT_CHAIN: ChainSlug = 'stellar'

export function isChainSlug(value: string): value is ChainSlug {
  return (CHAIN_ORDER as readonly string[]).includes(value)
}

export function getChainDescriptor(slug: ChainSlug): ChainDescriptor {
  return CHAIN_DESCRIPTORS[slug]
}

/**
 * Explorer URL for a transaction, for the same reason. NEAR's explorer is the one that disagrees.
 * Stellar's descriptor is built for whichever network the page is on, so its base is right too.
 */
export function txExplorerUrl(slug: ChainSlug, hash: string): string {
  const base = CHAIN_DESCRIPTORS[slug].blockExplorerUrl
  return slug === 'near' ? `${base}/txns/${hash}` : `${base}/tx/${hash}`
}

/** Explorers that say `account` where the rest say `address`. */
const ACCOUNT_PATH_CHAINS: readonly ChainSlug[] = ['stellar', 'solana', 'sui']

/**
 * Explorer URL for an account. Chains disagree on both path and address shape,
 * so callers must not build these by hand.
 */
export function accountExplorerUrl(slug: ChainSlug, address: string): string {
  const base = CHAIN_DESCRIPTORS[slug].blockExplorerUrl
  return ACCOUNT_PATH_CHAINS.includes(slug)
    ? `${base}/account/${address}`
    : `${base}/address/${address}`
}
