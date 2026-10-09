'use client'

import { Badge, Button, cn } from '@intent/ui'
import { ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react'
import { useEffect, useState } from 'react'

import { EmptyNote, PageTitle, Panel } from '../../../components/admin/parts'
import { useScope } from '../../../components/admin/scope'
import {
  KIND_LABELS,
  formatCount,
  formatUsd,
  kindLabel,
  shortAddress,
} from '../../../components/admin/stats'

interface Row {
  id: string
  hash: string | null
  account: string
  kind: string
  ok: boolean
  failure: string | null
  feeSponsored: boolean
  at: string
  assetIn: string | null
  assetOut: string | null
  volumeUsd: number | null
  explorerUrl: string | null
}

interface Page {
  total: number
  page: number
  pageSize: number
  rows: Row[]
}

type Outcome = 'all' | 'true' | 'false'

const OUTCOMES: { value: Outcome; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'true', label: 'Accepted' },
  { value: 'false', label: 'Failed' },
]

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function AdminTransactionsPage(): JSX.Element {
  const { scope, range } = useScope()
  const [kind, setKind] = useState('')
  const [outcome, setOutcome] = useState<Outcome>('all')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<Page | null>(null)
  const [error, setError] = useState<string | undefined>(undefined)

  const network = scope.network
  const tracked = scope.chain === 'stellar' && network !== null

  useEffect(() => setPage(1), [kind, outcome, network, range])

  useEffect(() => {
    if (!tracked) return
    const controller = new AbortController()
    const params = new URLSearchParams({
      view: 'transactions',
      chain: 'stellar',
      network,
      range,
      page: String(page),
    })
    if (kind !== '') params.set('kind', kind)
    if (outcome !== 'all') params.set('ok', outcome)
    setError(undefined)
    fetch(`/api/admin/metrics?${params}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error('unavailable')
        setData((await res.json()) as Page)
      })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === 'AbortError') return
        setError('Transactions could not be loaded. Try again in a moment.')
      })
    return () => controller.abort()
  }, [tracked, network, range, kind, outcome, page])

  const pages = data === null ? 1 : Math.max(Math.ceil(data.total / data.pageSize), 1)

  return (
    <>
      <PageTitle
        title="Transactions"
        hint="Every transaction people submitted, newest first. Open one on the explorer to check it."
      />

      {!tracked ? (
        <Panel title={`${scope.name} transactions`}>
          <EmptyNote>
            Intent does not record usage on {scope.name} yet. Stellar Mainnet and Testnet are
            counted today.
          </EmptyNote>
        </Panel>
      ) : (
        <>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="bg-muted/60 flex w-fit max-w-full overflow-x-auto rounded-lg p-1">
              {OUTCOMES.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  aria-pressed={outcome === o.value}
                  onClick={() => setOutcome(o.value)}
                  className={cn(
                    'rounded-md px-3 py-1.5 text-sm transition-colors',
                    outcome === o.value
                      ? 'bg-card text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              aria-label="Filter by type"
              className="border-input bg-card h-9 rounded-md border px-3 text-sm"
            >
              <option value="">All types</option>
              {Object.entries(KIND_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          <Panel title={data === null ? 'Transactions' : `${formatCount(data.total)} transactions`}>
            {error !== undefined ? (
              <p className="text-destructive text-sm">{error}</p>
            ) : data === null ? (
              <div aria-busy="true" className="bg-muted/40 h-40 animate-pulse rounded-lg" />
            ) : data.rows.length === 0 ? (
              <EmptyNote>No transactions match these filters in this period.</EmptyNote>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-muted-foreground">
                    <tr>
                      <th className="py-2 pr-4 font-normal">When</th>
                      <th className="py-2 pr-4 font-normal">Type</th>
                      <th className="py-2 pr-4 font-normal">Wallet</th>
                      <th className="py-2 pr-4 font-normal">Moved</th>
                      <th className="py-2 pr-4 text-right font-normal">Value</th>
                      <th className="py-2 pr-4 font-normal">Result</th>
                      <th className="py-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-border divide-y">
                    {data.rows.map((r) => (
                      <tr key={r.id}>
                        <td className="text-muted-foreground whitespace-nowrap py-2.5 pr-4">
                          {when(r.at)}
                        </td>
                        <td className="py-2.5 pr-4">{kindLabel(r.kind)}</td>
                        <td className="py-2.5 pr-4 font-mono" title={r.account}>
                          {shortAddress(r.account)}
                        </td>
                        <td className="py-2.5 pr-4">
                          {r.assetIn === null
                            ? '—'
                            : r.assetOut === null
                              ? r.assetIn
                              : `${r.assetIn} → ${r.assetOut}`}
                        </td>
                        <td className="py-2.5 pr-4 text-right font-mono tabular-nums">
                          {r.volumeUsd === null ? '—' : formatUsd(r.volumeUsd)}
                        </td>
                        <td className="py-2.5 pr-4">
                          <Badge
                            variant="outline"
                            className={
                              r.ok
                                ? 'border-success/40 text-success'
                                : 'border-destructive/40 text-destructive'
                            }
                          >
                            {r.ok ? 'Accepted' : (r.failure ?? 'Failed')}
                          </Badge>
                        </td>
                        <td className="py-2.5 text-right">
                          {r.explorerUrl !== null ? (
                            <a
                              href={r.explorerUrl}
                              target="_blank"
                              rel="noreferrer"
                              aria-label="Open on the explorer"
                              className="text-muted-foreground hover:text-foreground inline-flex"
                            >
                              <ExternalLink className="h-4 w-4" />
                            </a>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {data !== null && pages > 1 ? (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground text-sm">
                  Page {page} of {pages}
                </span>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => p - 1)}
                    aria-label="Previous page"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={page >= pages}
                    onClick={() => setPage((p) => p + 1)}
                    aria-label="Next page"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ) : null}
          </Panel>
        </>
      )}
    </>
  )
}
