'use client'

import { ConnectButton } from '@rainbow-me/rainbowkit'
import { Button } from '@intent/ui'

import { useChain } from '../../providers/chain-provider'
import { useWallet } from '../../hooks/use-wallet'

function shortenStellar(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`
}

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
      <div className="flex items-center gap-2">
        {balance !== undefined ? (
          <span className="text-muted-foreground hidden font-mono text-xs sm:inline">
            {Number(balance).toLocaleString(undefined, { maximumFractionDigits: 2 })} {balanceSymbol}
          </span>
        ) : null}
        <span className="border-border rounded-md border px-2 py-1 font-mono text-xs">
          {shortenStellar(address)}
        </span>
        <Button variant="outline" size="sm" onClick={disconnect} className="text-xs">
          Disconnect
        </Button>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2">
      {error !== undefined ? (
        <span className="text-warning hidden max-w-[16rem] truncate text-xs sm:inline" title={error}>
          {error}
        </span>
      ) : null}
      <Button size="sm" onClick={connect} disabled={isConnecting}>
        {isConnecting ? 'Connecting…' : 'Connect wallet'}
      </Button>
    </div>
  )
}
