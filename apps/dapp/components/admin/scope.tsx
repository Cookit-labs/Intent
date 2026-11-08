'use client'

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

export type AdminNetwork = 'mainnet' | 'testnet'
export type AdminRange = '7d' | '30d' | '90d' | 'all'
export type AdminChainId =
  | 'all'
  | 'stellar'
  | 'arc'
  | 'solana'
  | 'sui'
  | 'near'
  | 'avalanche'
  | 'monad'

export interface ScopeOption {
  key: string
  chain: AdminChainId
  network: AdminNetwork | null
  name: string
  label: string
  /** Whether it can be chosen. */
  available: boolean
  /** Whether Intent records usage for it. */
  tracked: boolean
}

/** Every chain but Stellar runs on mainnet only, so all of them together is mainnet too. */
const mainnet = (chain: AdminChainId, name: string): ScopeOption => ({
  key: chain,
  chain,
  network: 'mainnet',
  name,
  label: 'Mainnet',
  available: true,
  tracked: true,
})

export const SCOPES: readonly ScopeOption[] = [
  mainnet('all', 'All chains'),
  { ...mainnet('stellar', 'Stellar'), key: 'stellar-mainnet' },
  {
    key: 'stellar-testnet',
    chain: 'stellar',
    network: 'testnet',
    name: 'Stellar',
    label: 'Testnet',
    available: true,
    tracked: true,
  },
  mainnet('solana', 'Solana'),
  mainnet('sui', 'Sui'),
  mainnet('near', 'NEAR'),
  mainnet('avalanche', 'Avalanche'),
  mainnet('monad', 'Monad'),
  {
    key: 'arc',
    chain: 'arc',
    network: null,
    name: 'Arc',
    label: 'Testnet',
    available: true,
    tracked: false,
  },
]

/** The query that asks the metrics route for this scope, or nothing for one Intent does not record. */
export function scopeQuery(scope: ScopeOption): string | undefined {
  if (!scope.tracked || scope.network === null) return undefined
  return `chain=${scope.chain}&network=${scope.network}`
}

export const RANGE_OPTIONS: { value: AdminRange; label: string }[] = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: 'all', label: 'All time' },
]

interface ScopeState {
  scope: ScopeOption
  setScopeKey: (key: string) => void
  range: AdminRange
  setRange: (range: AdminRange) => void
}

// Renamed when all chains became the default, so an earlier saved choice does not hide it.
const STORAGE = 'intent-admin-scope-v2'

const Context = createContext<ScopeState | undefined>(undefined)

function read(): { key?: string; range?: AdminRange } {
  try {
    return JSON.parse(window.localStorage.getItem(STORAGE) ?? '{}') as {
      key?: string
      range?: AdminRange
    }
  } catch {
    return {}
  }
}

export function ScopeProvider({ children }: { children: ReactNode }): JSX.Element {
  const [key, setKey] = useState('all')
  const [range, setRange] = useState<AdminRange>('30d')

  useEffect(() => {
    const saved = read()
    if (saved.key !== undefined && SCOPES.some((s) => s.key === saved.key && s.available)) {
      setKey(saved.key)
    }
    if (saved.range !== undefined && RANGE_OPTIONS.some((r) => r.value === saved.range)) {
      setRange(saved.range)
    }
  }, [])

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE, JSON.stringify({ key, range }))
    } catch {
      // Remembering the choice is a convenience; the page works without it.
    }
  }, [key, range])

  const value = useMemo<ScopeState>(
    () => ({
      scope: SCOPES.find((s) => s.key === key) ?? (SCOPES[0] as ScopeOption),
      setScopeKey: (next) => {
        if (SCOPES.some((s) => s.key === next && s.available)) setKey(next)
      },
      range,
      setRange,
    }),
    [key, range]
  )

  return <Context.Provider value={value}>{children}</Context.Provider>
}

export function useScope(): ScopeState {
  const value = useContext(Context)
  if (value === undefined) throw new Error('useScope must be used inside the admin shell')
  return value
}
