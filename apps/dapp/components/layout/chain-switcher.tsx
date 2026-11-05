'use client'

import {
  CHAIN_DESCRIPTORS,
  CONNECT_CHAINS,
  activeNetwork,
  chainSegment,
  enabledNetworks,
  isMultiNetwork,
  stellarDescriptorFor,
  type StellarNetworkName,
} from '@intent/config'
import type { ChainSlug } from '@intent/types'
import { ChainMark } from '@intent/ui'
import { cn } from '@intent/ui'
import { ArrowUpRight, Check, ChevronDown } from 'lucide-react'
import { usePathname } from 'next/navigation'
import { useEffect, useRef, useState, type ReactNode } from 'react'

import { useGoToChain } from '../../hooks/use-go-to-chain'
import { chainTitle } from '../../lib/chain-title'
import { otherStellarNetwork } from '../../lib/other-stellar-network'
import { pathUnderChain } from '../../lib/wallet/chain-path'
import { connectorFor } from '../../lib/wallet/connectors'
import { useWallet } from '../../hooks/use-wallet'
import { ConnectDialog } from '../connect/connect-dialog'
import { useChain } from '../../providers/chain-provider'

/**
 * Switches chain, and Stellar network, while staying on the same screen.
 *
 * The chain and the network live in the first path segment, so switching is a
 * path rewrite: `/arc/vault` becomes `/stellar-mainnet/vault`. Rewriting
 * rather than navigating home means the user keeps their place, which is the
 * whole point of the control.
 *
 * With several Stellar networks served, each is its own entry, and choosing
 * one loads the page afresh. A full load is deliberate: the network decides
 * what the wallet session, the cached data and every API call mean, and none
 * of it should carry across from the other network.
 */
interface Entry {
  key: string
  segment: string
  slug: ChainSlug
  network?: StellarNetworkName
  name: string
  label: string
}

/** One entry per place a user can be, when several networks are served. */
function entriesFor(): Entry[] {
  const out: Entry[] = []
  for (const option of CONNECT_CHAINS) {
    if (option !== 'stellar') {
      const d = CHAIN_DESCRIPTORS[option]
      out.push({ key: option, segment: option, slug: option, name: d.name, label: d.networkLabel })
      continue
    }
    for (const network of enabledNetworks()) {
      const d = stellarDescriptorFor(network)
      out.push({
        key: `stellar-${network}`,
        segment: chainSegment('stellar', network),
        slug: 'stellar',
        network,
        name: d.name,
        label: d.networkLabel,
      })
    }
  }
  return out
}

export function ChainSwitcher({
  caption,
}: {
  /** A line under the pill. The menu opens below it. */
  caption?: ReactNode
} = {}): JSX.Element {
  const { slug, network, descriptor } = useChain()
  const pathname = usePathname()
  const goToChain = useGoToChain()
  const [open, setOpen] = useState(false)
  const [connecting, setConnecting] = useState<ChainSlug | undefined>(undefined)
  const rootRef = useRef<HTMLDivElement>(null)
  const multi = isMultiNetwork()
  const { isConnected } = useWallet()

  // With one network served, the other is its own deployment, reached by a
  // link. Read as a literal so it is inlined at build.
  const other = otherStellarNetwork(
    activeNetwork(),
    process.env.NEXT_PUBLIC_STELLAR_OTHER_NETWORK_URL,
    slug === 'stellar' ? pathname : '/stellar/intents'
  )

  useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent): void {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  function switchTo(entry: Entry): void {
    setOpen(false)
    const active = entry.slug === slug && entry.network === network
    if (active) return
    if (entry.slug !== 'stellar') {
      switchChain(entry.slug)
      return
    }
    // A full load, so nothing from the other network is carried into this one.
    window.location.assign(pathUnderChain(pathname, entry.segment))
  }

  function switchChain(next: ChainSlug): void {
    setOpen(false)
    if (next === slug) return
    if (connectorFor(next).isConnected()) goToChain(next)
    else setConnecting(next)
  }

  const rowClass = (active: boolean): string =>
    `flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors ${
      active ? 'bg-muted font-medium' : 'hover:bg-muted/60'
    }`

  return (
    <div ref={rootRef} className="relative flex flex-col items-start gap-0.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Chain: ${descriptor.networkLabel}. Switch chain`}
        className={cn(
          'hover:bg-muted/60 inline-flex items-center gap-2 rounded-full py-1.5 pl-1.5 pr-2.5 text-sm font-semibold transition-colors',
          open && 'bg-muted/60'
        )}
      >
        <span className="relative">
          <ChainMark chain={slug} className="h-6 w-6" />
          <span
            className={cn(
              'ring-background absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2',
              isConnected ? 'bg-success' : 'bg-muted-foreground/60'
            )}
            title={isConnected ? 'Wallet connected' : 'No wallet connected'}
          />
        </span>
        {chainTitle(descriptor.name, descriptor.networkLabel)}
        <ChevronDown
          className={cn(
            'text-muted-foreground h-3.5 w-3.5 transition-transform',
            open && 'rotate-180'
          )}
        />
      </button>
      {caption}

      {open ? (
        <div
          role="menu"
          aria-label="Choose a chain"
          className="border-border bg-card absolute left-0 top-full z-50 mt-2 w-64 rounded-2xl border p-1.5 shadow-xl"
        >
          <p className="text-muted-foreground px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider">
            Network
          </p>
          {multi
            ? entriesFor().map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  role="menuitem"
                  onClick={() => switchTo(entry)}
                  aria-label={entry.label}
                  className={rowClass(entry.slug === slug && entry.network === network)}
                >
                  <ChainMark chain={entry.slug} className="h-7 w-7 shrink-0" />
                  <span className="flex-1">{chainTitle(entry.name, entry.label)}</span>
                  {entry.slug === slug && entry.network === network ? (
                    <Check className="text-brand h-4 w-4" />
                  ) : null}
                </button>
              ))
            : CONNECT_CHAINS.map((option) => {
                const d = CHAIN_DESCRIPTORS[option]
                return (
                  <button
                    key={option}
                    type="button"
                    role="menuitem"
                    onClick={() => switchChain(option)}
                    aria-label={d.networkLabel}
                    className={rowClass(option === slug)}
                  >
                    <ChainMark chain={option} className="h-7 w-7 shrink-0" />
                    <span className="flex-1">{chainTitle(d.name, d.networkLabel)}</span>
                    {option === slug ? <Check className="text-brand h-4 w-4" /> : null}
                  </button>
                )
              })}

          {!multi && other.href !== undefined ? (
            <a
              href={other.href}
              role="menuitem"
              aria-label={`Stellar ${other.label.replace(/^stellar\s+/i, '')}`}
              className="hover:bg-muted/60 flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors"
            >
              <ChainMark chain="stellar" className="h-7 w-7 shrink-0" />
              <span className="flex-1">{chainTitle('Stellar', other.label)}</span>
              <ArrowUpRight className="text-muted-foreground ml-auto h-3.5 w-3.5" />
            </a>
          ) : null}
        </div>
      ) : null}
      {connecting !== undefined ? (
        <ConnectDialog
          initialChain={connecting}
          onConnected={(next) => {
            setConnecting(undefined)
            goToChain(next)
          }}
          onClose={() => setConnecting(undefined)}
        />
      ) : null}
    </div>
  )
}
