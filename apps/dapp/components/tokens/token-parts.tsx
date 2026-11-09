'use client'

import { cn } from '@intent/ui'
import { useQuery } from '@tanstack/react-query'
import { BadgeCheck, Check, Copy, ExternalLink, Loader2 } from 'lucide-react'
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

export function VerifiedMark({ className }: { className?: string }): JSX.Element {
  return (
    <BadgeCheck
      className={cn('fill-brand text-brand-foreground h-4 w-4 shrink-0', className)}
      aria-label="Verified"
      role="img"
    />
  )
}

/** Up reads as plain text and down as a warning, because the app has one accent and it is purple. */
export function ChangeText({ value }: { value: number | undefined }): JSX.Element {
  return (
    <span
      className={cn('tabular-nums', value !== undefined && value <= -0.005 && 'text-destructive')}
    >
      {changeFigure(value)}
    </span>
  )
}

function Fact({ label, value }: { label: string; value: JSX.Element | string }): JSX.Element {
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium tabular-nums">{value}</dd>
    </div>
  )
}

function Address({ id, explorerUrl }: { id: string; explorerUrl: string }): JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="text-muted-foreground min-w-0 break-all text-xs">{id}</span>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(id).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
        }}
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs transition-colors"
      >
        {copied ? (
          <Check className="h-3 w-3" aria-hidden />
        ) : (
          <Copy className="h-3 w-3" aria-hidden />
        )}
        {copied ? 'Copied' : 'Copy'}
      </button>
      <a
        href={explorerUrl}
        target="_blank"
        rel="noreferrer"
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs transition-colors"
      >
        View on explorer
        <ExternalLink className="h-3 w-3" aria-hidden />
      </a>
    </div>
  )
}

function Trust({ token }: { token: TokenRow }): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5 text-sm">
      {token.verified.map((who) => (
        <p key={who} className="flex items-center gap-2">
          <VerifiedMark />
          {who}
        </p>
      ))}
      {token.verified.length === 0 ? (
        <p className="text-muted-foreground">
          Not verified by any source here. Anyone can create a token with this name, so check its
          address before you trust it.
        </p>
      ) : null}
      {token.sameNameAs !== undefined ? (
        <p className="text-muted-foreground">
          The {token.sameNameAs} this app trades is a different token at another address.
        </p>
      ) : null}
    </div>
  )
}

/** Everything known about one token. Its holders and pools take one more read, so they arrive after. */
export function TokenFacts({ token }: { token: TokenRow }): JSX.Element {
  const { slug } = useChain()
  const { data, isLoading } = useQuery({
    queryKey: ['token-detail', slug, token.id],
    queryFn: () => fetchToken(slug, token.id),
    staleTime: 5 * 60_000,
    retry: 1,
  })
  const shown = data ?? token

  return (
    <div className="flex flex-col gap-4">
      <Trust token={shown} />
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        <Fact label="Price" value={priceFigure(shown.priceUsd)} />
        <Fact label="24h change" value={<ChangeText value={shown.change24h} />} />
        <Fact label="Market cap" value={usdFigure(shown.marketCapUsd)} />
        <Fact label="Fully diluted value" value={usdFigure(shown.fdvUsd)} />
        <Fact label="Liquidity" value={usdFigure(shown.liquidityUsd)} />
        <Fact label="24h volume" value={usdFigure(shown.volume24hUsd)} />
        <Fact
          label="Holders"
          value={
            isLoading && shown.holders === undefined ? (
              <Loader2 className="text-muted-foreground h-3.5 w-3.5 motion-safe:animate-spin" />
            ) : (
              countFigure(shown.holders)
            )
          }
        />
      </dl>

      {shown.pools !== undefined && shown.pools.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-muted-foreground text-xs">Deepest pools</p>
          <ul className="flex flex-col gap-1 text-sm">
            {shown.pools.map((pool) => (
              <li
                key={`${pool.dex}-${pool.pair}-${pool.liquidityUsd ?? 0}`}
                className="flex items-baseline justify-between gap-3"
              >
                <span className="min-w-0 truncate">
                  {pool.url !== undefined ? (
                    <a
                      href={pool.url}
                      target="_blank"
                      rel="noreferrer"
                      className="hover:underline hover:underline-offset-2"
                    >
                      {pool.pair} on {pool.dex}
                    </a>
                  ) : (
                    `${pool.pair} on ${pool.dex}`
                  )}
                </span>
                <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                  {usdFigure(pool.liquidityUsd)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <Address id={shown.id} explorerUrl={shown.explorerUrl} />
    </div>
  )
}
