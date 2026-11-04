import { connect, getAccount, getConnectors, switchChain } from 'wagmi/actions'

import { wagmiConfig } from '../wagmi.config'
import type { WalletConnector } from './connector'
import { evmWalletOptions } from './evm-options'

/** An EVM chain's connector. wagmi holds the connection, shared by every EVM chain. */
export function createEvmConnector(chainId: number): WalletConnector {
  return {
    isConnected: () => getAccount(wagmiConfig).isConnected,
    listWallets: async () => evmWalletOptions(getConnectors(wagmiConfig)),
    connect: async (walletId) => {
      const connector = getConnectors(wagmiConfig).find((c) => c.id === walletId)
      if (connector === undefined) throw new Error('That wallet is not available in this browser.')
      await connect(wagmiConfig, { connector })
      // Asked for, not required: a wallet that refuses is shown the switch prompt in the app.
      await switchChain(wagmiConfig, { chainId }).catch(() => undefined)
    },
  }
}
