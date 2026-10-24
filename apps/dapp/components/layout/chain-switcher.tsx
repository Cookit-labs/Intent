'use client'

import {
  CHAIN_DESCRIPTORS,
  CHAIN_ORDER,
  activeNetwork,
  chainSegment,
  enabledNetworks,
  isMultiNetwork,
  stellarDescriptorFor,
  type StellarNetworkName,
} from '@intent/config'
import type { ChainSlug } from '@intent/types'
import { ChainMark, type ChainLogoId } from '@intent/ui'
import { cn } from '@intent/ui'
import { ArrowUpRight, Check, ChevronDown } from 'lucide-react'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'

import { otherStellarNetwork } from '../../lib/other-stellar-network'
import { useWallet } from '../../hooks/use-wallet'
import { useChain } from '../../providers/chain-provider'

/**
 * The network as a short tag beside the chain's name. Testnet is amber so it
 * cannot be mistaken for the network that moves real money.
 */
function NetworkTag({ label, className }: { label: string; className?: string }): JSX.Element {
  const test = /test/i.test(label)
  const short = label.replace(/^(stellar|arc)\s+/i, '')
  return (
    <span
      className={cn(
        'rounded-full px-2 py-0.5 text-[11px] font-medium capitalize',
        test ? 'bg-warning/15 text-warning' : 'bg-bubble-me text-bubble-me-foreground',
        className
      )}
    >
      {short}
    </span>
  )
}

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
/** Planned, not built. Listed so the roadmap is visible; never selectable. */
const COMING_SOON: { id: ChainLogoId; name: string }[] = [
  { id: 'solana', name: 'Solana' },
  { id: 'avalanche', name: 'Avalanche' },
]

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
  for (const option of CHAIN_ORDER) {
    if (option === 'arc') {
      const d = CHAIN_DESCRIPTORS.arc
      out.push({ key: 'arc', segment: 'arc', slug: 'arc', name: d.name, label: d.networkLabel })
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

export function ChainSwitcher(): JSX.Element {
  const { slug, network, descriptor } = useChain()
  const router = useRouter()
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
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

  /** The same screen under another segment; everything deeper is chain-independent. */
  function pathUnder(segment: string): string {
    const rest = pathname.split('/').slice(2).join('/')
    return `/${segment}${rest === '' ? '/intents' : `/${rest}`}`
  }

  function switchTo(entry: Entry): void {
    setOpen(false)
    const active = entry.slug === slug && entry.network === network
    if (active) return
    // A full load, so nothing from the other network is carried into this one.
    window.location.assign(pathUnder(entry.segment))
  }

  function switchChain(next: string): void {
    setOpen(false)
    if (next === slug) return
    router.push(pathUnder(next))
  }

  const rowClass = (active: boolean): string =>
    `flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors ${
      active ? 'bg-muted font-medium' : 'hover:bg-muted/60'
    }`

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Chain: ${descriptor.name}. Switch chain`}
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
        {descriptor.name}
        <NetworkTag label={descriptor.networkLabel} />
        <ChevronDown
          className={cn(
            'text-muted-foreground h-3.5 w-3.5 transition-transform',
            open && 'rotate-180'
          )}
        />
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Choose a chain"
          className="border-border bg-card absolute left-0 z-50 mt-2 w-64 rounded-2xl border p-1.5 shadow-xl"
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
                  className={rowClass(entry.slug === slug && entry.network === network)}
                >
                  <ChainMark chain={entry.slug} className="h-7 w-7 shrink-0" />
                  <span className="flex flex-1 items-center gap-2">
                    {entry.name}
                    <NetworkTag label={entry.label} />
                  </span>
                  {entry.slug === slug && entry.network === network ? (
                    <Check className="text-brand h-4 w-4" />
                  ) : null}
                </button>
              ))
            : CHAIN_ORDER.map((option) => {
                const d = CHAIN_DESCRIPTORS[option]
                return (
                  <button
                    key={option}
                    type="button"
                    role="menuitem"
                    onClick={() => switchChain(option)}
                    className={rowClass(option === slug)}
                  >
                    <ChainMark chain={option} className="h-7 w-7 shrink-0" />
                    <span className="flex flex-1 items-center gap-2">
                      {d.name}
                      <NetworkTag label={d.networkLabel} />
                    </span>
                    {option === slug ? <Check className="text-brand h-4 w-4" /> : null}
                  </button>
                )
              })}

          {!multi && other.href !== undefined ? (
            <a
              href={other.href}
              role="menuitem"
              className="hover:bg-muted/60 flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors"
            >
              <ChainMark chain="stellar" className="h-7 w-7 shrink-0" />
              <span className="flex flex-1 items-center gap-2">
                Stellar
                <NetworkTag label={other.label} />
              </span>
              <ArrowUpRight className="text-muted-foreground ml-auto h-3.5 w-3.5" />
            </a>
          ) : null}
          {!multi && other.href === undefined ? (
            <div
              role="menuitem"
              aria-disabled="true"
              className="text-muted-foreground flex w-full cursor-not-allowed items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm"
            >
              <ChainMark chain="stellar" className="h-7 w-7 shrink-0 opacity-60" />
              <span className="flex flex-col leading-tight">
                <span>Stellar</span>
                <span className="text-xs">{other.label} · not set up here</span>
              </span>
            </div>
          ) : null}

          <p className="text-muted-foreground px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider">
            Coming soon
          </p>
          {COMING_SOON.map((c) => (
            <div
              key={c.id}
              role="menuitem"
              aria-disabled="true"
              className="text-muted-foreground flex w-full cursor-not-allowed items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm"
            >
              <ChainMark chain={c.id} className="h-7 w-7 shrink-0 opacity-60 grayscale" />
              <span>{c.name}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
