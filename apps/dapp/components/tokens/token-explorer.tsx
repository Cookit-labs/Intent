'use client'

import { Button, Card, cn } from '@intent/ui'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, Search } from 'lucide-react'
import { Fragment, useEffect, useMemo, useState } from 'react'

import { useChain } from '../../providers/chain-provider'
import {
  countFigure,
  fetchTokens,
  priceFigure,
  usdFigure,
  type TokenRow,
} from '../../lib/tokens/types'
import { TokenIcon } from '../ui/token-icon'
import { ChangeText, TokenFacts, VerifiedMark } from './token-parts'

type SortKey =
  | 'priceUsd'
  | 'change24h'
  | 'marketCapUsd'
  | 'liquidityUsd'
  | 'volume24hUsd'
  | 'holders'

const COLUMNS: readonly { key: SortKey; label: string; wide?: boolean; medium?: boolean }[] = [
  { key: 'priceUsd', label: 'Price' },
  { key: 'change24h', label: '24h', wide: true },
  { key: 'marketCapUsd', label: 'Market cap', wide: true },
  { key: 'liquidityUsd', label: 'Liquidity', medium: true },
  { key: 'volume24hUsd', label: '24h volume', wide: true },
  { key: 'holders', label: 'Holders', wide: true },
]

/** A token's liquidity against the deepest on the list, on a log scale so small ones still show. */
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

function TableSkeleton(): JSX.Element {
  return (
    <div className="flex flex-col" aria-hidden>
      {[0, 1, 2, 3, 4, 5, 6].map((i) => (
        <div
          key={i}
          className="border-border flex items-center gap-3 border-b px-4 py-3.5 last:border-0"
        >
          <span className="bg-muted h-7 w-7 rounded-full motion-safe:animate-pulse" />
          <span className="bg-muted h-3.5 w-28 rounded motion-safe:animate-pulse" />
          <span className="bg-muted ml-auto h-3.5 w-16 rounded motion-safe:animate-pulse" />
          <span className="bg-muted hidden h-3.5 w-16 rounded motion-safe:animate-pulse sm:block" />
        </div>
      ))}
    </div>
  )
}

export function TokenExplorer(): JSX.Element {
  const { slug, descriptor } = useChain()
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const [onlyVerified, setOnlyVerified] = useState(false)
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({
    key: 'liquidityUsd',
    descending: true,
  })
  const [openId, setOpenId] = useState<string | null>(null)

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

  const rows = useMemo(() => {
    const tokens = data?.tokens ?? []
    return sorted(
      onlyVerified ? tokens.filter((t) => t.verified.length > 0) : tokens,
      sort.key,
      sort.descending
    )
  }, [data, onlyVerified, sort])
  const deepest = Math.max(0, ...rows.map((t) => t.liquidityUsd ?? 0))

  function sortBy(key: SortKey): void {
    setSort((now) =>
      now.key === key ? { key, descending: !now.descending } : { key, descending: true }
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="border-border bg-card focus-within:border-foreground/40 flex min-w-56 flex-1 items-center gap-2 rounded-lg border px-3 py-2 transition-colors">
          <Search className="text-muted-foreground h-4 w-4 shrink-0" aria-hidden />
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Search by name, symbol or address"
            aria-label={`Search tokens on ${descriptor.name}`}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none"
          />
        </label>
        <button
          type="button"
          aria-pressed={onlyVerified}
          onClick={() => setOnlyVerified((v) => !v)}
          className={cn(
            'border-border inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors',
            onlyVerified ? 'bg-bubble-me text-bubble-me-foreground' : 'hover:bg-muted/60'
          )}
        >
          <VerifiedMark />
          Verified only
        </button>
      </div>

      {isError && data === undefined ? (
        <Card className="flex flex-col items-start gap-3 p-6 text-sm">
          <p>Could not read tokens on {descriptor.name} just now.</p>
          <Button size="sm" variant="outline" onClick={() => void refetch()}>
            Try again
          </Button>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          {isLoading ? (
            <TableSkeleton />
          ) : rows.length === 0 ? (
            <p className="text-muted-foreground p-6 text-sm">
              {query !== ''
                ? `No token on ${descriptor.name} matches “${query}”. Try its address.`
                : 'Nothing verified to show. Turn off Verified only to see every token.'}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-border border-b">
                    <th
                      scope="col"
                      className="text-muted-foreground px-4 py-2.5 text-left text-xs font-medium"
                    >
                      Token
                    </th>
                    {COLUMNS.map((column) => {
                      const active = sort.key === column.key
                      return (
                        <th
                          key={column.key}
                          scope="col"
                          aria-sort={
                            active ? (sort.descending ? 'descending' : 'ascending') : 'none'
                          }
                          className={cn(
                            'px-3 py-2.5 text-right',
                            column.wide && 'hidden lg:table-cell',
                            column.medium && 'hidden sm:table-cell'
                          )}
                        >
                          <button
                            type="button"
                            onClick={() => sortBy(column.key)}
                            className={cn(
                              'hover:text-foreground inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium transition-colors',
                              active ? 'text-foreground' : 'text-muted-foreground'
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
                        </th>
                      )
                    })}
                    <th scope="col" className="w-8 px-2 py-2.5">
                      <span className="sr-only">Details</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((token) => {
                    const open = openId === token.id
                    return (
                      <Fragment key={token.id}>
                        <tr
                          onClick={() => setOpenId(open ? null : token.id)}
                          className={cn(
                            'border-border hover:bg-muted/40 cursor-pointer border-b transition-colors',
                            open && 'bg-muted/40'
                          )}
                        >
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-3">
                              <TokenIcon
                                symbol={token.symbol}
                                size={28}
                                src={token.icon}
                                unknown={!token.listed}
                              />
                              <div className="min-w-0">
                                <div className="flex items-center gap-1.5">
                                  <span className="font-semibold">{token.symbol}</span>
                                  {token.verified.length > 0 ? <VerifiedMark /> : null}
                                </div>
                                {token.name !== undefined && token.name !== token.symbol ? (
                                  <p className="text-muted-foreground max-w-40 truncate text-xs">
                                    {token.name}
                                  </p>
                                ) : null}
                              </div>
                            </div>
                          </td>
                          <td className="px-3 py-3 text-right tabular-nums">
                            {priceFigure(token.priceUsd)}
                          </td>
                          <td className="hidden px-3 py-3 text-right lg:table-cell">
                            <ChangeText value={token.change24h} />
                          </td>
                          <td className="hidden px-3 py-3 text-right tabular-nums lg:table-cell">
                            {usdFigure(token.marketCapUsd)}
                          </td>
                          <td className="hidden px-3 py-3 text-right tabular-nums sm:table-cell">
                            {usdFigure(token.liquidityUsd)}
                            <span className="bg-muted ml-auto mt-1 block h-0.5 w-16 overflow-hidden rounded-full">
                              <span
                                className="bg-brand block h-full rounded-full"
                                style={{ width: `${depthOf(token.liquidityUsd, deepest)}%` }}
                              />
                            </span>
                          </td>
                          <td className="hidden px-3 py-3 text-right tabular-nums lg:table-cell">
                            {usdFigure(token.volume24hUsd)}
                          </td>
                          <td className="hidden px-3 py-3 text-right tabular-nums lg:table-cell">
                            {countFigure(token.holders)}
                          </td>
                          <td className="px-2 py-3 text-right">
                            <button
                              type="button"
                              aria-expanded={open}
                              aria-label={`${open ? 'Hide' : 'Show'} details for ${token.symbol}`}
                              onClick={(e) => {
                                e.stopPropagation()
                                setOpenId(open ? null : token.id)
                              }}
                              className="text-muted-foreground hover:text-foreground p-1 transition-colors"
                            >
                              <ChevronDown
                                className={cn('h-4 w-4 transition-transform', open && 'rotate-180')}
                                aria-hidden
                              />
                            </button>
                          </td>
                        </tr>
                        {open ? (
                          <tr className="border-border border-b">
                            <td colSpan={COLUMNS.length + 2} className="px-4 py-4">
                              <TokenFacts token={token} />
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {data !== undefined ? (
        <p className="text-muted-foreground text-xs">
          {data.partial ? 'Some sources did not answer, so a few figures may be missing. ' : ''}
          {data.sources.length > 0 ? `Market data from ${data.sources.join(' and ')}. ` : ''}A dash
          means no source reported that figure.
        </p>
      ) : null}
    </div>
  )
}
