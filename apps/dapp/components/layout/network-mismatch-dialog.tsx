'use client'

import {
  chainSegment,
  enabledNetworks,
  isMultiNetwork,
  type StellarNetworkName,
} from '@intent/config'
import { Button } from '@intent/ui'
import { Wallet } from 'lucide-react'
import Image from 'next/image'
import { usePathname } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'

import { useWallet } from '../../hooks/use-wallet'
import { mismatchPrompt, switchSteps } from '../../lib/wallet-network'
import { useChain } from '../../providers/chain-provider'

/**
 * What a person sees when their wallet is on the other Stellar network than
 * the page. Presentational: the connector below decides when to show it.
 *
 * An app cannot change the network inside a wallet, so this says exactly what
 * to do and where, and offers the other way out: use the network the wallet is
 * already on. It closes by itself the moment the wallet is switched, because
 * whatever shows it stops being true.
 */
export function NetworkMismatchView({
  selected,
  wallet,
  walletName,
  walletIcon,
  canUseWalletNetwork,
  onUseWalletNetwork,
  onDismiss,
}: {
  selected: StellarNetworkName
  wallet: StellarNetworkName
  walletName: string | undefined
  walletIcon: string | undefined
  canUseWalletNetwork: boolean
  onUseWalletNetwork: () => void
  onDismiss: () => void
}): JSX.Element {
  const prompt = mismatchPrompt(selected, wallet)
  const primary = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    primary.current?.focus()
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onDismiss()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onDismiss])

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="bg-background/70 absolute inset-0 backdrop-blur-sm" aria-hidden="true" />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="network-mismatch-title"
        aria-describedby="network-mismatch-body"
        className="border-border bg-background relative w-full max-w-sm rounded-xl border p-6 shadow-lg"
      >
        <span className="bg-muted flex h-10 w-10 items-center justify-center rounded-full">
          {walletIcon !== undefined ? (
            <Image
              src={walletIcon}
              alt=""
              width={22}
              height={22}
              unoptimized
              className="h-[22px] w-[22px]"
            />
          ) : (
            <Wallet className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
          )}
        </span>

        <h2 id="network-mismatch-title" className="font-display mt-4 text-lg font-semibold">
          {prompt.title}
        </h2>
        <p
          id="network-mismatch-body"
          className="text-muted-foreground mt-1.5 text-sm leading-relaxed"
        >
          {prompt.body}
        </p>

        <p className="bg-muted/60 mt-4 rounded-md px-3 py-2.5 text-sm leading-relaxed">
          {switchSteps(walletName, selected)}
        </p>

        <p className="text-muted-foreground mt-3 flex items-center gap-2 text-xs" role="status">
          <span className="bg-warning inline-block h-1.5 w-1.5 rounded-full motion-safe:animate-pulse" />
          Waiting for your wallet to switch. This closes by itself.
        </p>

        <div className="mt-5 flex flex-col gap-2 sm:flex-row-reverse">
          {canUseWalletNetwork ? (
            <Button ref={primary} onClick={onUseWalletNetwork} className="sm:flex-1">
              {prompt.useWalletNetworkLabel}
            </Button>
          ) : null}
          <Button variant="outline" onClick={onDismiss} className="sm:flex-1">
            Not now
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * Shows the prompt when several networks are served, a Stellar wallet is
 * connected, and the wallet reports a different network than the page.
 * "Not now" hides it until the pair of networks changes; signing stays refused
 * the whole time.
 */
export function NetworkMismatchDialog(): JSX.Element | null {
  const { slug, network } = useChain()
  const { isConnected, isWrongNetwork, walletNetwork, walletName, walletIcon } = useWallet()
  const pathname = usePathname()
  const [dismissedFor, setDismissedFor] = useState<string | undefined>(undefined)

  if (
    !isMultiNetwork() ||
    slug !== 'stellar' ||
    network === undefined ||
    !isConnected ||
    !isWrongNetwork ||
    walletNetwork === undefined
  ) {
    return null
  }

  const pair = `${network}:${walletNetwork}`
  if (dismissedFor === pair) return null

  const canUse = enabledNetworks().includes(walletNetwork)

  function useWalletNetwork(): void {
    const rest = pathname.split('/').slice(2).join('/')
    const segment = chainSegment('stellar', walletNetwork)
    // A full load, as everywhere else a network changes.
    window.location.assign(`/${segment}${rest === '' ? '/intents' : `/${rest}`}`)
  }

  return (
    <NetworkMismatchView
      selected={network}
      wallet={walletNetwork}
      walletName={walletName}
      walletIcon={walletIcon}
      canUseWalletNetwork={canUse}
      onUseWalletNetwork={useWalletNetwork}
      onDismiss={() => setDismissedFor(pair)}
    />
  )
}
