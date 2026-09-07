'use client'

import { Badge, Button } from '@intent/ui'

import { useChain } from '../../providers/chain-provider'
import { useWallet } from '../../hooks/use-wallet'

/** Where each chain's test funds come from. Arc uses Circle's faucet; Stellar's friendbot is called from the app. */
const FAUCET_LABEL: Record<string, string> = {
  arc: 'Get testnet USDC',
  stellar: 'Fund with friendbot',
}

const ARC_FAUCET_URL = 'https://faucet.circle.com'

/**
 * What network the user is actually on, rather than what we hope they are on.
 *
 * Everything here is derived from the connection and the active chain, so the
 * badge cannot claim a network the wallet is not on.
 */
export function NetworkStatus(): JSX.Element {
  const { slug, descriptor, adapter } = useChain()
  const { isConnected, isWrongNetwork, needsFunding, switchNetwork, isSwitching, address } =
    useWallet()

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
          onClick={switchNetwork}
          disabled={isSwitching}
          className="h-6 px-2 text-xs"
        >
          {isSwitching ? 'Switching…' : `Switch to ${descriptor.name}`}
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
        {descriptor.networkLabel}
      </Badge>

      {needsFunding ? (
        slug === 'stellar' ? (
          <FriendbotButton address={address} />
        ) : (
          <a
            href={ARC_FAUCET_URL}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2"
          >
            {FAUCET_LABEL[slug]}
          </a>
        )
      ) : (
        <span className="text-muted-foreground hidden text-xs sm:inline">
          pre-mainnet · rails may change
        </span>
      )}

      {isConnected && address !== undefined ? (
        <a
          href={adapter.accountUrl(address)}
          target="_blank"
          rel="noreferrer"
          className="text-muted-foreground hover:text-foreground hidden text-xs underline underline-offset-2 sm:inline"
        >
          Explorer
        </a>
      ) : null}
    </div>
  )
}

/**
 * Stellar accounts do not exist on-chain until funded, so the faucet is part of
 * onboarding rather than an optional top-up. Friendbot is a plain GET, so the
 * app can call it directly instead of sending the user to another site.
 */
function FriendbotButton({ address }: { address: string | undefined }): JSX.Element | null {
  if (address === undefined) return null

  return (
    <Button
      variant="outline"
      size="sm"
      className="h-6 px-2 text-xs"
      onClick={() => {
        void (async () => {
          const { fundWithFriendbot } = await import('../../lib/stellar-account')
          await fundWithFriendbot(address)
        })()
      }}
    >
      Fund with friendbot
    </Button>
  )
}
