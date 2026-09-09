'use client'

import { Card, cn } from '@intent/ui'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, ChevronDown, ExternalLink } from 'lucide-react'
import { useState } from 'react'

import { useWallet } from '../../hooks/use-wallet'
import { useChain } from '../../providers/chain-provider'
import { fetchSwapHistory } from '../../lib/swap/history'
import type { SwapRecord } from '../../lib/swap/history'
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
        <SwapRow key={s.txHash} swap={s} />
      ))}
    </div>
  )
}

/**
 * One settled swap, expandable in place.
 *
 * Matches the intent rows above it: the summary is enough to scan, and the
 * detail — route, timing, the explorer link — opens under the row rather than
 * on a page of its own.
 */
function SwapRow({ swap }: { swap: SwapRecord }): JSX.Element {
  const [expanded, setExpanded] = useState(false)

  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="hover:bg-muted/40 flex w-full items-center gap-4 p-4 text-left transition-colors"
      >
        {/* Leading mark, so an on-chain swap row is scannable the same way an
            intent row is — the type is readable before the numbers are. */}
        <SwapCircleIcon className="h-7 w-7 shrink-0 text-black" />

        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            {/* Named, like the intent rows. Without a title these read as a
                different kind of thing entirely from the list beneath. */}
            <span className="text-sm font-semibold">Swap</span>
            <span className="text-muted-foreground text-xs">{when(swap.settledAt)}</span>
          </div>

          <div className="mt-1.5 flex items-center gap-2 text-sm tabular-nums">
            <span className="flex items-center gap-1.5 font-medium">
              <TokenIcon symbol={swap.sentAsset} size={18} />
              {amount(swap.sentAmount)} {swap.sentAsset}
            </span>
            <ArrowRight className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
            <span className="text-muted-foreground flex min-w-0 items-center gap-1.5">
              <TokenIcon symbol={swap.receivedAsset} size={18} />
              <span className="truncate">
                {amount(swap.receivedAmount)} {swap.receivedAsset}
              </span>
            </span>
          </div>
        </div>

        <ChevronDown
          className={cn(
            'text-muted-foreground h-4 w-4 shrink-0 transition-transform',
            expanded && 'rotate-180'
          )}
          aria-hidden
        />
      </button>

      {expanded ? (
        <div className="border-border flex flex-col gap-4 border-t px-4 pb-4 pt-4">
          <div className="grid grid-cols-2 gap-4 text-sm tabular-nums sm:grid-cols-4">
            <div>
              <p className="text-muted-foreground text-xs">Sent</p>
              <p className="text-foreground">
                {amount(swap.sentAmount)} {swap.sentAsset}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs">Received</p>
              <p className="text-foreground">
                {amount(swap.receivedAmount)} {swap.receivedAsset}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs">Route</p>
              <p className="text-foreground">
                {swap.hops === 0 ? 'direct' : `${swap.hops} hop${swap.hops === 1 ? '' : 's'}`}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs">Settled</p>
              <p className="text-foreground">
                {new Date(swap.settledAt).toLocaleString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </p>
            </div>
          </div>

          <p className="text-muted-foreground break-all font-mono text-xs">{swap.txHash}</p>

          {/* Every row is checkable: the ledger is the record, and this is the
              link to it. */}
          <a
            href={swap.explorerUrl}
            target="_blank"
            rel="noreferrer"
            className="border-border hover:bg-muted/60 inline-flex w-fit items-center gap-2 rounded-md border px-3 py-2 text-xs font-medium transition-colors"
          >
            View on Stellar Expert
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      ) : null}
    </Card>
  )
}
