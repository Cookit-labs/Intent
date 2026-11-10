'use client'

import { cn } from '@intent/ui'
import { useQuery } from '@tanstack/react-query'
import { BadgeCheck, Check, Copy, ExternalLink, TriangleAlert } from 'lucide-react'
import { useState } from 'react'

import { useChain } from '../../providers/chain-provider'
import {
  changeFigure,
  countFigure,
  fetchToken,
  priceFigure,
  usdFigure,
  type TokenRow,
} from '../../lib/tokens/types'
import { Sheet } from '../ui/sheet'
import { TokenIcon } from '../ui/token-icon'

/** Who vouches for a token, in as few words as a chip holds: the full sentence stays on hover. */
export function trustLabel(said: string): string {
  if (said.startsWith('Checked by Intent')) return 'Tradable on Intent'
  const rated = /^Rated (.+) by (.+)$/.exec(said)
  if (rated !== null) return `${rated[2] ?? ''} ${(rated[1] ?? '').replace(' of ', '/')}`
  const named = /^(?:Verified|Listed|Chosen) (?:by|on) (.+)$/.exec(said)
  return named?.[1] ?? said
}

export function VerifiedMark({ className }: { className?: string }): JSX.Element {
  return (
    <BadgeCheck
      className={cn('fill-brand text-brand-foreground h-4 w-4 shrink-0', className)}
      aria-label="Verified"
      role="img"
    />
  )
}

/** The day's move. Down is the only one in colour, because the app has one accent and it is purple. */
export function ChangePill({
  value,
  className,
}: {
  value: number | undefined
  className?: string
}): JSX.Element {
  const down = value !== undefined && value <= -0.005
  const up = value !== undefined && value >= 0.005
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium tabular-nums',
        down
          ? 'bg-destructive/10 text-destructive dark:bg-destructive/20'
          : up
            ? 'bg-brand/10 text-foreground dark:bg-white/10'
            : 'bg-muted text-muted-foreground dark:bg-white/10',
        className
      )}
    >
      {changeFigure(value)}
    </span>
  )
}

export function TrustChips({ token }: { token: TokenRow }): JSX.Element {
  if (token.verified.length === 0) {
    return (
      <span className="bg-destructive/10 text-destructive inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium">
        <TriangleAlert className="h-3.5 w-3.5" aria-hidden />
        Not verified by anyone here
      </span>
    )
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {token.verified.map((said) => (
        <span
          key={said}
          title={said}
          className="bg-muted/70 inline-flex items-center gap-1.5 rounded-full py-1 pl-1.5 pr-2.5 text-xs font-medium"
        >
          <VerifiedMark className="h-3.5 w-3.5" />
          {trustLabel(said)}
        </span>
      ))}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-[15px] font-semibold tabular-nums">{value}</dd>
    </div>
  )
}

function shortId(id: string): string {
  return id.length <= 18 ? id : `${id.slice(0, 8)}…${id.slice(-6)}`
}

function dexName(dex: string): string {
  return dex
    .split(/[-_ ]/)
    .map((word) => (word === '' ? word : `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`))
    .join(' ')
}

/** Everything known about one token. Its holders and pools take one more read, so they arrive after. */
export function TokenDetail({ token }: { token: TokenRow }): JSX.Element {
  const { slug } = useChain()
  const [copied, setCopied] = useState(false)
  const { data, isLoading } = useQuery({
    queryKey: ['token-detail', slug, token.id],
    queryFn: () => fetchToken(slug, token.id),
    staleTime: 5 * 60_000,
    retry: 1,
  })
  const shown = data ?? token

  return (
    <div className="flex flex-col gap-7 px-5 pb-7 pt-5 sm:px-7 sm:pt-8">
      <div className="flex items-center gap-4 pr-10">
        <TokenIcon
          symbol={shown.symbol}
          size={56}
          src={shown.icon}
          unknown={!shown.listed}
          verified={shown.verified.length > 0}
        />
        <div className="min-w-0">
          <p className="font-display truncate text-2xl font-semibold tracking-tight">
            {shown.symbol}
          </p>
          {shown.name !== undefined && shown.name !== shown.symbol ? (
            <p className="text-muted-foreground truncate text-sm">{shown.name}</p>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-baseline gap-3">
        <span className="font-display text-4xl font-semibold tabular-nums tracking-tight">
          {priceFigure(shown.priceUsd)}
        </span>
        <ChangePill value={shown.change24h} />
      </div>

      <div className="flex flex-col gap-2.5">
        <p className="text-muted-foreground text-xs">Verified by</p>
        <TrustChips token={shown} />
        {shown.sameNameAs !== undefined ? (
          <p className="text-muted-foreground text-xs leading-relaxed">
            Not the {shown.sameNameAs} this app trades, which sits at another address.
          </p>
        ) : null}
      </div>

      <dl className="border-border/70 grid grid-cols-2 gap-x-6 gap-y-5 border-t pt-6">
        <Stat label="Market cap" value={usdFigure(shown.marketCapUsd)} />
        <Stat label="Fully diluted" value={usdFigure(shown.fdvUsd)} />
        <Stat label="Liquidity" value={usdFigure(shown.liquidityUsd)} />
        <Stat label="24h volume" value={usdFigure(shown.volume24hUsd)} />
        <Stat
          label="Holders"
          value={isLoading && shown.holders === undefined ? '…' : countFigure(shown.holders)}
        />
      </dl>

      {shown.pools !== undefined && shown.pools.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="text-muted-foreground mb-1 text-xs">Where it trades</p>
          {shown.pools.map((pool) => {
            const inner = (
              <>
                <span className="min-w-0 truncate text-sm">
                  <span className="font-medium">{pool.pair}</span>
                  <span className="text-muted-foreground"> · {dexName(pool.dex)}</span>
                </span>
                <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                  {usdFigure(pool.liquidityUsd)}
                </span>
              </>
            )
            const key = `${pool.dex}-${pool.pair}-${pool.liquidityUsd ?? 0}`
            const row = '-mx-2 flex items-center justify-between gap-3 rounded-xl px-2 py-2'
            return pool.url !== undefined ? (
              <a
                key={key}
                href={pool.url}
                target="_blank"
                rel="noreferrer"
                className={cn(row, 'hover:bg-muted/50 transition-colors')}
              >
                {inner}
              </a>
            ) : (
              <div key={key} className={row}>
                {inner}
              </div>
            )
          })}
        </div>
      ) : null}

      <div className="bg-muted/50 flex items-center gap-2 rounded-2xl py-2 pl-4 pr-2">
        <span
          className="text-muted-foreground min-w-0 flex-1 truncate text-sm tabular-nums"
          title={shown.id}
        >
          {shortId(shown.id)}
        </span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard
              .writeText(shown.id)
              .then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              })
              .catch(() => undefined)
          }}
          aria-label="Copy address"
          className="hover:bg-background text-muted-foreground hover:text-foreground flex h-9 w-9 items-center justify-center rounded-full transition-colors"
        >
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        </button>
        <a
          href={shown.explorerUrl}
          target="_blank"
          rel="noreferrer"
          aria-label="View on explorer"
          className="hover:bg-background text-muted-foreground hover:text-foreground flex h-9 w-9 items-center justify-center rounded-full transition-colors"
        >
          <ExternalLink className="h-4 w-4" />
        </a>
      </div>
    </div>
  )
}

/** One token in a panel of its own, from a list on the page or in the chat. */
export function TokenSheet({
  token,
  onClose,
}: {
  token: TokenRow | null
  onClose: () => void
}): JSX.Element | null {
  return (
    <Sheet open={token !== null} onClose={onClose} label={token === null ? 'Token' : token.symbol}>
      {token !== null ? <TokenDetail token={token} /> : null}
    </Sheet>
  )
}
