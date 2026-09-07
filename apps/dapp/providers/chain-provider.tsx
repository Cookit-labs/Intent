'use client'

import type { ChainDescriptor, ChainSlug } from '@intent/types'
import { createContext, useContext, useMemo } from 'react'

import type { ChainAdapter } from '../lib/chain-adapter'
import { arcAdapter } from '../lib/adapters/arc-adapter'
import { stellarAdapter } from '../lib/adapters/stellar-adapter'

const ADAPTERS: Record<ChainSlug, ChainAdapter> = {
  arc: arcAdapter,
  stellar: stellarAdapter,
}

interface ChainContextValue {
  slug: ChainSlug
  descriptor: ChainDescriptor
  adapter: ChainAdapter
}

const ChainContext = createContext<ChainContextValue | undefined>(undefined)

export function ChainProvider({
  slug,
  children,
}: {
  slug: ChainSlug
  children: React.ReactNode
}): JSX.Element {
  const value = useMemo<ChainContextValue>(() => {
    const adapter = ADAPTERS[slug]
    return { slug, descriptor: adapter.descriptor, adapter }
  }, [slug])

  return <ChainContext.Provider value={value}>{children}</ChainContext.Provider>
}

export function useChain(): ChainContextValue {
  const ctx = useContext(ChainContext)
  if (ctx === undefined) {
    throw new Error('useChain must be used inside a ChainProvider (routes live under /[chain])')
  }
  return ctx
}

/** Chain-relative href builder, so nav never hardcodes a chain. */
export function useChainHref(): (path: string) => string {
  const { slug } = useChain()
  return (path: string) => `/${slug}${path}`
}
