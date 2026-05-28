import type { ChainConfig, SupportedNetwork } from '@intent/types'

export const arcTestnet: ChainConfig = {
  id: 0, // TODO: replace with actual Arc L1 testnet chain ID
  name: 'Arc Testnet',
  rpcUrl: process.env['ARC_RPC_URL'] ?? 'https://rpc.arc-testnet.xyz',
  blockExplorerUrl: 'https://explorer.arc-testnet.xyz',
  nativeCurrency: { name: 'Arc', symbol: 'ARC', decimals: 18 },
}

export const chains: Record<SupportedNetwork, ChainConfig> = {
  'arc-testnet': arcTestnet,
  'arc-mainnet': { ...arcTestnet, id: 0, name: 'Arc Mainnet' }, // TODO: update
  local: {
    id: 31337,
    name: 'Anvil Local',
    rpcUrl: 'http://localhost:8545',
    blockExplorerUrl: 'http://localhost:8545',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  },
}