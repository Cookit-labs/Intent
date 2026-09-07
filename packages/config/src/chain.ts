import type { ChainConfig, SupportedNetwork } from '@intent/types'

/**
 * Arc testnet. Values verified against the live chain, not the docs alone.
 *
 * Two things about Arc that surprise people:
 *
 * - **USDC is the gas token**, not a separate native coin. `nativeCurrency`
 *   below is USDC deliberately.
 * - **USDC has two decimal views**: 18 for native balances and `msg.value`, 6
 *   through the ERC-20 interface. Same underlying balance. `decimals: 18` here
 *   describes the native view, which is what wallets display. Anything reading
 *   the ERC-20 interface must use 6 or amounts are wrong by a factor of 10^12.
 */
export const arcTestnet: ChainConfig = {
  id: 5042002,
  name: 'Arc Testnet',
  rpcUrl: process.env['NEXT_PUBLIC_ARC_RPC_URL'] ?? 'https://rpc.testnet.arc.io',
  blockExplorerUrl: 'https://testnet.arcscan.app',
  nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 18 },
}

/**
 * Arc mainnet launches 2026-09-16. Circle publishes the chain ID and RPC
 * separately when available, so this stays unusable until they do — the id is
 * deliberately left at 0 so a misconfiguration fails loudly rather than
 * silently pointing at the wrong network.
 */
export const arcMainnet: ChainConfig = {
  id: 0, // TODO: set when Circle publishes it (mainnet 2026-09-16)
  name: 'Arc Mainnet',
  rpcUrl: process.env['NEXT_PUBLIC_ARC_MAINNET_RPC_URL'] ?? '',
  blockExplorerUrl: 'https://arcscan.app',
  nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 18 },
}

export const chains: Record<SupportedNetwork, ChainConfig> = {
  'arc-testnet': arcTestnet,
  'arc-mainnet': arcMainnet,
  local: {
    id: 31337,
    name: 'Anvil Local',
    rpcUrl: 'http://localhost:8545',
    blockExplorerUrl: 'http://localhost:8545',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  },
  // Stellar has no numeric chain id or EVM RPC; it is identified by network
  // passphrase (see `stellar.ts`). These fields exist only to satisfy the
  // EVM-shaped map — nothing on the Stellar path reads them.
  'stellar-testnet': {
    id: -1,
    name: 'Stellar Testnet',
    rpcUrl: 'https://horizon-testnet.stellar.org',
    blockExplorerUrl: 'https://stellar.expert/explorer/testnet',
    nativeCurrency: { name: 'Lumens', symbol: 'XLM', decimals: 7 },
  },
}

/** Decimals for USDC read through the ERC-20 interface, as opposed to natively. */
export const USDC_ERC20_DECIMALS = 6

/** Arc's USDC ERC-20 precompile. */
export const USDC_ERC20_ADDRESS: `0x${string}` = '0x3600000000000000000000000000000000000000'
