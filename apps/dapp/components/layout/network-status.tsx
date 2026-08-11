'use client'

import { Badge, Button } from '@intent/ui'

import { useWallet } from '../../hooks/use-wallet'

const FAUCET_URL = 'https://faucet.circle.com'

/**
 * What network the user is actually on, rather than what we hope they are on.
 *
 * The previous version of this badge said "Arc testnet" unconditionally, while
 * the app was configured for mainnet and sepolia — a claim the UI could not
 * back up. Everything here is derived from the connection.
 */
export function NetworkStatus(): JSX.Element {
  const { isConnected, isWrongNetwork, needsFunding, switchToArc, isSwitching } = useWallet()

  if (isWrongNetwork) {
    return (
      <div className="flex items-center gap-2">
        <Badge variant="outline" className="border-warning/40 text-warning">
          <span className="bg-warning mr-1 inline-block h-1.5 w-1.5 rounded-full" />
          Wrong network
        </Badge>
        <Button
          variant="outline"
          size="sm"
          onClick={switchToArc}
          disabled={isSwitching}
          className="h-6 px-2 text-xs"
        >
          {isSwitching ? 'Switching…' : 'Switch to Arc'}
        </Button>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <Badge variant="outline">
        <span
          className={`mr-1 inline-block h-1.5 w-1.5 rounded-full ${
            isConnected ? 'bg-success' : 'bg-muted-foreground'
          }`}
        />
        Arc testnet
      </Badge>

      {needsFunding ? (
        <a
          href={FAUCET_URL}
          target="_blank"
          rel="noreferrer"
          className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2"
        >
          Get testnet USDC
        </a>
      ) : (
        <span className="text-muted-foreground hidden text-xs sm:inline">
          pre-mainnet · rails may change
        </span>
      )}
    </div>
  )
}
