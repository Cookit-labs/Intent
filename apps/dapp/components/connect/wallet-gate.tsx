'use client'

import { homeSegment, isMultiNetwork, parseChainSegment } from '@intent/config'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useRef, useState, type ReactNode } from 'react'

import { useGoToChain } from '../../hooks/use-go-to-chain'
import { useWallet } from '../../hooks/use-wallet'
import { forgetChain, rememberChain } from '../../lib/wallet/chain-cookie'
import { connectAddress } from '../../lib/wallet/chain-path'
import { useChain } from '../../providers/chain-provider'
import { ConnectPage } from './connect-page'

/**
 * How long "not connected" must stand before it is acted on. wagmi only starts
 * reconnecting a moment after mounting, and without this a returning visitor
 * would be sent away before their own wallet comes back.
 */
const SETTLE_MS = 250

/**
 * The app is reachable only with a wallet connected on the chain in the address.
 * Without one, the visitor goes to the connect page at the bare address, which
 * brings them back to the screen they asked for.
 *
 * This decides what renders, not what is allowed: wallets live in the browser,
 * so no server can check one here. API routes keep their own checks.
 */
export function WalletGate({
  children,
  bypass = false,
}: {
  children: ReactNode
  bypass?: boolean
}): JSX.Element {
  const { segment, slug, network } = useChain()
  const { isConnected, isRestoring } = useWallet()
  const pathname = usePathname()
  const router = useRouter()
  const [settled, setSettled] = useState(false)
  const wasConnected = useRef(false)
  if (isConnected) wasConnected.current = true

  // The bare address connects Stellar on the network the app opens on. On the
  // other one, the address is the only thing saying which network was chosen,
  // so the connect page stays here rather than losing that.
  const onOtherStellarNetwork =
    slug === 'stellar' &&
    isMultiNetwork() &&
    network !== undefined &&
    network !== parseChainSegment(homeSegment())?.network

  const waiting = !settled || isRestoring === true

  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(true), SETTLE_MS)
    return () => window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (isConnected) rememberChain(segment)
  }, [isConnected, segment])

  useEffect(() => {
    if (isConnected || bypass || waiting || onOtherStellarNetwork) return
    // Forgotten first, or the bare address would send them straight back here.
    forgetChain()
    router.replace(wasConnected.current ? '/' : connectAddress(pathname, window.location.search))
  }, [isConnected, bypass, waiting, onOtherStellarNetwork, pathname, router])

  if (isConnected || bypass) return <>{children}</>
  if (!waiting && onOtherStellarNetwork) return <ConnectHere />
  return <div className="app-canvas h-screen" />
}

function ConnectHere(): JSX.Element {
  const goToChain = useGoToChain()
  return <ConnectPage onConnected={goToChain} />
}
