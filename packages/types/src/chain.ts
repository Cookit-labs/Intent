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

export type SupportedNetwork = 'arc-testnet' | 'arc-mainnet' | 'local'