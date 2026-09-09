'use client'

import { STELLAR_USDC } from '@intent/config'
import { Badge, Button, Card, Skeleton } from '@intent/ui'
import { useQuery } from '@tanstack/react-query'

import { fetchStellarBalances } from '../../lib/stellar-account'
import { useChain } from '../../providers/chain-provider'
import { useWallet } from '../../hooks/use-wallet'
import { TokenIcon } from '../ui/token-icon'

/**
 * Live wallet balances for the active chain.
 *
 * This is the screen where the two chains genuinely diverge, so it is the one
 * place a chain check is warranted: on Arc, USDC is the native gas token and a
 * connected account can always hold it. On Stellar, USDC is an issued asset
 * that requires an explicit trustline first — an account without one cannot
 * receive USDC at all, which is a state Arc has no equivalent of.
 */
export function BalanceCard(): JSX.Element {
  const { descriptor } = useChain()
  const { address, isConnected, balance, balanceSymbol, isWrongNetwork } = useWallet()

  if (!isConnected) {
    return (
      <Card className="flex flex-col gap-2 p-5">
        <span className="text-muted-foreground text-sm">Native balance</span>
        <span className="text-muted-foreground text-sm">
          Connect a wallet to see your {descriptor.name} balance.
        </span>
      </Card>
    )
  }

  if (isWrongNetwork) {
    return (
      <Card className="flex flex-col gap-2 p-5">
        <span className="text-muted-foreground text-sm">Native balance</span>
        <span className="text-warning text-sm">
          Wallet is on a different network than {descriptor.networkLabel}.
        </span>
      </Card>
    )
  }

  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground text-sm">Native balance</span>
        <Badge variant="outline">{descriptor.networkLabel}</Badge>
      </div>

      {balance === undefined ? (
        <Skeleton className="h-8 w-40" />
      ) : (
        <span className="flex items-center gap-2 font-mono text-2xl">
          <TokenIcon symbol={balanceSymbol} size={26} />
          {Number(balance).toLocaleString(undefined, { maximumFractionDigits: 4 })}{' '}
          <span className="text-muted-foreground text-base">{balanceSymbol}</span>
        </span>
      )}

      <p className="text-muted-foreground text-xs">
        {descriptor.family === 'stellar'
          ? 'XLM pays fees and the account reserve. USDC is a separate issued asset.'
          : 'On Arc, USDC is the native gas token.'}
      </p>

      {descriptor.family === 'stellar' && address !== undefined ? (
        <StellarUsdcRow address={address} />
      ) : null}
    </Card>
  )
}

function StellarUsdcRow({ address }: { address: string }): JSX.Element {
  const { data, isLoading } = useQuery({
    queryKey: ['stellar-balances', address],
    queryFn: () => fetchStellarBalances(address),
    refetchInterval: 15_000,
  })

  if (isLoading) return <Skeleton className="h-10 w-full" />

  if (data === undefined || !data.exists) {
    return (
      <p className="text-muted-foreground border-border border-t pt-3 text-xs">
        Account not funded yet — fund it to activate on-chain.
      </p>
    )
  }

  if (!data.hasUsdcTrustline) {
    return (
      <div className="border-border flex flex-col gap-2 border-t pt-3">
        <span className="text-muted-foreground text-xs">
          No USDC trustline. Stellar requires a trustline to the issuer before an account can hold
          USDC.
        </span>
        <Button
          variant="outline"
          size="sm"
          className="w-fit text-xs"
          onClick={() => {
            window.open(
              `https://stellar.expert/explorer/testnet/asset/${STELLAR_USDC.code}-${STELLAR_USDC.issuer}`,
              '_blank',
              'noopener,noreferrer'
            )
          }}
        >
          View USDC asset
        </Button>
      </div>
    )
  }

  return (
    <div className="border-border flex items-center justify-between border-t pt-3">
      <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <TokenIcon symbol="USDC" size={16} />
        USDC
      </span>
      <span className="font-mono text-sm">
        {Number(data.usdc ?? '0').toLocaleString(undefined, { maximumFractionDigits: 2 })}
      </span>
    </div>
  )
}
