'use client'

import { useAccount, useBalance, useChainId, useSwitchChain } from 'wagmi'

import { arcTestnet } from '../lib/wagmi.config'

export interface WalletState {
  address: `0x${string}` | undefined
  isConnected: boolean
  isConnecting: boolean
  /** True when connected to something other than Arc. */
  isWrongNetwork: boolean
  /** Native USDC balance, formatted. Undefined until it loads. */
  balance: string | undefined
  /** True when connected, on Arc, and holding nothing — they need the faucet. */
  needsFunding: boolean
  switchToArc: () => void
  isSwitching: boolean
}

/**
 * Wallet state for the header and anything gating on connection.
 *
 * Balance is the *native* USDC view (18 decimals), which is what the wallet
 * shows. Reading USDC through its ERC-20 interface gives 6 decimals for the
 * same balance — see `USDC_ERC20_DECIMALS` in `@intent/config`.
 */
export function useWallet(): WalletState {
  const { address, isConnected, isConnecting, isReconnecting } = useAccount()
  const chainId = useChainId()
  const { switchChain, isPending: isSwitching } = useSwitchChain()

  const isWrongNetwork = isConnected && chainId !== arcTestnet.id

  const { data: balanceData } = useBalance({
    address,
    chainId: arcTestnet.id,
    query: { enabled: isConnected && !isWrongNetwork },
  })

  const balance = balanceData?.formatted

  return {
    address,
    isConnected,
    isConnecting: isConnecting || isReconnecting,
    isWrongNetwork,
    balance,
    // Compared against BigInt(0) rather than a 0n literal: the TS target
    // predates BigInt literal syntax.
    needsFunding:
      isConnected &&
      !isWrongNetwork &&
      balanceData !== undefined &&
      balanceData.value === BigInt(0),
    switchToArc: () => switchChain({ chainId: arcTestnet.id }),
    isSwitching,
  }
}
