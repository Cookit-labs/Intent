'use client'

import { Button, cn } from '@intent/ui'
import { Check, ChevronDown, Copy, ExternalLink, LogOut, Wallet } from 'lucide-react'
import Image from 'next/image'
import { useEffect, useRef, useState } from 'react'

import { useWallet } from '../../hooks/use-wallet'
import { chainTitle } from '../../lib/chain-title'
import { useChain } from '../../providers/chain-provider'

function short(address: string): string {
  return address.length <= 16 ? address : `${address.slice(0, 6)}…${address.slice(-4)}`
}

function amount(value: string): string {
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: 5 })
}

function WalletBadge({
  icon,
  className,
}: {
  icon: string | undefined
  className: string
}): JSX.Element {
  return icon !== undefined ? (
    <Image
      src={icon}
      alt=""
      width={36}
      height={36}
      unoptimized
      className={cn('shrink-0 rounded-sm object-contain', className)}
    />
  ) : (
    <Wallet
      className={cn('text-muted-foreground shrink-0', className)}
      strokeWidth={1.75}
      aria-hidden="true"
    />
  )
}

/** The connected wallet on a chain without Stellar's holdings and activity panel. */
export function ChainWalletMenu({
  onDisconnect,
}: {
  onDisconnect: () => void
}): JSX.Element | null {
  const { adapter, descriptor } = useChain()
  const { address, balance, balanceSymbol, walletIcon, walletName, isWrongNetwork, switchNetwork } =
    useWallet()
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

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

  if (address === undefined) return null

  function copy(value: string): void {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Wallet ${short(address)}`}
        className="border-border bg-card hover:bg-muted/60 focus-visible:ring-ring inline-flex h-9 items-center gap-2 rounded-md border pl-1.5 pr-2 transition-colors focus-visible:outline-none focus-visible:ring-2"
      >
        <span className="relative shrink-0">
          <WalletBadge icon={walletIcon} className="h-6 w-6" />
          <span
            className={cn(
              'ring-card absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-2',
              isWrongNetwork ? 'bg-warning' : 'bg-success'
            )}
            aria-hidden="true"
          />
        </span>
        <span className="text-sm font-medium tabular-nums">{short(address)}</span>
        <ChevronDown
          className={cn('text-muted-foreground h-4 w-4 transition-transform', open && 'rotate-180')}
          aria-hidden="true"
        />
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Wallet"
          className="border-border bg-background absolute right-0 z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border shadow-lg"
        >
          <div className="flex items-center gap-3 px-4 pt-4">
            <WalletBadge icon={walletIcon} className="h-9 w-9" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium" title={address}>
                {short(address)}
              </p>
              <p className="text-muted-foreground text-xs">
                {walletName ?? 'Wallet'} on {chainTitle(descriptor.name, descriptor.networkLabel)}
              </p>
            </div>
            <button
              type="button"
              onClick={() => copy(address)}
              aria-label={copied ? 'Address copied' : 'Copy address'}
              className="text-muted-foreground hover:text-foreground hover:bg-muted/60 flex h-8 w-8 items-center justify-center rounded-md transition-colors"
            >
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            </button>
            <a
              href={adapter.accountUrl(address)}
              target="_blank"
              rel="noreferrer"
              aria-label="View account on the explorer"
              className="text-muted-foreground hover:text-foreground hover:bg-muted/60 flex h-8 w-8 items-center justify-center rounded-md transition-colors"
            >
              <ExternalLink className="h-4 w-4" />
            </a>
          </div>

          {isWrongNetwork ? (
            <div className="px-4 pb-1 pt-4">
              <p className="text-muted-foreground text-sm leading-relaxed">
                Your wallet is on another network.
              </p>
              <Button size="sm" onClick={switchNetwork} className="mt-2 w-full">
                Switch to {descriptor.name}
              </Button>
            </div>
          ) : (
            <div className="px-4 pb-1 pt-5">
              <p className="text-muted-foreground text-xs">Balance</p>
              <p className="mt-1 text-3xl tabular-nums tracking-tight">
                {balance !== undefined ? amount(balance) : '—'}{' '}
                <span className="text-muted-foreground text-lg">{balanceSymbol}</span>
              </p>
            </div>
          )}

          <div className="p-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setOpen(false)
                onDisconnect()
              }}
              className="w-full gap-2 text-sm"
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
              Disconnect
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
