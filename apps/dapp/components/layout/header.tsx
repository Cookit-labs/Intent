'use client'

import { ConnectButton } from '@rainbow-me/rainbowkit'
import { Badge } from '@intent/ui'

export function Header(): JSX.Element {
  return (
    <header className="border-border bg-surface-base/80 flex h-16 shrink-0 items-center justify-between border-b px-6 backdrop-blur">
      <div className="flex items-center gap-2">
        <Badge variant="outline">
          <span className="bg-foreground mr-1 inline-block h-1.5 w-1.5 rounded-full" />
          Arc testnet
        </Badge>
        <span className="text-muted-foreground hidden text-xs sm:inline">
          pre-mainnet · rails may change
        </span>
      </div>

      <ConnectButton
        accountStatus={{ smallScreen: 'avatar', largeScreen: 'full' }}
        chainStatus="icon"
        showBalance={{ smallScreen: false, largeScreen: true }}
      />
    </header>
  )
}
