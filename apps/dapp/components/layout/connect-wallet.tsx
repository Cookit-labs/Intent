'use client'

import { ConnectButton } from '@rainbow-me/rainbowkit'
import { Button } from '@intent/ui'
import { Wallet } from 'lucide-react'

import { useChain } from '../../providers/chain-provider'
import { useWallet } from '../../hooks/use-wallet'
import { StellarWalletMenu } from './stellar-wallet-menu'

/**
 * Connect control for the active chain.
 *
 * RainbowKit only knows about EVM wallets, so it cannot render Freighter — the
 * Stellar side needs its own button rather than a configuration of the same one.
 */
export function ConnectWallet(): JSX.Element {
  const { descriptor } = useChain()

  if (descriptor.family === 'evm') {
    return (
      <ConnectButton
        accountStatus={{ smallScreen: 'avatar', largeScreen: 'full' }}
        chainStatus="icon"
        showBalance={{ smallScreen: false, largeScreen: true }}
      />
    )
  }

  return <StellarConnect />
}

function StellarConnect(): JSX.Element {
  const { address, isConnected, isConnecting, balance, balanceSymbol, error, connect, disconnect } =
    useWallet()

  if (isConnected && address !== undefined) {
    return (
      <StellarWalletMenu
        address={address}
        balance={balance}
        balanceSymbol={balanceSymbol}
        onDisconnect={disconnect}
      />
    )
  }

  return (
    <div className="flex items-center gap-2">
      {error !== undefined ? (
        <span
          className="text-warning hidden max-w-[16rem] truncate text-xs sm:inline"
          title={error}
        >
          {error}
        </span>
      ) : null}
      <Button size="sm" onClick={connect} disabled={isConnecting} className="gap-1.5">
        <Wallet className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
        {isConnecting ? 'Connecting…' : 'Connect wallet'}
      </Button>
    </div>
  )
}
