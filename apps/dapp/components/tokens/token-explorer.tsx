'use client'

import { Button, cn } from '@intent/ui'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, Search, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { useChain } from '../../providers/chain-provider'
import {
  countFigure,
  fetchTokens,
  priceFigure,
  usdFigure,
  type TokenRow,
} from '../../lib/tokens/types'
import { TokenIcon } from '../ui/token-icon'
import { ChangePill, TokenSheet } from './token-parts'

type SortKey =
  | 'priceUsd'
  | 'change24h'
  | 'marketCapUsd'
  | 'liquidityUsd'
  | 'volume24hUsd'
  | 'holders'

type Filter = 'all' | 'verified' | 'tradable'

/** Which columns show at which width: the token and its price always, the rest as room allows. */
const COLUMNS: readonly { key: SortKey; label: string; from: 'base' | 'sm' | 'lg' }[] = [
  { key: 'priceUsd', label: 'Price', from: 'base' },
  { key: 'change24h', label: '24h', from: 'sm' },
  { key: 'marketCapUsd', label: 'Market cap', from: 'lg' },
  { key: 'liquidityUsd', label: 'Liquidity', from: 'sm' },
  { key: 'volume24hUsd', label: 'Volume', from: 'lg' },
  { key: 'holders', label: 'Holders', from: 'lg' },
]

const SHOW: Record<'base' | 'sm' | 'lg', string> = {
  base: 'flex',
  sm: 'hidden sm:flex',
  lg: 'hidden lg:flex',
}

const GRID =
  'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 sm:grid-cols-[minmax(0,1.6fr)_repeat(3,minmax(0,0.8fr))] lg:grid-cols-[minmax(0,1.8fr)_repeat(6,minmax(0,0.8fr))]'

/** A token's depth against the deepest on the list, on a log scale so small ones still show. */
function depthOf(value: number | undefined, deepest: number): number {
  if (value === undefined || value <= 0 || deepest <= 1) return 0
  return Math.max(4, (Math.log10(value + 1) / Math.log10(deepest + 1)) * 100)
}

function sorted(tokens: readonly TokenRow[], key: SortKey, descending: boolean): TokenRow[] {
  return [...tokens].sort((a, b) => {
    const x = a[key]
    const y = b[key]
    // A figure nobody reported goes last whichever way this runs, not first as a zero would.
    if (x === undefined && y === undefined) return 0
    if (x === undefined) return 1
    if (y === undefined) return -1
    return descending ? y - x : x - y
  })
}

function Skeleton(): JSX.Element {
  return (
    <div className="flex flex-col" aria-hidden>
      {[0, 1, 2, 3, 4, 5, 6].map((i) => (
        <div key={i} className={cn(GRID, 'px-4 py-3.5 sm:px-5')}>
          <span className="flex items-center gap-3">
            <span className="bg-muted h-9 w-9 rounded-full motion-safe:animate-pulse" />
            <span className="bg-muted h-3.5 w-24 rounded-full motion-safe:animate-pulse" />
          </span>
          <span className="bg-muted ml-auto h-3.5 w-16 rounded-full motion-safe:animate-pulse" />
        </div>
      ))}
    </div>
  )
}

export function TokenExplorer(): JSX.Element {
  const { slug, descriptor } = useChain()
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({
    key: 'liquidityUsd',
    descending: true,
  })
  const [open, setOpen] = useState<TokenRow | null>(null)

  useEffect(() => {
    const timer = setTimeout(() => setQuery(draft.trim()), 300)
    return () => clearTimeout(timer)
  }, [draft])

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['tokens', slug, query],
    queryFn: () => fetchTokens(slug, query),
    staleTime: 2 * 60_000,
    placeholderData: (previous) => previous,
  })

  const tokens = useMemo(() => data?.tokens ?? [], [data])
  const counts: Record<Filter, number> = {
    all: tokens.length,
    verified: tokens.filter((t) => t.verified.length > 0).length,
    tradable: tokens.filter((t) => t.listed).length,
  }
  const rows = useMemo(() => {
    const kept =
      filter === 'verified'
        ? tokens.filter((t) => t.verified.length > 0)
        : filter === 'tradable'
          ? tokens.filter((t) => t.listed)
          : tokens
    return sorted(kept, sort.key, sort.descending)
  }, [tokens, filter, sort])
  const deepest = Math.max(0, ...rows.map((t) => t.liquidityUsd ?? 0))

  function sortBy(key: SortKey): void {
    setSort((now) =>
      now.key === key ? { key, descending: !now.descending } : { key, descending: true }
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <label className="bg-muted/60 focus-within:bg-background focus-within:border-brand/40 flex items-center gap-2 rounded-full border border-transparent px-4 py-2 transition-colors md:w-80">
          <Search className="text-muted-foreground h-4 w-4 shrink-0" aria-hidden />
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Search name, symbol or address"
            aria-label={`Search tokens on ${descriptor.name}`}
            className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-sm outline-none"
          />
          {draft !== '' ? (
            <button
              type="button"
              onClick={() => setDraft('')}
              aria-label="Clear search"
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </label>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Show">
          {(
            [
              ['all', 'All'],
              ['verified', 'Verified'],
              ['tradable', 'Tradable here'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setFilter(value)}
              aria-pressed={filter === value}
              className={cn(
                'flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                filter === value
                  ? 'bg-foreground text-background'
                  : 'bg-muted/60 text-muted-foreground hover:text-foreground'
              )}
            >
              {label}
              <span className="tabular-nums opacity-60">{counts[value]}</span>
            </button>
          ))}
        </div>
      </div>

      {isError && data === undefined ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center text-sm">
          <p>Tokens on {descriptor.name} couldn’t be read just now.</p>
          <Button size="sm" variant="outline" onClick={() => void refetch()}>
            Try again
          </Button>
        </div>
      ) : (
        <div className="bg-bubble-agent border-bubble-agent-border overflow-hidden rounded-3xl border shadow-[0_1px_3px_rgb(0_0_0/0.04)]">
          <div
            className={cn(
              GRID,
              'border-border/60 text-muted-foreground border-b px-4 py-3 text-xs sm:px-5'
            )}
          >
            <span>Token</span>
            {COLUMNS.map((column) => {
              const active = sort.key === column.key
              return (
                <button
                  key={column.key}
                  type="button"
                  onClick={() => sortBy(column.key)}
                  aria-label={`Sort by ${column.label}`}
                  className={cn(
                    SHOW[column.from],
                    'hover:text-foreground items-center justify-end gap-1 whitespace-nowrap transition-colors',
                    active && 'text-foreground font-medium'
                  )}
                >
                  {column.label}
                  {active ? (
                    <ChevronDown
                      className={cn(
                        'h-3 w-3 transition-transform',
                        !sort.descending && 'rotate-180'
                      )}
                      aria-hidden
                    />
                  ) : null}
                </button>
              )
            })}
          </div>

          {isLoading ? (
            <Skeleton />
          ) : rows.length === 0 ? (
            <p className="text-muted-foreground px-5 py-12 text-center text-sm">
              {query !== ''
                ? `Nothing on ${descriptor.name} matches “${query}”. Try its address.`
                : 'Nothing to show with this filter.'}
            </p>
          ) : (
            <ul className="divide-border/50 flex flex-col divide-y">
              {rows.map((token) => (
                <li key={token.id}>
                  <button
                    type="button"
                    onClick={() => setOpen(token)}
                    aria-label={`${token.symbol} details`}
                    className={cn(
                      GRID,
                      'hover:bg-muted/40 focus-visible:bg-muted/40 w-full px-4 py-3 text-left transition-colors focus-visible:outline-none sm:px-5'
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <TokenIcon
                        symbol={token.symbol}
                        size={36}
                        src={token.icon}
                        unknown={!token.listed}
                        verified={token.verified.length > 0}
                      />
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-[15px] font-semibold">{token.symbol}</span>
                        <span className="text-muted-foreground truncate text-xs">
                          {token.name ?? ''}
                        </span>
                      </span>
                    </span>
                    <span className="flex flex-col items-end gap-1">
                      <span className="text-[15px] font-medium tabular-nums">
                        {priceFigure(token.priceUsd)}
                      </span>
                      <ChangePill value={token.change24h} className="sm:hidden" />
                    </span>
                    <span className="hidden justify-end sm:flex">
                      <ChangePill value={token.change24h} />
                    </span>
                    <span className="hidden justify-end text-sm tabular-nums lg:flex">
                      {usdFigure(token.marketCapUsd)}
                    </span>
                    <span className="hidden flex-col items-end gap-1.5 sm:flex">
                      <span className="text-sm tabular-nums">{usdFigure(token.liquidityUsd)}</span>
                      <span className="bg-muted h-1 w-14 overflow-hidden rounded-full dark:bg-white/10">
                        <span
                          className="bg-brand/70 block h-full rounded-full dark:bg-white/60"
                          style={{ width: `${depthOf(token.liquidityUsd, deepest)}%` }}
                        />
                      </span>
                    </span>
                    <span className="hidden justify-end text-sm tabular-nums lg:flex">
                      {usdFigure(token.volume24hUsd)}
                    </span>
                    <span className="text-muted-foreground hidden justify-end text-sm tabular-nums lg:flex">
                      {countFigure(token.holders)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {data !== undefined ? (
        <p className="text-muted-foreground px-1 text-xs">
          {data.sources.length > 0 ? `From ${data.sources.join(', ')}. ` : ''}
          {data.partial ? 'A source didn’t answer, so a few figures may be missing. ' : ''}A dash
          means no source reported it.
        </p>
      ) : null}

      <TokenSheet token={open} onClose={() => setOpen(null)} />
    </div>
  )
}
