'use client'

import { ConnectButton } from '@rainbow-me/rainbowkit'

import { NetworkStatus } from './network-status'

export function Header(): JSX.Element {
  return (
    <header className="border-border bg-surface-base/80 flex h-16 shrink-0 items-center justify-between border-b px-6 backdrop-blur">
      <NetworkStatus />

      <ConnectButton
        accountStatus={{ smallScreen: 'avatar', largeScreen: 'full' }}
        chainStatus="icon"
        showBalance={{ smallScreen: false, largeScreen: true }}
      />
    </header>
  )
}
