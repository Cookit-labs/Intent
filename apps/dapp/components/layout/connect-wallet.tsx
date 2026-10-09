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
      <ConnectButton.Custom>
        {({ account, chain, mounted, authenticationStatus, openConnectModal }) => {
          const ready = mounted && authenticationStatus !== 'loading'
          const connected = ready && account !== undefined && chain !== undefined
          // Not connected: the same button the Stellar side shows, so the
          // control does not change shape with the chain. Connected, and
          // while it is not yet known, RainbowKit's own control takes over.
          if (ready && !connected) return <ConnectButtonView onClick={openConnectModal} />
          return (
            <div
              aria-hidden={!ready}
              className={ready ? undefined : 'pointer-events-none opacity-0'}
            >
              <ConnectButton
                accountStatus={{ smallScreen: 'avatar', largeScreen: 'full' }}
                chainStatus="icon"
                showBalance={{ smallScreen: false, largeScreen: true }}
              />
            </div>
          )
        }}
      </ConnectButton.Custom>
    )
  }

  return <StellarConnect />
}

function StellarConnect(): JSX.Element {
  const {
    address,
    isConnected,
    isConnecting,
    balance,
    balanceSymbol,
    walletIcon,
    error,
    connect,
    disconnect,
  } = useWallet()

  if (isConnected && address !== undefined) {
    return (
      <StellarWalletMenu
        address={address}
        balance={balance}
        balanceSymbol={balanceSymbol}
        walletIcon={walletIcon}
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
      <ConnectButtonView onClick={connect} busy={isConnecting} />
    </div>
  )
}

/** The one disconnected button, whatever the chain. */
function ConnectButtonView({
  onClick,
  busy = false,
}: {
  onClick: () => void
  busy?: boolean
}): JSX.Element {
  return (
    <Button size="sm" onClick={onClick} disabled={busy} className="gap-1.5">
      <Wallet className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
      {busy ? 'Connecting…' : 'Connect wallet'}
    </Button>
  )
}
