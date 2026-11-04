'use client'

import { CHAIN_DESCRIPTORS, CONNECT_CHAINS } from '@intent/config'
import type { ChainSlug } from '@intent/types'
import { Button, ChainMark, cn } from '@intent/ui'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, ArrowUpRight, Loader2, Wallet, X } from 'lucide-react'
import Image from 'next/image'
import { useEffect, useRef, useState, type ReactNode } from 'react'

import { isUserRejection, type WalletOption } from '../../lib/wallet/connector'
import { connectorFor } from '../../lib/wallet/connectors'
import { walletErrorMessage } from '../../lib/wallet/error-message'

const rowClass =
  'hover:bg-muted/60 focus-visible:ring-ring flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2'

/**
 * Connecting, in two steps: pick a chain, then pick a wallet on that chain. It
 * looks the same on every chain, because the wallet list is ours and each chain's
 * library only supplies the data and the connect call.
 *
 * A chain that already has a wallet connected skips the list, since there is
 * nothing left to ask.
 */
export function ConnectSteps({
  initialChain,
  onConnected,
  onBack,
  trailing,
}: {
  /** Opens directly on this chain's wallets, as the chain switcher does. */
  initialChain?: ChainSlug | undefined
  onConnected: (slug: ChainSlug) => void
  /** Where the back arrow goes from the chain step. Without it, that step has no arrow. */
  onBack?: (() => void) | undefined
  /** Beside the title, such as a dialog's close button. */
  trailing?: ReactNode
}): JSX.Element {
  const [chain, setChain] = useState<ChainSlug | undefined>(initialChain)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    root.current?.querySelector<HTMLElement>('button:not([aria-label="Close"]), a')?.focus()
  }, [chain])

  function pick(slug: ChainSlug): void {
    if (connectorFor(slug).isConnected()) onConnected(slug)
    else setChain(slug)
  }

  const title =
    chain === undefined ? 'Choose a chain' : `Connect to ${CHAIN_DESCRIPTORS[chain].name}`
  const back = chain !== undefined ? () => setChain(undefined) : onBack

  return (
    <div ref={root} role="group" aria-label={title} data-connect-steps className="text-left">
      <div className="mb-3 flex items-center gap-2">
        {back !== undefined ? (
          <button
            type="button"
            onClick={back}
            aria-label={chain !== undefined ? 'Choose another chain' : 'Back'}
            className="text-muted-foreground hover:text-foreground hover:bg-muted/60 -ml-1 flex h-8 w-8 items-center justify-center rounded-md transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
        ) : null}
        <h2 className="font-display flex-1 text-base font-semibold">{title}</h2>
        {trailing}
      </div>

      {chain === undefined ? (
        <ChainGrid onPick={pick} />
      ) : (
        <WalletList key={chain} chain={chain} onConnected={() => onConnected(chain)} />
      )}
    </div>
  )
}

/** The steps over the app, for moving to a chain without leaving the screen. */
export function ConnectDialog({
  initialChain,
  onConnected,
  onClose,
}: {
  initialChain?: ChainSlug | undefined
  onConnected: (slug: ChainSlug) => void
  onClose: () => void
}): JSX.Element {
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center sm:p-4">
      <button
        type="button"
        tabIndex={-1}
        aria-label="Close"
        onClick={onClose}
        className="bg-background/70 absolute inset-0 cursor-default backdrop-blur-sm"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Connect a wallet"
        className="border-border bg-background motion-safe:animate-in motion-safe:fade-in relative w-full rounded-t-2xl border p-4 shadow-lg sm:max-w-md sm:rounded-2xl sm:p-5"
      >
        <ConnectSteps
          initialChain={initialChain}
          onConnected={onConnected}
          trailing={
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="text-muted-foreground hover:text-foreground hover:bg-muted/60 -mr-1 flex h-8 w-8 items-center justify-center rounded-md transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          }
        />
      </div>
    </div>
  )
}

function ChainGrid({ onPick }: { onPick: (slug: ChainSlug) => void }): JSX.Element {
  return (
    <div className="grid grid-cols-2 gap-1">
      {CONNECT_CHAINS.map((slug) => (
        <button key={slug} type="button" onClick={() => onPick(slug)} className={rowClass}>
          <ChainMark chain={slug} className="h-7 w-7 shrink-0" />
          <span className="font-medium">{CHAIN_DESCRIPTORS[slug].name}</span>
        </button>
      ))}
    </div>
  )
}

function WalletList({
  chain,
  onConnected,
}: {
  chain: ChainSlug
  onConnected: () => void
}): JSX.Element {
  const connector = connectorFor(chain)
  const name = CHAIN_DESCRIPTORS[chain].name
  const [connecting, setConnecting] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  const wallets = useQuery({
    queryKey: ['connect-wallets', chain],
    queryFn: () => connector.listWallets(),
    staleTime: 0,
    gcTime: 0,
  })

  async function connectTo(wallet: WalletOption): Promise<void> {
    setConnecting(wallet.id)
    setError(undefined)
    try {
      await connector.connect(wallet.id)
      onConnected()
    } catch (e) {
      const message = walletErrorMessage(e)
      setError(isUserRejection(message) ? undefined : message)
    } finally {
      setConnecting(undefined)
    }
  }

  if (wallets.isPending) {
    return (
      <Note>
        <Loader2 className="mx-auto mb-2 h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
        Finding {name} wallets
      </Note>
    )
  }
  if (wallets.isError) {
    return (
      <Note>
        Could not load {name} wallets. Check your connection and try again.
        <Button variant="outline" size="sm" className="mt-3" onClick={() => void wallets.refetch()}>
          Try again
        </Button>
      </Note>
    )
  }
  if (wallets.data.length === 0) {
    return <Note>No {name} wallets are available in this browser. Install one, then reload.</Note>
  }

  return (
    <>
      <ul className="-mx-1 max-h-[60vh] overflow-y-auto px-1 py-0.5">
        {wallets.data.map((wallet) => (
          <li key={wallet.id}>
            {wallet.detected ? (
              <button
                type="button"
                disabled={connecting !== undefined}
                onClick={() => void connectTo(wallet)}
                className={cn(rowClass, 'disabled:cursor-wait disabled:opacity-60')}
              >
                <WalletIcon wallet={wallet} />
                <span className="flex-1 font-medium">{wallet.name}</span>
                {connecting === wallet.id ? (
                  <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
                    <Loader2 className="h-3 w-3 motion-safe:animate-spin" aria-hidden="true" />
                    Confirm in wallet
                  </span>
                ) : null}
              </button>
            ) : (
              <a href={wallet.installUrl} target="_blank" rel="noreferrer" className={rowClass}>
                <WalletIcon wallet={wallet} />
                <span className="text-muted-foreground flex-1">{wallet.name}</span>
                <span className="text-muted-foreground flex items-center gap-1 text-xs">
                  Install
                  <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
                </span>
              </a>
            )}
          </li>
        ))}
      </ul>
      {error !== undefined ? (
        <p role="alert" className="text-destructive mt-2 px-3 text-xs leading-relaxed">
          {error}
        </p>
      ) : null}
    </>
  )
}

function WalletIcon({ wallet }: { wallet: WalletOption }): JSX.Element {
  // Icons are hosted by each wallet, so any of them can fail to load.
  const [failed, setFailed] = useState(false)
  return wallet.icon !== undefined && !failed ? (
    <Image
      src={wallet.icon}
      alt=""
      width={28}
      height={28}
      unoptimized
      loading="eager"
      onError={() => setFailed(true)}
      className="h-7 w-7 shrink-0 rounded-md object-contain"
    />
  ) : (
    <span className="bg-muted text-muted-foreground flex h-7 w-7 shrink-0 items-center justify-center rounded-md">
      <Wallet className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
    </span>
  )
}

function Note({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="text-muted-foreground px-4 py-8 text-center text-sm leading-relaxed">
      {children}
    </div>
  )
}
