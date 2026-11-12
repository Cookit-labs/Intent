'use client'

import { cn } from '@intent/ui'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, Loader2 } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useState } from 'react'

import type { TokenAsk } from '../../lib/tokens/ask'
import { TOKEN_LIST_SIZE, tokenListReply, tokenReply, TOKENS_UNREAD } from '../../lib/tokens/reply'
import {
  countFigure,
  fetchTokens,
  priceFigure,
  usdFigure,
  type TokenRow,
} from '../../lib/tokens/types'
import { useChain } from '../../providers/chain-provider'
import { toolCard } from '../intents/bubble'
import { TokenIcon } from '../ui/token-icon'
import { ChangePill, TokenSheet, TrustChips } from './token-parts'

const LIST_SIZE = TOKEN_LIST_SIZE

/** The token someone most likely means by a word: its exact symbol, the verified one first. */
export function bestMatch(tokens: readonly TokenRow[], query: string): TokenRow | undefined {
  const wanted = query.toLowerCase()
  const named = tokens.filter(
    (t) => t.symbol.toLowerCase() === wanted || t.name?.toLowerCase() === wanted
  )
  const pool = named.length > 0 ? named : tokens
  return [...pool].sort(
    (a, b) =>
      Number(b.listed) - Number(a.listed) ||
      b.verified.length - a.verified.length ||
      (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0)
  )[0]
}

function SeeAll({ segment, chain }: { segment: string; chain: string }): JSX.Element {
  return (
    <Link
      href={`/${segment}/tokens`}
      className="text-muted-foreground hover:text-foreground inline-flex w-fit items-center gap-0.5 text-sm transition-colors"
    >
      All tokens on {chain}
      <ChevronRight className="h-4 w-4" aria-hidden />
    </Link>
  )
}

function Figure({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="truncate text-sm font-semibold tabular-nums">{value}</span>
    </div>
  )
}

/** The answer to "list the tokens" or "is WAL verified", in the thread. Read-only: it moves nothing. */
export function TokenChatCard({
  ask,
  onRead,
}: {
  ask: TokenAsk
  /** What the card showed, in words, once it has been read. */
  onRead?: (text: string) => void
}): JSX.Element {
  const { slug, segment, descriptor } = useChain()
  const [open, setOpen] = useState<TokenRow | null>(null)
  const query = ask.kind === 'token' ? ask.query : ''
  const { data, isLoading, isError } = useQuery({
    queryKey: ['tokens', slug, query],
    queryFn: () => fetchTokens(slug, query),
    staleTime: 2 * 60_000,
  })

  useEffect(() => {
    if (isLoading || onRead === undefined) return
    if (isError || data === undefined) onRead(TOKENS_UNREAD(descriptor.name))
    else if (ask.kind === 'token') {
      onRead(tokenReply(bestMatch(data.tokens, ask.query), ask.query, descriptor.name))
    } else onRead(tokenListReply(data.tokens, descriptor.name))
    // Read once per answer; a new callback each render must not say it again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, isError, isLoading, ask, descriptor.name])

  if (isLoading) {
    return (
      <div className={cn(toolCard, 'text-muted-foreground flex-row items-center gap-2 text-sm')}>
        <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden />
        Reading tokens on {descriptor.name}
      </div>
    )
  }
  if (isError || data === undefined) {
    return (
      <div className={cn(toolCard, 'text-sm')}>
        Tokens on {descriptor.name} couldn’t be read just now. Try again in a moment.
      </div>
    )
  }

  const sheet = <TokenSheet token={open} onClose={() => setOpen(null)} />

  if (ask.kind === 'token') {
    const token = bestMatch(data.tokens, ask.query)
    if (token === undefined) {
      return (
        <div className={cn(toolCard, 'gap-3 text-sm')}>
          <p>
            Nothing on {descriptor.name} matches “{ask.query}”.
          </p>
          <SeeAll segment={segment} chain={descriptor.name} />
        </div>
      )
    }
    const others = data.tokens.filter(
      (t) => t.id !== token.id && t.symbol.toLowerCase() === token.symbol.toLowerCase()
    ).length
    return (
      <div className={cn(toolCard, 'gap-5')}>
        <div className="flex items-center gap-3.5">
          <TokenIcon
            symbol={token.symbol}
            size={44}
            src={token.icon}
            unknown={!token.listed}
            verified={token.verified.length > 0}
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-base font-semibold">{token.symbol}</p>
            {token.name !== undefined && token.name !== token.symbol ? (
              <p className="text-muted-foreground truncate text-xs">{token.name}</p>
            ) : null}
          </div>
          <div className="flex flex-col items-end gap-1">
            <span className="font-display text-xl font-semibold tabular-nums">
              {priceFigure(token.priceUsd)}
            </span>
            <ChangePill value={token.change24h} />
          </div>
        </div>
        <TrustChips token={token} />
        <div className="grid grid-cols-3 gap-3">
          <Figure label="Market cap" value={usdFigure(token.marketCapUsd)} />
          <Figure label="Liquidity" value={usdFigure(token.liquidityUsd)} />
          <Figure label="Holders" value={countFigure(token.holders)} />
        </div>
        {others > 0 ? (
          <p className="text-muted-foreground text-xs">
            {others === 1 ? 'Another token uses' : `${others} other tokens use`} this name on{' '}
            {descriptor.name}. This is the one most likely meant.
          </p>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => setOpen(token)}
            className="bg-foreground text-background hover:bg-foreground/90 rounded-full px-4 py-2 text-sm font-medium transition-colors"
          >
            Full details
          </button>
          <SeeAll segment={segment} chain={descriptor.name} />
        </div>
        {sheet}
      </div>
    )
  }

  return (
    <div className={cn(toolCard, 'gap-2 px-3 pb-4 pt-4')}>
      <p className="text-muted-foreground px-2 text-xs">Tokens on {descriptor.name}</p>
      <ul className="flex flex-col">
        {data.tokens.slice(0, LIST_SIZE).map((token) => (
          <li key={token.id}>
            <button
              type="button"
              onClick={() => setOpen(token)}
              aria-label={`${token.symbol} details`}
              className="hover:bg-muted/50 flex w-full items-center gap-3 rounded-2xl px-2 py-2.5 text-left transition-colors"
            >
              <TokenIcon
                symbol={token.symbol}
                size={34}
                src={token.icon}
                unknown={!token.listed}
                verified={token.verified.length > 0}
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-semibold">{token.symbol}</span>
                <span className="text-muted-foreground truncate text-xs">
                  {usdFigure(token.liquidityUsd)} liquidity
                </span>
              </span>
              <span className="flex flex-col items-end gap-1">
                <span className="text-sm font-medium tabular-nums">
                  {priceFigure(token.priceUsd)}
                </span>
                <ChangePill value={token.change24h} />
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="px-2 pt-1">
        <SeeAll segment={segment} chain={descriptor.name} />
      </div>
      {sheet}
    </div>
  )
}
