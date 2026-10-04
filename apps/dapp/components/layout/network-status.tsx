'use client'

import { activeNetwork, isMainnet, stellarNetwork } from '@intent/config'
import { Badge, Button } from '@intent/ui'

import { otherStellarNetwork } from '../../lib/other-stellar-network'
import { mismatchLabel } from '../../lib/wallet-network'
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
export function NetworkStatus({
  tradeCapUsd,
}: {
  /** The per-trade cap on mainnet, when there is one. Decided on the server. */
  tradeCapUsd?: number | undefined
}): JSX.Element {
  const { slug, descriptor, adapter } = useChain()
  const {
    isConnected,
    isWrongNetwork,
    needsFunding,
    switchNetwork,
    isSwitching,
    address,
    walletNetwork,
  } = useWallet()

  if (isWrongNetwork) {
    // Both Stellar networks are real places to be. The wallet is on one and
    // this deployment serves the other, so say where each is and offer the
    // way to the one the wallet is on, rather than calling its network wrong.
    const other =
      slug === 'stellar' && walletNetwork !== undefined && walletNetwork !== activeNetwork()
        ? otherStellarNetwork(
            activeNetwork(),
            process.env.NEXT_PUBLIC_STELLAR_OTHER_NETWORK_URL,
            '/stellar/intents'
          )
        : undefined
    return (
      <div className="flex items-center gap-2">
        <Badge variant="outline" className="border-warning/40 text-warning">
          <span className="bg-warning mr-1 inline-block h-1.5 w-1.5 rounded-full" />
          {slug === 'stellar' ? mismatchLabel(walletNetwork) : 'Wrong network'}
        </Badge>
        {other?.href !== undefined ? (
          <a
            href={other.href}
            className="border-border hover:bg-muted/60 inline-flex h-6 items-center rounded-md border px-2 text-xs transition-colors"
          >
            Open {other.label}
          </a>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          onClick={switchNetwork}
          disabled={isSwitching}
          className="h-6 px-2 text-xs"
        >
          {isSwitching ? 'Switching…' : `Switch wallet to ${descriptor.networkLabel}`}
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
          // No faucet on mainnet: the account exists once someone pays its
          // reserve, and a button that pretends otherwise would only fail.
          stellarNetwork.friendbotUrl !== undefined ? (
            <FriendbotButton address={address} />
          ) : (
            <span className="text-muted-foreground text-xs">Send XLM to activate</span>
          )
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
      ) : isMainnet() ? (
        tradeCapUsd !== undefined && slug === 'stellar' ? (
          <span className="text-muted-foreground hidden text-xs sm:inline">
            Trades up to ${tradeCapUsd}
          </span>
        ) : null
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
