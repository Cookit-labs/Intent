'use client'

import { Card } from '@intent/ui'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, ExternalLink } from 'lucide-react'

import { useWallet } from '../../hooks/use-wallet'
import { useChain } from '../../providers/chain-provider'
import { fetchSwapHistory } from '../../lib/swap/history'
import { TokenIcon } from '../ui/token-icon'
import { SwapCircleIcon } from './intent-type-icon'

/**
 * Swaps this account has made, read from the ledger.
 *
 * Deliberately not backed by anything the app stores. A trade made on another
 * device, in another browser, or before this feature existed still belongs in
 * a user's history, and the network already has all of them.
 */

function amount(value: string): string {
  const n = Number(value)
  return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 4 }) : value
}

function when(iso: string): string {
  const then = new Date(iso).getTime()
  const minutes = Math.round((Date.now() - then) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function SwapHistory(): JSX.Element | null {
  const { address, isConnected } = useWallet()
  const { slug, descriptor } = useChain()
  // This reads Stellar's ledger specifically. Running it while Arc is active
  // would show Stellar trades under an Arc wallet, which is exactly the
  // cross-chain bleed the chain segment exists to prevent.
  const supported = slug === 'stellar'

  const { data, isLoading } = useQuery({
    queryKey: ['swap-history', slug, address],
    queryFn: () => fetchSwapHistory(address as string),
    enabled: supported && isConnected && address !== undefined,
    // Settled trades do not change, so this only needs to catch new ones.
    staleTime: 30_000,
  })

  if (!supported) {
    return (
      <Card className="text-muted-foreground p-6 text-sm">
        On-chain swap history is not available on {descriptor.name} yet.
      </Card>
    )
  }

  if (!isConnected) {
    return (
      <Card className="text-muted-foreground p-6 text-sm">
        Connect a wallet to see its swap history.
      </Card>
    )
  }

  if (isLoading) {
    return <Card className="bg-muted/40 h-20 animate-pulse" />
  }

  const swaps = data ?? []
  if (swaps.length === 0) {
    return <Card className="text-muted-foreground p-6 text-sm">No swaps yet for this account.</Card>
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="text-muted-foreground flex items-baseline justify-between text-xs">
        {/* Named by chain: history is per-network, and saying so removes any
            doubt about which ledger these came from. */}
        <span>On-chain swaps · {descriptor.name}</span>
        <span>{swaps.length}</span>
      </div>

      {swaps.map((s) => (
        <Card key={s.txHash} className="flex items-center gap-4 p-4">
          {/* Leading mark, so an on-chain swap row is scannable the same way an
              intent row is — the type is readable before the numbers are. */}
          <SwapCircleIcon className="h-7 w-7 shrink-0 text-black" />

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-sm tabular-nums">
              <span className="flex items-center gap-1.5 font-medium">
                <TokenIcon symbol={s.sentAsset} size={18} />
                {amount(s.sentAmount)} {s.sentAsset}
              </span>
              <ArrowRight className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
              <span className="text-muted-foreground flex items-center gap-1.5">
                <TokenIcon symbol={s.receivedAsset} size={18} />
                {amount(s.receivedAmount)} {s.receivedAsset}
              </span>
            </div>
            <div className="text-muted-foreground mt-1 flex items-center gap-3 text-xs">
              <span>{when(s.settledAt)}</span>
              <span>{s.hops === 0 ? 'direct' : `${s.hops} hop${s.hops === 1 ? '' : 's'}`}</span>
            </div>
          </div>

          {/* Every row is checkable: the ledger is the record, and this is the
              link to it. */}
          <a
            href={s.explorerUrl}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground hover:text-foreground inline-flex shrink-0 items-center gap-1.5 text-xs underline underline-offset-2"
          >
            View
            <ExternalLink className="h-3 w-3" />
          </a>
        </Card>
      ))}
    </div>
  )
}
