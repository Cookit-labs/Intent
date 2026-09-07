'use client'

import { ChainSwitcher } from './chain-switcher'
import { ConnectWallet } from './connect-wallet'
import { NetworkStatus } from './network-status'

export function Header(): JSX.Element {
  return (
    <header className="border-border bg-surface-base/80 flex h-16 shrink-0 items-center justify-between gap-4 border-b px-6 backdrop-blur">
      <div className="flex items-center gap-3">
        <ChainSwitcher />
        <NetworkStatus />
      </div>

      <ConnectWallet />
    </header>
  )
}
