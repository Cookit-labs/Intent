'use client'

import { useChain } from '../../providers/chain-provider'
import { useWallet } from '../../hooks/use-wallet'
import { forgetChain } from '../../lib/wallet/chain-cookie'
import { ChainWalletMenu } from './chain-wallet-menu'
import { StellarWalletMenu } from './stellar-wallet-menu'

/**
 * The connected wallet in the header. Connecting happens on the connect page,
 * which is the only way into the app, so a disconnected wallet has nothing to
 * show here. Disconnecting goes back to that page.
 */
export function ConnectWallet(): JSX.Element | null {
  const { slug } = useChain()
  const { address, isConnected, balance, balanceSymbol, walletIcon, disconnect } = useWallet()

  function leave(): void {
    forgetChain()
    disconnect()
  }

  if (!isConnected || address === undefined) return null

  if (slug === 'stellar') {
    return (
      <StellarWalletMenu
        address={address}
        balance={balance}
        balanceSymbol={balanceSymbol}
        walletIcon={walletIcon}
        onDisconnect={leave}
      />
    )
  }

  return <ChainWalletMenu onDisconnect={leave} />
}
