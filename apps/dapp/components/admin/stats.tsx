'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

import type {
  AgentsReport,
  IntentsReport,
  KindRow,
  Overview,
  PairRow,
  SeriesPoint,
  WaitlistCounts,
  WalletRow,
} from '../../lib/server/admin-metrics'

import { useScope } from './scope'

export interface Stats {
  overview: Overview
  series: SeriesPoint[]
  kinds: KindRow[]
  pairs: PairRow[]
  wallets: WalletRow[]
  agents: AgentsReport
  intents: IntentsReport
  waitlist: WaitlistCounts
}

interface StatsState {
  /** Null while loading, when the chain records nothing, or after a failure. */
  stats: Stats | null
  loading: boolean
  error: string | undefined
  /** False for a chain Intent does not record usage for. */
  tracked: boolean
  refresh: () => void
}

const Context = createContext<StatsState | undefined>(undefined)

const REFRESH_MS = 30_000

export function StatsProvider({ children }: { children: ReactNode }): JSX.Element {
  const { scope, range } = useScope()
  const [stats, setStats] = useState<Stats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>(undefined)
  const [tick, setTick] = useState(0)

  const network = scope.network
  const tracked = scope.chain === 'stellar' && network !== null

  useEffect(() => {
    setStats(null)
    setError(undefined)
    if (!tracked) {
      setLoading(false)
      return
    }
    setLoading(true)
    const controller = new AbortController()
    const get = async (view: string): Promise<Record<string, unknown>> => {
      const res = await fetch(
        `/api/admin/metrics?view=${view}&chain=stellar&network=${network}&range=${range}`,
        { signal: controller.signal }
      )
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? 'unavailable')
      }
      return (await res.json()) as Record<string, unknown>
    }
    Promise.all(['overview', 'wallets', 'agents', 'intents', 'waitlist'].map(get))
      .then(([overview, wallets, agents, intents, waitlist]) => {
        const o = overview as unknown as Pick<Stats, 'overview' | 'series' | 'kinds' | 'pairs'>
        setStats({
          overview: o.overview,
          series: o.series,
          kinds: o.kinds,
          pairs: o.pairs,
          wallets: (wallets as unknown as Pick<Stats, 'wallets'>).wallets,
          agents: (agents as unknown as { agents: AgentsReport }).agents,
          intents: (intents as unknown as { intents: IntentsReport }).intents,
          waitlist: (waitlist as unknown as { waitlist: WaitlistCounts }).waitlist,
        })
      })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === 'AbortError') return
        setError(
          e instanceof Error && e.message === 'no_database'
            ? 'No database is connected, so there is nothing to count yet.'
            : 'The numbers could not be loaded. Try again in a moment.'
        )
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [network, range, tracked, tick])

  useEffect(() => {
    if (!tracked) return
    const id = setInterval(() => setTick((t) => t + 1), REFRESH_MS)
    return () => clearInterval(id)
  }, [tracked])

  const refresh = useCallback(() => setTick((t) => t + 1), [])
  const value = useMemo(
    () => ({ stats, loading, error, tracked, refresh }),
    [stats, loading, error, tracked, refresh]
  )
  return <Context.Provider value={value}>{children}</Context.Provider>
}

export function useStats(): StatsState {
  const value = useContext(Context)
  if (value === undefined) throw new Error('useStats must be used inside the admin shell')
  return value
}

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})
const usdCompact = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1,
})

export function formatUsd(value: number, compact = false): string {
  return compact && Math.abs(value) >= 10_000 ? usdCompact.format(value) : usd.format(value)
}

export function formatCount(value: number): string {
  return value.toLocaleString('en-US')
}

export function formatPercent(value: number | null): string {
  return value === null ? 'No data' : `${Math.round(value * 100)}%`
}

export const KIND_LABELS: Record<string, string> = {
  swap: 'Swaps',
  plan: 'Standing orders',
  offer: 'Limit orders',
  send: 'Sends',
  lend: 'Lending',
  offramp: 'Cash-outs',
  perp: 'Perpetuals',
}

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind
}

export function shortAddress(value: string): string {
  return value.length > 12 ? `${value.slice(0, 5)}…${value.slice(-5)}` : value
}
