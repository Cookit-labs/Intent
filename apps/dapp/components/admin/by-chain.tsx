'use client'

import { ChainMark } from '@intent/ui'
import type { ChainSlug } from '@intent/types'
import { Area, AreaChart, ResponsiveContainer } from 'recharts'

import type {
  ChainRow,
  ChainTypeRow,
  NairaChainRow,
  VenueRow,
} from '../../lib/server/admin-metrics'
import { SERIES } from './charts'
import { formatCount, formatNgn, formatPercent, formatUsd, kindLabel } from './stats'

export const CHAIN_NAMES: Record<string, string> = {
  stellar: 'Stellar',
  solana: 'Solana',
  sui: 'Sui',
  near: 'NEAR',
  avalanche: 'Avalanche',
  monad: 'Monad',
}

export function chainName(chain: string): string {
  return CHAIN_NAMES[chain] ?? chain
}

export function ChainLabel({ chain }: { chain: string }): JSX.Element {
  return (
    <span className="inline-flex items-center gap-2">
      <ChainMark chain={chain as ChainSlug} className="h-4 w-4 shrink-0" />
      {chainName(chain)}
    </span>
  )
}

/** An app's id as people say it: "rhea-dex" reads as "Rhea dex". */
export function venueLabel(venue: string): string {
  const words = venue.replace(/[-_]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function Sparkline({ data, label }: { data: { day: string; value: number }[]; label: string }) {
  const id = `spark-${label.replace(/\W+/g, '')}`
  return (
    <div role="img" aria-label={`${label} volume by day`} className="h-9 w-32">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 2, left: 0 }}>
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={SERIES[0]} stopOpacity={0.25} />
              <stop offset="100%" stopColor={SERIES[0]} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area
            type="monotone"
            dataKey="value"
            stroke={SERIES[0]}
            strokeWidth={1.5}
            fill={`url(#${id})`}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

/** One row per chain: what ran there, its value, who used it and how it went. */
export function ChainTable({
  rows,
  naira,
  ngnPerUsd,
}: {
  rows: ChainRow[]
  naira: NairaChainRow[]
  ngnPerUsd: number | null
}): JSX.Element {
  const ngn = new Map(naira.map((n) => [n.chain, n.ngn]))
  const total = rows.reduce((t, r) => t + r.volumeUsd, 0)
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-muted-foreground">
          <tr>
            <th className="py-2 pr-4 font-normal">Chain</th>
            <th className="py-2 pr-4 text-right font-normal">Volume</th>
            <th className="py-2 pr-4 text-right font-normal">Share</th>
            <th className="py-2 pr-4 text-right font-normal">In naira</th>
            <th className="py-2 pr-4 font-normal">Per day</th>
            <th className="py-2 pr-4 text-right font-normal">Transactions</th>
            <th className="py-2 pr-4 text-right font-normal">Accepted</th>
            <th className="py-2 pr-4 text-right font-normal">Wallets</th>
            <th className="py-2 text-right font-normal">Type not recorded</th>
          </tr>
        </thead>
        <tbody className="divide-border divide-y">
          {rows.map((r) => (
            <tr key={r.chain}>
              <td className="whitespace-nowrap py-2.5 pr-4 font-medium">
                <ChainLabel chain={r.chain} />
              </td>
              <td className="py-2.5 pr-4 text-right font-mono tabular-nums">
                {formatUsd(r.volumeUsd)}
              </td>
              <td className="text-muted-foreground py-2.5 pr-4 text-right tabular-nums">
                {total === 0 ? '—' : formatPercent(r.volumeUsd / total)}
              </td>
              <td className="py-2.5 pr-4 text-right font-mono tabular-nums">
                {ngnPerUsd === null ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  formatNgn(r.volumeUsd * ngnPerUsd, true)
                )}
                {(ngn.get(r.chain) ?? 0) > 0 ? (
                  <span className="text-muted-foreground block text-xs">
                    {formatNgn(ngn.get(r.chain) ?? 0, true)} paid out
                  </span>
                ) : null}
              </td>
              <td className="py-1 pr-4">
                <Sparkline data={r.series} label={chainName(r.chain)} />
              </td>
              <td className="py-2.5 pr-4 text-right font-mono tabular-nums">
                {formatCount(r.transactions)}
                {r.failed > 0 ? (
                  <span className="text-muted-foreground block text-xs">
                    {formatCount(r.failed)} failed
                  </span>
                ) : null}
              </td>
              <td className="py-2.5 pr-4 text-right tabular-nums">
                {formatPercent(r.successRate)}
              </td>
              <td className="py-2.5 pr-4 text-right font-mono tabular-nums">
                {formatCount(r.wallets)}
              </td>
              <td className="py-2.5 text-right font-mono tabular-nums">
                {r.unknown === 0 ? (
                  <span className="text-muted-foreground">0</span>
                ) : (
                  <span className="text-warning">{formatCount(r.unknown)}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const MAX_TYPES = 6

/**
 * Chains down the side, types across the top, each cell the count and value. Shaded in one hue by
 * how busy the cell is, so the busiest corners stand out without a colour per type.
 */
export function TypeMatrix({ rows }: { rows: ChainTypeRow[] }): JSX.Element {
  const byType = new Map<string, number>()
  for (const r of rows) byType.set(r.type, (byType.get(r.type) ?? 0) + r.transactions)
  const ranked = [...byType.entries()].sort((a, b) => b[1] - a[1]).map(([type]) => type)
  const shown = ranked.slice(0, MAX_TYPES)
  const other = ranked.length > MAX_TYPES
  const columns = other ? [...shown, 'other'] : shown

  const perChain = new Map<string, number>()
  for (const r of rows) perChain.set(r.chain, (perChain.get(r.chain) ?? 0) + r.transactions)
  // Busiest first, as in the chain table above.
  const chains = [...perChain.entries()].sort((a, b) => b[1] - a[1]).map(([chain]) => chain)
  const cell = (chain: string, type: string): { transactions: number; volumeUsd: number } => {
    const match = rows.filter(
      (r) => r.chain === chain && (type === 'other' ? !shown.includes(r.type) : r.type === type)
    )
    return {
      transactions: match.reduce((t, r) => t + r.transactions, 0),
      volumeUsd: match.reduce((t, r) => t + r.volumeUsd, 0),
    }
  }
  const max = Math.max(1, ...chains.flatMap((c) => columns.map((t) => cell(c, t).transactions)))

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] table-fixed border-separate border-spacing-1 text-left text-sm">
        <thead className="text-muted-foreground">
          <tr>
            <th className="w-32 py-1 pr-3 font-normal" />
            {columns.map((t) => (
              <th key={t} className="px-2 py-1 text-right font-normal">
                {t === 'other' ? 'Other' : kindLabel(t)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {chains.map((chain) => (
            <tr key={chain}>
              <td className="whitespace-nowrap py-1 pr-3 font-medium">
                <ChainLabel chain={chain} />
              </td>
              {columns.map((t) => {
                const c = cell(chain, t)
                const share = c.transactions / max
                return (
                  <td
                    key={t}
                    className="rounded-md px-2 py-1.5 text-right tabular-nums"
                    style={{
                      background:
                        c.transactions === 0
                          ? undefined
                          : `color-mix(in srgb, ${SERIES[0]} ${Math.round(8 + share * 40)}%, transparent)`,
                    }}
                  >
                    {c.transactions === 0 ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <>
                        <span className="font-mono">{formatCount(c.transactions)}</span>
                        <span className="text-muted-foreground block text-xs">
                          {c.volumeUsd > 0 ? formatUsd(c.volumeUsd, true) : 'no value'}
                        </span>
                      </>
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** The apps transactions went through, on chains that record one. */
export function VenueTable({ rows }: { rows: VenueRow[] }): JSX.Element {
  return (
    <table className="w-full text-left text-sm">
      <thead className="text-muted-foreground">
        <tr>
          <th className="py-2 pr-4 font-normal">App</th>
          <th className="py-2 pr-4 font-normal">Chain</th>
          <th className="py-2 pr-4 text-right font-normal">Transactions</th>
          <th className="py-2 text-right font-normal">Volume</th>
        </tr>
      </thead>
      <tbody className="divide-border divide-y">
        {rows.map((r) => (
          <tr key={`${r.chain}:${r.venue}`}>
            <td className="py-2.5 pr-4">{venueLabel(r.venue)}</td>
            <td className="py-2.5 pr-4">
              <ChainLabel chain={r.chain} />
            </td>
            <td className="py-2.5 pr-4 text-right font-mono tabular-nums">
              {formatCount(r.transactions)}
            </td>
            <td className="py-2.5 text-right font-mono tabular-nums">
              {r.volumeUsd > 0 ? formatUsd(r.volumeUsd) : '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
