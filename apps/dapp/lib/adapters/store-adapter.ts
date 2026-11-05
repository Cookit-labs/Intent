'use client'

import { accountExplorerUrl } from '@intent/config'
import type { ChainDescriptor, ChainSlug } from '@intent/types'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useSyncExternalStore } from 'react'

import type { ChainAdapter, ChainWallet } from '../chain-adapter'
import { fetchNativeBalance } from '../wallet/native-balance'
import type { StoreConnector } from '../wallet/store-connector'

/** The adapter for a chain whose wallet lives in a `WalletStore`: Solana, Sui and NEAR. */
export function storeAdapter(
  descriptor: ChainDescriptor & { slug: Extract<ChainSlug, 'solana' | 'sui' | 'near'> },
  connector: StoreConnector
): ChainAdapter {
  const { store } = connector
  const { slug, nativeCurrency } = descriptor

  function useStoreWallet(): ChainWallet {
    const state = useSyncExternalStore(store.subscribe, store.get, store.getServer)

    useEffect(() => {
      void connector.restore()
    }, [])

    const { address } = state
    const { data: balance } = useQuery({
      queryKey: ['native-balance', slug, address],
      queryFn: () => fetchNativeBalance(slug, address as string, nativeCurrency.decimals),
      enabled: address !== undefined,
      refetchInterval: 15_000,
    })

    return {
      address,
      isConnected: address !== undefined,
      isConnecting: false,
      isRestoring: state.isRestoring,
      isWrongNetwork: false,
      balance,
      balanceSymbol: nativeCurrency.symbol,
      needsFunding: false,
      isWalletUnavailable: false,
      error: undefined,
      walletName: state.walletName,
      walletIcon: state.walletIcon,
      // The connect page is the only way in, and it talks to the connector directly.
      connect: () => undefined,
      disconnect: () => {
        void connector.disconnect()
      },
      switchNetwork: () => undefined,
      isSwitching: false,
    }
  }

  return {
    descriptor,
    useWallet: useStoreWallet,
    signPrepared: connector.signPrepared,
    accountUrl: (address) => accountExplorerUrl(slug, address),
  }
}
