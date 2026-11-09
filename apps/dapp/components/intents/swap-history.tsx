'use client'

import { Card, cn } from '@intent/ui'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, ChevronDown, ExternalLink } from 'lucide-react'
import { useState } from 'react'

import { useWallet } from '../../hooks/use-wallet'
import { useWalletHistory } from '../../hooks/use-wallet-history'
import { useChain } from '../../providers/chain-provider'
import {
  agentHistoryByHash,
  fetchAgentHistory,
  type AgentHistoryEntry,
} from '../../lib/agents/history'
import type { SwapKind, SwapRecord } from '../../lib/swap/history'
import { askedByHash } from '../../lib/chains/activity'
import { bundlesByTxHash, loadTurns, type BundleStep } from '../../lib/chat-history'
import { TokenIcon } from '../ui/token-icon'
import { SwapCircleIcon } from './intent-type-icon'

/**
 * What this account has done on the page's chain.
 *
 * Stellar's ledger comes first where there is one, so a trade made on another
 * device or before this feature existed still belongs here. Every chain also has
 * the app's own record of what it submitted. See `useWalletHistory`.
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
  /** Which agent won the race this swap came from, and why, when known. */
  agentHistory?: AgentHistoryEntry
  /** What was typed for it, for a row the record can't otherwise name. */
  asked?: string
}

/** What each kind is called, in the user's terms. */
const KIND_LABELS: Record<SwapKind, string> = {
  swap: 'Swap',
  limit: 'Limit order',
  bundle: 'Bundled swap',
  pool: 'Liquidity',
  cashout: 'Cash-out',
  other: 'Transaction',
}

function amount(value: string): string {
  const n = Number(value)
  return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 4 }) : value
}

/** What a cash-out paid, in its own currency. */
function paidOut(value: string, currency: string): string {
  const figure = Number(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return currency === 'NGN' ? `₦${figure}` : `${figure} ${currency}`
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

function dayLabel(iso: string): string {
  const date = new Date(iso)
  const now = new Date()
  if (dayKey(date) === dayKey(now)) return 'Today'
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (dayKey(date) === dayKey(yesterday)) return 'Yesterday'
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  })
}

function groupByDay(rows: HistoryRow[]): { label: string; rows: HistoryRow[] }[] {
  const groups = new Map<string, { label: string; rows: HistoryRow[] }>()
  for (const row of rows) {
    const key = dayKey(new Date(row.settledAt))
    const group = groups.get(key)
    if (group === undefined) groups.set(key, { label: dayLabel(row.settledAt), rows: [row] })
    else group.rows.push(row)
  }
  return [...groups.values()]
}

export function SwapHistory(): JSX.Element | null {
  const { address, isConnected } = useWallet()
  const { slug, descriptor } = useChain()
  const { supported, rows, loading, unread } = useWalletHistory()

  // The agent's own reasoning for the winning plan, when this swap came from
  // a race. A failed fetch leaves rows exactly as they were before this
  // existed: no detail, not an error.
  const { data: agentHistory } = useQuery({
    queryKey: ['agent-history', slug, address],
    queryFn: () => fetchAgentHistory(address as string),
    enabled: supported && isConnected && address !== undefined,
    staleTime: 30_000,
    refetchOnMount: 'always',
  })

  if (!supported) {
    return (
      <Card className="text-muted-foreground p-6 text-sm">
        Transaction history is not available on {descriptor.name} yet.
      </Card>
    )
  }

  if (!isConnected) {
    return (
      <Card className="text-muted-foreground p-6 text-sm">
        Connect a wallet to see its transactions.
      </Card>
    )
  }

  if (loading) {
    return <Card className="bg-muted/40 h-20 animate-pulse" />
  }

  const couldNotRead = unread ? (
    <Card className="text-muted-foreground p-4 text-sm">
      Could not read all of this wallet’s transactions, so this list may be missing some. It will
      try again shortly.
    </Card>
  ) : null

  if (rows.length === 0) {
    return (
      couldNotRead ?? (
        <Card className="text-muted-foreground p-6 text-sm">
          No transactions yet for this account on {descriptor.name}.
        </Card>
      )
    )
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
  const asked = askedByHash(loadTurns(slug))
  const agentHistoryByTxHash = agentHistoryByHash(agentHistory ?? [])
  const swaps: HistoryRow[] = rows.map((row) => {
    const agent = agentHistoryByTxHash.get(row.txHash)
    const typed = asked.get(row.txHash)
    const withAgent = {
      ...(agent !== undefined ? { agentHistory: agent } : {}),
      ...(typed !== undefined ? { asked: typed } : {}),
    }

    const recorded = bundles.get(row.txHash)
    if (recorded !== undefined) {
      // A bundle is what the person asked for, so it names the row even though
      // the ledger saw only a swap. A step the record names keeps its own name:
      // a deposit that followed a swap is still a deposit.
      return row.title !== undefined
        ? { ...row, bundleSteps: recorded.steps, ...withAgent }
        : { ...row, kind: 'bundle' as const, bundleSteps: recorded.steps, ...withAgent }
    }

    if (row.bundledWith !== undefined && row.bundledWith.length > 1) {
      return { ...row, bundleSteps: row.bundledWith, ...withAgent }
    }

    return { ...row, ...withAgent }
  })

  return (
    <div className="flex flex-col gap-3">
      <div className="text-muted-foreground flex items-baseline justify-between text-xs">
        {/* Named by chain: history is per-network, and saying so removes any
            doubt about which ledger these came from. */}
        <span>Transactions · {descriptor.name}</span>
        <span>{swaps.length}</span>
      </div>

      {groupByDay(swaps).map((group) => (
        <section key={group.label} className="flex flex-col gap-3">
          <h3 className="text-muted-foreground pt-2 text-xs font-medium">{group.label}</h3>
          {group.rows.map((s) => (
            <SwapRow key={s.txHash} swap={s} />
          ))}
        </section>
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
  const { slug } = useChain()
  const named = swap.title ?? (swap.kind === 'other' ? swap.asked : undefined)
  const hasSent = swap.sentAmount !== ''
  const hasReceived = swap.receivedAsset !== ''
  const received =
    swap.kind === 'cashout'
      ? paidOut(swap.receivedAmount, swap.receivedAsset)
      : swap.receivedAmount === ''
        ? swap.receivedAsset
        : `${amount(swap.receivedAmount)} ${swap.receivedAsset}`

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
            <span className="text-sm font-semibold">{named ?? KIND_LABELS[swap.kind]}</span>
            <span className="text-muted-foreground shrink-0 text-xs">
              {swap.unconfirmed === true ? 'unconfirmed · ' : ''}
              {time(swap.settledAt)}
            </span>
          </div>

          {hasSent ? (
            <div className="mt-1.5 flex items-center gap-2 text-sm tabular-nums">
              <span className="flex items-center gap-1.5 font-medium">
                <TokenIcon symbol={swap.sentAsset} size={18} />
                {amount(swap.sentAmount)} {swap.sentAsset}
              </span>
              {hasReceived ? (
                <>
                  <ArrowRight className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
                  <span className="text-muted-foreground flex min-w-0 items-center gap-1.5">
                    {swap.kind === 'cashout' ? null : (
                      <TokenIcon symbol={swap.receivedAsset} size={18} />
                    )}
                    <span className="truncate">{received}</span>
                  </span>
                </>
              ) : null}
            </div>
          ) : null}
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
            {hasSent ? (
              <div>
                <p className="text-muted-foreground text-xs">Sent</p>
                <p className="text-foreground">
                  {amount(swap.sentAmount)} {swap.sentAsset}
                </p>
              </div>
            ) : null}
            {hasReceived ? (
              <div>
                <p className="text-muted-foreground text-xs">Received</p>
                <p className="text-foreground">{received}</p>
              </div>
            ) : null}
            {/* A hop count is only read from Stellar's ledger, so nothing else has a route to show. */}
            {swap.payout !== undefined || swap.recorded !== true ? (
              <div>
                <p className="text-muted-foreground text-xs">
                  {swap.payout !== undefined ? 'Payout' : 'Route'}
                </p>
                <p className="text-foreground">
                  {swap.payout !== undefined
                    ? [
                        swap.payout.statusLabel,
                        `${swap.payout.bankName} ${swap.payout.accountMask}`.trim(),
                      ]
                        .filter((part) => part !== '')
                        .join(', ')
                    : swap.hops === 0
                      ? 'direct'
                      : `${swap.hops} hop${swap.hops === 1 ? '' : 's'}`}
                </p>
              </div>
            ) : null}
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

          {/* The one thing about this swap the ledger never recorded: which
              agent's plan this was, and what it said about it at the time.
              Absent, not a placeholder, for a swap made before this existed
              or outside a race entirely. */}
          {swap.agentHistory?.reasoning !== null && swap.agentHistory?.reasoning !== undefined ? (
            <div className="border-border bg-muted/30 rounded-md border p-3 text-xs">
              <p className="text-muted-foreground mb-1 font-medium">
                Why {swap.agentHistory.winningModel ?? swap.agentHistory.winner} picked this
              </p>
              <p className="text-foreground">{swap.agentHistory.reasoning}</p>
            </div>
          ) : null}

          {/* Every row is checkable: the ledger is the record, and this is the
              link to it. */}
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={swap.explorerUrl}
              target="_blank"
              rel="noreferrer"
              className="border-border hover:bg-muted/60 inline-flex w-fit items-center gap-2 rounded-md border px-3 py-2 text-xs font-medium transition-colors"
            >
              {slug === 'stellar' ? 'View on Stellar Expert' : 'View transaction'}
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
