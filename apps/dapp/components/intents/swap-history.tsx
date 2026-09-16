'use client'

import { Card, cn } from '@intent/ui'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, ChevronDown, ExternalLink } from 'lucide-react'
import { useState } from 'react'

import { useWallet } from '../../hooks/use-wallet'
import { useChain } from '../../providers/chain-provider'
import { fetchSwapHistory } from '../../lib/swap/history'
import type { SwapKind, SwapRecord } from '../../lib/swap/history'
import { bundlesByTxHash, syncTurns, type BundleStep } from '../../lib/chat-history'
import { TokenIcon } from '../ui/token-icon'
import { SwapCircleIcon } from './intent-type-icon'

/**
 * Swaps this account has made, read from the ledger.
 *
 * Deliberately not backed by anything the app stores. A trade made on another
 * device, in another browser, or before this feature existed still belongs in
 * a user's history, and the network already has all of them.
 */

/**
 * A ledger row, plus what only the app can know about it.
 *
 * The chain records transactions, not instructions. It cannot say that a router
 * swap and a Blend supply were one request, because a Soroban transaction
 * carries no memo and the two are unrelated on-chain. That association lives in
 * the app's record of the conversation and is joined on here.
 */
interface HistoryRow extends SwapRecord {
  /** The other transactions this one was bundled with, when it was. */
  bundleSteps?: BundleStep[]
}

/** What each kind is called, in the user's terms. */
const KIND_LABELS: Record<SwapKind, string> = {
  swap: 'Swap',
  limit: 'Limit order',
  bundle: 'Bundled swap',
  pool: 'Liquidity',
}

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

  // The bundle labels come from the app's own record, which lives on the
  // server. Pulled before the ledger rows are rendered so a cleared browser
  // still names a bundled intent as one rather than as a bare swap.
  useQuery({
    queryKey: ['turn-sync', slug, address],
    queryFn: () => syncTurns(slug),
    enabled: supported && isConnected && address !== undefined,
    staleTime: 30_000,
  })

  const { data, isLoading } = useQuery({
    queryKey: ['swap-history', slug, address],
    queryFn: () => fetchSwapHistory(address as string),
    enabled: supported && isConnected && address !== undefined,
    // Settled trades do not change, so this only needs to catch new ones.
    staleTime: 30_000,
    // A trade made moments ago in the Compose tab must be here when the user
    // switches to History. Without this the cached list is served untouched and
    // the newest trade appears to be missing.
    refetchOnMount: 'always',
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

  const ledger = data ?? []
  if (ledger.length === 0) {
    return <Card className="text-muted-foreground p-6 text-sm">No swaps yet for this account.</Card>
  }

  // Two sources, and the order between them matters.
  //
  // The app's own record is richer: it knows which agent won and what it
  // reasoned, none of which is on-chain. So it wins where it exists.
  //
  // The ledger is the fallback, and it is the one that survives. A cleared
  // browser loses the record but not the chain, and the reader can still see
  // that a swap was followed moments later by a supply of what it delivered —
  // which is what a bundled intent looks like from the outside.
  const bundles = bundlesByTxHash(slug)
  const swaps: HistoryRow[] = ledger.map((row) => {
    const recorded = bundles.get(row.txHash)
    if (recorded !== undefined) {
      // A bundle is what the person asked for, so it names the row even though
      // the ledger saw only a swap.
      return { ...row, kind: 'bundle' as const, bundleSteps: recorded.steps }
    }

    if (row.bundledWith !== undefined && row.bundledWith.length > 1) {
      return { ...row, bundleSteps: row.bundledWith }
    }

    return row
  })

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
function SwapRow({ swap }: { swap: HistoryRow }): JSX.Element {
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
        <SwapCircleIcon className="text-foreground h-7 w-7 shrink-0" />

        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            {/* Named, like the intent rows. Without a title these read as a
                different kind of thing entirely from the list beneath. */}
            <span className="text-sm font-semibold">{KIND_LABELS[swap.kind]}</span>
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
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={swap.explorerUrl}
              target="_blank"
              rel="noreferrer"
              className="border-border hover:bg-muted/60 inline-flex w-fit items-center gap-2 rounded-md border px-3 py-2 text-xs font-medium transition-colors"
            >
              View on Stellar Expert
              <ExternalLink className="h-3.5 w-3.5" />
            </a>

            {/* Where the position lives, as opposed to proof the transaction
                happened. An explorer shows a supply reached the ledger and
                nothing about the balance it created or the rate it earns. */}
            {(swap.bundleSteps ?? [])
              .filter((step) => step.positionUrl !== undefined)
              .map((step) => (
                <a
                  key={step.positionUrl}
                  href={step.positionUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="border-border hover:bg-muted/60 inline-flex w-fit items-center gap-2 rounded-md border px-3 py-2 text-xs font-medium transition-colors"
                >
                  View position on {step.venue ?? 'the protocol'}
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              ))}
          </div>

          {/* Every transaction in the bundle, so the supply is reachable from
              the swap's row rather than only from the conversation. */}
          {swap.bundleSteps !== undefined && swap.bundleSteps.length > 1 ? (
            <ol className="border-border text-muted-foreground flex flex-col gap-1 border-l pl-3 text-xs">
              {swap.bundleSteps.map((step, i) => (
                <li
                  key={`${step.hash ?? 'step'}-${i}`}
                  className="flex flex-wrap items-center gap-2"
                >
                  <span>
                    {i + 1}. {step.label}
                  </span>
                  {step.explorerUrl !== undefined && step.hash !== swap.txHash ? (
                    <a
                      href={step.explorerUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="hover:text-foreground underline underline-offset-2"
                    >
                      transaction
                    </a>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      ) : null}
    </Card>
  )
}
