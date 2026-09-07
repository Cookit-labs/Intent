export interface ChainConfig {
  id: number
  name: string
  rpcUrl: string
  blockExplorerUrl: string
  nativeCurrency: {
    name: string
    symbol: string
    decimals: number
  }
}

export interface ContractAddresses {
  intentEscrow: `0x${string}`
  reputationRegistry: `0x${string}`
  agentRegistry: `0x${string}`
  settlementManager: `0x${string}`
  executionValidator: `0x${string}`
  usdc: `0x${string}`
}

export type SupportedNetwork = 'arc-testnet' | 'arc-mainnet' | 'local' | 'stellar-testnet'

/**
 * Which execution environment a chain belongs to. This is not cosmetic: EVM
 * chains are reachable through wagmi/viem and use `0x` addresses, while Stellar
 * uses Horizon/Soroban, `G...` addresses and a different wallet entirely. Code
 * that must branch on the two worlds branches on this, never on chain name.
 */
export type ChainFamily = 'evm' | 'stellar'

/**
 * The chain slug as it appears in dApp URLs (`/arc/intents`, `/stellar/vault`).
 * Deliberately distinct from `SupportedNetwork`: a slug names the chain a user
 * picked, while a network names a specific deployment of it (testnet vs
 * mainnet). One slug maps to different networks across environments.
 */
export type ChainSlug = 'arc' | 'stellar'

/**
 * Chain-agnostic descriptor the UI renders from. `ChainConfig` above stays
 * EVM-shaped (numeric `id`) because wagmi requires that; this is the wider
 * description that Stellar can also satisfy.
 */
export interface ChainDescriptor {
  slug: ChainSlug
  family: ChainFamily
  /** Display name, e.g. "Arc" — not the network name. */
  name: string
  network: SupportedNetwork
  /** Human label for the active network, e.g. "Arc testnet". */
  networkLabel: string
  nativeCurrency: {
    name: string
    symbol: string
    decimals: number
  }
  blockExplorerUrl: string
  /** Whether the chain is selectable in the UI yet. */
  enabled: boolean
}