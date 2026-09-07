'use client'

import { accountExplorerUrl, arcDescriptor } from '@intent/config'
import { useAccount, useBalance, useChainId, useConnect, useDisconnect, useSwitchChain } from 'wagmi'

import type { ChainAdapter, ChainWallet } from '../chain-adapter'
import { arcTestnet } from '../wagmi.config'

/**
 * Arc/EVM wallet, behind the shared adapter interface.
 *
 * Balance is the *native* USDC view (18 decimals), which is what the wallet
 * shows. Reading USDC through its ERC-20 interface gives 6 decimals for the
 * same balance — see `USDC_ERC20_DECIMALS` in `@intent/config`.
 */
function useArcWallet(): ChainWallet {
  const { address, isConnected, isConnecting, isReconnecting } = useAccount()
  const chainId = useChainId()
  const { switchChain, isPending: isSwitching } = useSwitchChain()
  const { connect, connectors, error: connectError } = useConnect()
  const { disconnect } = useDisconnect()

  const isWrongNetwork = isConnected && chainId !== arcTestnet.id

  const { data: balanceData } = useBalance({
    address,
    chainId: arcTestnet.id,
    query: { enabled: isConnected && !isWrongNetwork },
  })

  return {
    address,
    isConnected,
    isConnecting: isConnecting || isReconnecting,
    isWrongNetwork,
    balance: balanceData?.formatted,
    balanceSymbol: balanceData?.symbol ?? arcDescriptor.nativeCurrency.symbol,
    // Compared against BigInt(0) rather than a 0n literal: the TS target
    // predates BigInt literal syntax.
    needsFunding:
      isConnected &&
      !isWrongNetwork &&
      balanceData !== undefined &&
      balanceData.value === BigInt(0),
    // An injected connector is always registered, so the browser-extension
    // check happens at connect time rather than here.
    isWalletUnavailable: false,
    error: connectError?.message,
    connect: () => {
      const injected = connectors[0]
      if (injected) connect({ connector: injected })
    },
    disconnect: () => disconnect(),
    switchNetwork: () => switchChain({ chainId: arcTestnet.id }),
    isSwitching,
  }
}

export const arcAdapter: ChainAdapter = {
  descriptor: arcDescriptor,
  useWallet: useArcWallet,
  accountUrl: (address) => accountExplorerUrl('arc', address),
}
