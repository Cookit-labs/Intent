'use client'

import {
  chainSegment,
  defaultNetwork,
  homeSegment,
  isMultiNetwork,
  parseChainSegment,
  setClientNetwork,
} from '@intent/config'
import type { ChainSlug } from '@intent/types'
import dynamic from 'next/dynamic'
import { useRouter, useSearchParams } from 'next/navigation'

import { installPageFetch } from '../../lib/api/network-fetch'
import { rememberChain } from '../../lib/wallet/chain-cookie'
import { screenAfterConnect } from '../../lib/wallet/chain-path'

/** Browser only: the page reads the window to decide whether the slides fit. */
const ConnectPage = dynamic(() => import('./connect-page').then((m) => m.ConnectPage), {
  ssr: false,
  loading: () => <div className="app-canvas h-screen" />,
})

/**
 * The bare address of the app, before a chain has been picked.
 *
 * There is no chain in the URL yet, so nothing has told the app which Stellar
 * network a Stellar wallet would connect to. It is the one the app opens on,
 * which keeps the wallet's session under the network it then lands on.
 */
export function ConnectHome(): JSX.Element {
  const router = useRouter()
  const next = useSearchParams().get('next')

  const stellarHome = homeSegment()
  const network = parseChainSegment(stellarHome)?.network ?? defaultNetwork()
  if (typeof window !== 'undefined') {
    setClientNetwork(network)
    installPageFetch(network)
  }

  function onConnected(slug: ChainSlug): void {
    const segment = slug === 'stellar' ? stellarHome : chainSegment(slug)
    rememberChain(segment)
    const href = `/${segment}${screenAfterConnect(next)}`
    // A full load into Stellar when several networks are served: the network
    // decides what every cached call means, and none of it should carry across.
    if (slug === 'stellar' && isMultiNetwork()) window.location.assign(href)
    else router.push(href)
  }

  return <ConnectPage onConnected={onConnected} />
}
