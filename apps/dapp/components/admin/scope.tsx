'use client'

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

export type AdminNetwork = 'mainnet' | 'testnet'
export type AdminRange = '7d' | '30d' | '90d' | 'all'
export type AdminChainId = 'stellar' | 'arc' | 'solana' | 'avalanche'

export interface ScopeOption {
  key: string
  chain: AdminChainId
  network: AdminNetwork | null
  name: string
  label: string
  /** Whether Intent records usage for it yet. Planned chains are listed but not selectable. */
  available: boolean
}

export const SCOPES: readonly ScopeOption[] = [
  {
    key: 'stellar-mainnet',
    chain: 'stellar',
    network: 'mainnet',
    name: 'Stellar',
    label: 'Mainnet',
    available: true,
  },
  {
    key: 'stellar-testnet',
    chain: 'stellar',
    network: 'testnet',
    name: 'Stellar',
    label: 'Testnet',
    available: true,
  },
  { key: 'arc', chain: 'arc', network: null, name: 'Arc', label: 'Testnet', available: true },
  {
    key: 'solana',
    chain: 'solana',
    network: null,
    name: 'Solana',
    label: 'Coming soon',
    available: false,
  },
  {
    key: 'avalanche',
    chain: 'avalanche',
    network: null,
    name: 'Avalanche',
    label: 'Coming soon',
    available: false,
  },
]

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

const STORAGE = 'intent-admin-scope'

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
  const [key, setKey] = useState('stellar-mainnet')
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
