'use client'

import { Button, Card, cn } from '@intent/ui'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, Loader2 } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'

import type { TokenAsk } from '../../lib/tokens/ask'
import { fetchTokens, priceFigure, usdFigure, type TokenRow } from '../../lib/tokens/types'
import { useChain } from '../../providers/chain-provider'
import { TokenIcon } from '../ui/token-icon'
import { TokenFacts, VerifiedMark } from './token-parts'

const LIST_SIZE = 8

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

function TokenLine({ token }: { token: TokenRow }): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <li className="border-border border-b last:border-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="hover:bg-muted/40 flex w-full items-center gap-3 rounded-md px-1 py-2.5 text-left text-sm transition-colors"
      >
        <TokenIcon symbol={token.symbol} size={24} src={token.icon} unknown={!token.listed} />
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="font-semibold">{token.symbol}</span>
          {token.verified.length > 0 ? <VerifiedMark /> : null}
        </span>
        <span className="tabular-nums">{priceFigure(token.priceUsd)}</span>
        <span className="text-muted-foreground w-16 text-right text-xs tabular-nums">
          {usdFigure(token.liquidityUsd)}
        </span>
        <ChevronDown
          className={cn(
            'text-muted-foreground h-4 w-4 shrink-0 transition-transform',
            open && 'rotate-180'
          )}
          aria-hidden
        />
      </button>
      {open ? (
        <div className="px-1 pb-3 pt-1">
          <TokenFacts token={token} />
        </div>
      ) : null}
    </li>
  )
}

/** The answer to "list the tokens" or "is WAL verified", in the thread. Read-only: it moves nothing. */
export function TokenChatCard({ ask }: { ask: TokenAsk }): JSX.Element {
  const { slug, segment, descriptor } = useChain()
  const query = ask.kind === 'token' ? ask.query : ''
  const { data, isLoading, isError } = useQuery({
    queryKey: ['tokens', slug, query],
    queryFn: () => fetchTokens(slug, query),
    staleTime: 2 * 60_000,
  })

  if (isLoading) {
    return (
      <Card className="text-muted-foreground flex items-center gap-2 p-5 text-sm">
        <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden />
        Reading tokens on {descriptor.name}
      </Card>
    )
  }
  if (isError || data === undefined) {
    return (
      <Card className="p-5 text-sm">
        Could not read tokens on {descriptor.name} just now. Try again in a moment.
      </Card>
    )
  }

  const seeAll = (
    <Button asChild size="sm" variant="outline" className="self-start">
      <Link href={`/${segment}/tokens`}>See all tokens on {descriptor.name}</Link>
    </Button>
  )

  if (ask.kind === 'token') {
    const token = bestMatch(data.tokens, ask.query)
    if (token === undefined) {
      return (
        <Card className="flex flex-col gap-3 p-5 text-sm">
          <p>
            No token on {descriptor.name} matches “{ask.query}”.
          </p>
          {seeAll}
        </Card>
      )
    }
    const others = data.tokens.filter(
      (t) => t.id !== token.id && t.symbol.toLowerCase() === token.symbol.toLowerCase()
    ).length
    return (
      <Card className="flex flex-col gap-4 p-5">
        <div className="flex items-center gap-3">
          <TokenIcon symbol={token.symbol} size={32} src={token.icon} unknown={!token.listed} />
          <div className="min-w-0">
            <p className="text-sm font-semibold">{token.symbol}</p>
            {token.name !== undefined && token.name !== token.symbol ? (
              <p className="text-muted-foreground truncate text-xs">{token.name}</p>
            ) : null}
          </div>
        </div>
        <TokenFacts token={token} />
        {others > 0 ? (
          <p className="text-muted-foreground text-xs">
            {others === 1 ? 'One other token uses' : `${others} other tokens use`} this name on{' '}
            {descriptor.name}, and this is the one most likely meant.
          </p>
        ) : null}
        {seeAll}
      </Card>
    )
  }

  return (
    <Card className="flex flex-col gap-3 p-5">
      <p className="text-sm font-medium">Tokens on {descriptor.name}</p>
      <ul className="flex flex-col">
        {data.tokens.slice(0, LIST_SIZE).map((token) => (
          <TokenLine key={token.id} token={token} />
        ))}
      </ul>
      {seeAll}
    </Card>
  )
}
