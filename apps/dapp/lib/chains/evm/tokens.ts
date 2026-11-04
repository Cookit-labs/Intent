import { avalanche, monad } from 'viem/chains'
import type { Chain } from 'viem'

import type { ChainToken } from '../types'

/**
 * Avalanche and Monad, which swap only through 1Click. Each contract here is matched against
 * 1Click's list by `oneClickAssetId` on chain, contract and decimals, so a wrong entry finds no
 * route rather than a wrong token.
 */

export type EvmChain = 'avalanche' | 'monad'

/** Stands for the chain's own coin, which has no contract. Not an address, so it can't be called. */
export const EVM_NATIVE_ID = 'native'

export const AVALANCHE_TOKENS: readonly ChainToken[] = [
  { symbol: 'AVAX', id: EVM_NATIVE_ID, decimals: 18, name: 'Avalanche' },
  // Circle's native USDC on the C-Chain, not the bridged USDC.e.
  {
    symbol: 'USDC',
    id: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
    decimals: 6,
    name: 'USD Coin',
  },
  // Tether's native USDt on the C-Chain, not the bridged USDT.e.
  {
    symbol: 'USDT',
    id: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7',
    decimals: 6,
    name: 'Tether USD',
  },
]

export const MONAD_TOKENS: readonly ChainToken[] = [
  { symbol: 'MON', id: EVM_NATIVE_ID, decimals: 18, name: 'Monad' },
  {
    symbol: 'USDC',
    id: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603',
    decimals: 6,
    name: 'USD Coin',
  },
  {
    symbol: 'USDT0',
    id: '0xe7cd86e13AC4309349F30B3435a9d337750fC82D',
    decimals: 6,
    name: 'USDT0',
  },
]

export interface EvmChainConfig {
  name: string
  chain: Chain
  tokens: readonly ChainToken[]
  nativeSymbol: string
  /**
   * Base units of the native coin kept for gas, and asked of anyone paying a token instead. Well
   * over one transfer on an ordinary day and not a quote: it only decides whether to refuse early,
   * because the wallet sets the real fee.
   */
  gasReserve: string
  /**
   * A balance the chain itself protects, where it has one. A spend that dips under it can revert
   * after it is signed, but not always, so this warns and doesn't refuse.
   */
  spendReserve?: { units: string; note: string; reverted: string }
  rpcEnv: string
  explorer: string
}

export const EVM_CHAINS: Record<EvmChain, EvmChainConfig> = {
  avalanche: {
    name: 'Avalanche',
    chain: avalanche,
    tokens: AVALANCHE_TOKENS,
    nativeSymbol: 'AVAX',
    gasReserve: '5000000000000000',
    rpcEnv: 'AVALANCHE_RPC_URL',
    explorer: 'https://snowtrace.io',
  },
  monad: {
    name: 'Monad',
    chain: monad,
    tokens: MONAD_TOKENS,
    nativeSymbol: 'MON',
    gasReserve: '50000000000000000',
    // https://docs.monad.xyz/developer-essentials/reserve-balance. It reverts always for an
    // EIP-7702-delegated account, and for others that sent within the last 3 blocks.
    spendReserve: {
      units: '10000000000000000000',
      note: 'This would leave under 10 MON in your wallet. Monad holds a 10 MON reserve on each account, so this swap may fail because of it, and the gas would still be spent.',
      reverted:
        'The likely cause is Monad’s 10 MON reserve, which can stop a spend that leaves an account under 10 MON.',
    },
    rpcEnv: 'MONAD_RPC_URL',
    explorer: 'https://monadvision.com',
  },
}

export function evmExplorerUrl(chain: EvmChain, hash: string): string {
  return `${EVM_CHAINS[chain].explorer}/tx/${hash}`
}
