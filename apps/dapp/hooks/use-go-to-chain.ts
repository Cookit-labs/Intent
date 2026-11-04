'use client'

import { chainSegment, isMultiNetwork } from '@intent/config'
import type { ChainSlug } from '@intent/types'
import { usePathname, useRouter } from 'next/navigation'

import { rememberChain } from '../lib/wallet/chain-cookie'
import { pathUnderChain } from '../lib/wallet/chain-path'
import { useChain } from '../providers/chain-provider'

/**
 * Moves to a chain that has a connected wallet, staying on the same screen, and
 * remembers it as where the app opens next time.
 */
export function useGoToChain(): (slug: ChainSlug) => void {
  const { segment: current } = useChain()
  const pathname = usePathname()
  const router = useRouter()

  return (slug) => {
    const segment = chainSegment(slug)
    rememberChain(segment)
    if (segment === current) return
    const href = `${pathUnderChain(pathname, segment)}${window.location.search}`
    // A full load into Stellar when several networks are served: the network
    // decides what every cached call means, and none of it should carry across.
    if (slug === 'stellar' && isMultiNetwork()) window.location.assign(href)
    else router.push(href)
  }
}
