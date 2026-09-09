'use client'

import type { Intent, IntentStatus } from '@intent/types'
import { Card, cn } from '@intent/ui'
import { ArrowRight, ChevronDown, ExternalLink } from 'lucide-react'
import { useState } from 'react'
import { stellarTestnet } from '@intent/config'

import { intentTypeLabel } from '../../lib/intent-format'
import { useCancelIntent } from '../../hooks/use-intent'
import { IntentTypeIcon } from './intent-type-icon'
import { TokenIcon } from '../ui/token-icon'

const PRICE_USD: Record<string, number> = {
  USDC: 1,
  USDT: 1,
  WETH: 3500,
  ETH: 3500,
  ARB: 1.25,
  WBTC: 95000,
}

const COMPETING_AGENTS = 4

interface StatusView {
  live: boolean
  failed: boolean
}

function statusView(status: IntentStatus): StatusView {
  if (status === 'failed' || status === 'cancelled') return { live: false, failed: true }
  return { live: status === 'competition' || status === 'executing', failed: false }
}

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

function statusLabel(intent: Intent): string {
  switch (intent.status) {
    case 'competition':
      return `Competing · ${COMPETING_AGENTS} agents`
    case 'executing':
      return 'Executing · live'
    case 'pending':
      // Nothing is escrowed and nothing has been spent — the order is simply
      // open. "Escrowed" claimed funds had been committed, which was never
      // true here.
      return intent.limitPriceUsd !== undefined ? 'Open · waiting for price' : 'Open'
    case 'settled':
      return `Settled · ${timeAgo(intent.createdAt)}`
    case 'failed':
      return `Failed · ${timeAgo(intent.createdAt)}`
    case 'cancelled':
      return `Cancelled · ${timeAgo(intent.createdAt)}`
  }
}

function usd(intent: Intent): string {
  const n = Number(intent.amountIn) * (PRICE_USD[intent.tokenIn] ?? 0)
  if (!Number.isFinite(n) || n <= 0) return '—'
  return `~$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}

export function IntentCard({ intent }: { intent: Intent }): JSX.Element {
  const view = statusView(intent.status)
  const cancelIntent = useCancelIntent()
  const [expanded, setExpanded] = useState(false)
  const open = intent.status === 'pending' && intent.limitPriceUsd !== undefined
  const explorerUrl =
    intent.settlementTxHash !== undefined && intent.settlementTxHash !== ''
      ? `${stellarTestnet.blockExplorerUrl}/tx/${intent.settlementTxHash}`
      : undefined

  return (
    <Card className="overflow-hidden">
      {/* The row expands in place rather than linking to a page of its own.
          Everything an intent has to say fits here, and navigating away to
          read four fields lost the list the user was working through. */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="hover:bg-muted/40 flex w-full gap-4 p-5 text-left transition-colors"
      >
        {/* The glyph carries the meaning on its own, so the boxed frame it
            used to sit in was only visual weight.

            Pure black on every row, cancelled included. Dimming it made the
            same icon look like two different marks depending on status, and
            the row's state is already carried by its label.

            Literal black rather than a token because that is what was asked
            for. Safe while the app is `forcedTheme="light"`; if dark mode is
            ever enabled this needs a token, or the icon disappears. */}
        <IntentTypeIcon type={intent.type} className="mt-0.5 h-7 w-7 shrink-0 text-black" />

        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-semibold">{intentTypeLabel(intent.type)}</span>
            <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
              {view.live ? (
                <span className="bg-foreground h-1.5 w-1.5 animate-pulse rounded-full motion-reduce:animate-none" />
              ) : null}
              {statusLabel(intent)}
            </span>
          </div>

          <div className="mt-1.5 flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2 text-sm tabular-nums">
              <span className="flex items-center gap-1.5 font-medium">
                <TokenIcon symbol={intent.tokenIn} size={18} />
                {intent.amountIn} {intent.tokenIn}
              </span>
              <ArrowRight className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
              <span className="text-muted-foreground flex min-w-0 items-center gap-1.5">
                <TokenIcon symbol={intent.tokenOut} size={18} />
                <span className="truncate">
                  {intent.minAmountOut} {intent.tokenOut}
                </span>
              </span>
            </div>
            <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
              {usd(intent)}
            </span>
          </div>
        </div>

        <ChevronDown
          className={cn(
            'text-muted-foreground mt-1 h-4 w-4 shrink-0 transition-transform',
            expanded && 'rotate-180'
          )}
          aria-hidden
        />
      </button>

      {expanded ? (
        <div className="border-border flex flex-col gap-4 border-t px-5 pb-5 pt-4">
          <div className="grid grid-cols-2 gap-4 text-sm tabular-nums sm:grid-cols-4">
            <div>
              <p className="text-muted-foreground text-xs">You pay</p>
              <p className="text-foreground">
                {intent.amountIn} {intent.tokenIn}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs">Minimum received</p>
              <p className="text-foreground">
                {intent.minAmountOut} {intent.tokenOut}
              </p>
            </div>
            {intent.limitPriceUsd !== undefined ? (
              <div>
                <p className="text-muted-foreground text-xs">Limit price</p>
                <p className="text-foreground">
                  ${intent.limitPriceUsd.toLocaleString('en-US', { maximumFractionDigits: 6 })}
                </p>
              </div>
            ) : null}
            <div>
              <p className="text-muted-foreground text-xs">Deadline</p>
              <p className="text-foreground">
                {new Date(intent.deadline).toLocaleString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </p>
            </div>
          </div>

          {/* An open order is a standing offer, so the ability to take it back
              belongs wherever the order is shown. */}
          {open ? (
            <div className="flex flex-col gap-2">
              <p className="text-muted-foreground text-xs">
                Waiting for {intent.tokenOut} to reach $
                {intent.limitPriceUsd?.toLocaleString('en-US', { maximumFractionDigits: 6 })}.
                Nothing has been spent.
              </p>
              <button
                type="button"
                disabled={cancelIntent.isPending}
                onClick={() => cancelIntent.mutate(intent.id)}
                className="border-border text-foreground hover:border-foreground/40 w-fit rounded-full border px-4 py-1.5 text-xs transition-colors disabled:opacity-50"
              >
                {cancelIntent.isPending ? 'Cancelling…' : 'Cancel order'}
              </button>
              {cancelIntent.isError ? (
                <p className="text-foreground text-xs">{(cancelIntent.error as Error).message}</p>
              ) : null}
            </div>
          ) : null}

          {/* A settled trade should be checkable without re-running it. The
              explorer is the only source that is not this app's own word. */}
          {explorerUrl !== undefined ? (
            <a
              href={explorerUrl}
              target="_blank"
              rel="noreferrer"
              className="border-border hover:bg-muted/60 inline-flex w-fit items-center gap-2 rounded-md border px-3 py-2 text-xs font-medium transition-colors"
            >
              View on Stellar Expert
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          ) : intent.status === 'settled' ? (
            // Settled with no hash means this intent predates transaction
            // recording, or never had an on-chain leg. Saying which is
            // honest; implying the trade did not happen is not.
            <p className="text-muted-foreground text-xs">
              This intent was settled before transaction hashes were recorded, so there is no
              explorer link for it.
            </p>
          ) : null}
        </div>
      ) : null}
    </Card>
  )
}
