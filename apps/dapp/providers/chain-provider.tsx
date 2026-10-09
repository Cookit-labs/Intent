'use client'

import {
  defaultNetwork,
  isMultiNetwork,
  parseChainSegment,
  setClientNetwork,
  type StellarNetworkName,
} from '@intent/config'
import type { ChainDescriptor, ChainSlug } from '@intent/types'
import { createContext, useContext, useMemo } from 'react'

import { installNetworkFetch } from '../lib/api/network-fetch'
import type { ChainAdapter } from '../lib/chain-adapter'
import { arcAdapter } from '../lib/adapters/arc-adapter'
import { stellarAdapterFor } from '../lib/adapters/stellar-adapter'

interface ChainContextValue {
  /** The chain family: `arc` or `stellar`. Never carries the network. */
  slug: ChainSlug
  /** The Stellar network of this page. Absent on Arc. */
  network: StellarNetworkName | undefined
  /** The path segment this page is under, to build links that stay on it. */
  segment: string
  descriptor: ChainDescriptor
  adapter: ChainAdapter
}

const ChainContext = createContext<ChainContextValue | undefined>(undefined)

export function ChainProvider({
  segment,
  children,
}: {
  /** The first path segment, already checked by the layout. */
  segment: string
  children: React.ReactNode
}): JSX.Element {
  const route = parseChainSegment(segment)
  if (route === undefined) throw new Error(`Unknown chain segment "${segment}"`)

  const network: StellarNetworkName | undefined =
    route.slug === 'stellar' ? (route.network ?? defaultNetwork()) : undefined

  // The browser has one network per page, fixed by the address. Set while
  // rendering, before any child reads it, and only in the browser: on the
  // server renders overlap, and a shared variable would leak between requests.
  if (typeof window !== 'undefined') {
    setClientNetwork(network ?? defaultNetwork())
    if (isMultiNetwork()) installNetworkFetch(network ?? defaultNetwork())
  }

  const value = useMemo<ChainContextValue>(() => {
    const adapter =
      route.slug === 'arc' ? arcAdapter : stellarAdapterFor(network as StellarNetworkName)
    return { slug: route.slug, network, segment, descriptor: adapter.descriptor, adapter }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segment])

  return <ChainContext.Provider value={value}>{children}</ChainContext.Provider>
}

export function useChain(): ChainContextValue {
  const ctx = useContext(ChainContext)
  if (ctx === undefined) {
    throw new Error('useChain must be used inside a ChainProvider (routes live under /[chain])')
  }
  return ctx
}

/** Chain-relative href builder, so nav never hardcodes a chain or drops the network. */
export function useChainHref(): (path: string) => string {
  const { segment } = useChain()
  return (path: string) => `/${segment}${path}`
}
