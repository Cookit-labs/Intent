'use client'

import { type ReactNode } from 'react'

import { ChainSwitcher } from './chain-switcher'
import { ConnectWallet } from './connect-wallet'
import { NetworkStatus } from './network-status'
import { ThemeToggle } from './theme-toggle'

/**
 * The top bar.
 *
 * Four things compete for a phone's width here, and the network status is the
 * one that gives way: "pre-mainnet · rails may change" is context rather than a
 * control, and losing it costs a mobile user nothing they cannot get elsewhere.
 * The chain switcher, the theme toggle and the wallet all stay, because each is
 * something you press.
 */
export function Header({
  menuButton,
}: {
  /** The drawer trigger, supplied by the shell that owns the drawer's state. */
  menuButton?: ReactNode
  /** Unused here; the shell passes the handler through `menuButton`. */
  onOpenMenu?: () => void
}): JSX.Element {
  return (
    <header className="border-border bg-surface-base/80 flex h-16 shrink-0 items-center justify-between gap-2 border-b px-4 backdrop-blur sm:gap-4 sm:px-6">
      <div className="flex min-w-0 items-center gap-2 sm:gap-3">
        {menuButton}
        <ChainSwitcher />
        {/* Hidden below `md`: it is the only element here that is purely
            informational, so it is the right one to drop when space runs out. */}
        <div className="hidden md:block">
          <NetworkStatus />
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <ThemeToggle />
        <ConnectWallet />
      </div>
    </header>
  )
}
