'use client'

import { stellarNetwork } from '@intent/config'
import { Button, Skeleton } from '@intent/ui'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  LogOut,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import {
  fetchActivity,
  fetchHoldings,
  type Activity,
  type Holding,
} from '../../lib/wallet/account-activity'
import { timeAgo } from '../../lib/wallet/time-ago'
import { useChain } from '../../providers/chain-provider'
import { TokenIcon } from '../ui/token-icon'

type Tab = 'holdings' | 'activity'

function short(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`
}

function amount(value: string): string {
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: 7 })
}

/** Two hues taken from the address, so the same account always looks the same. */
function avatarStyle(address: string): { background: string } {
  let h = 0
  for (const ch of address) h = (h * 31 + ch.charCodeAt(0)) % 360
  return {
    background: `linear-gradient(135deg, hsl(${h} 62% 58%), hsl(${(h + 48) % 360} 62% 46%))`,
  }
}

/**
 * The connected wallet: one control showing what is in it, and a panel behind
 * it for the rest.
 *
 * Replaces a balance, an address and a Disconnect button laid side by side,
 * which gave three things to read and no way to see what the balance was made
 * of or what had happened to it. Disconnect is still one press away, but it
 * lives where a wallet's other account actions do, not beside the balance
 * where it can be pressed by accident.
 */
export function StellarWalletMenu({
  address,
  balance,
  balanceSymbol,
  onDisconnect,
}: {
  address: string
  balance: string | undefined
  balanceSymbol: string
  onDisconnect: () => void
}): JSX.Element {
  const { adapter, descriptor } = useChain()
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('holdings')
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

  const holdings = useQuery({
    queryKey: ['wallet-holdings', stellarNetwork.network, address],
    queryFn: () => fetchHoldings(address),
    enabled: open,
    staleTime: 15_000,
  })
  const activity = useQuery({
    queryKey: ['wallet-activity', stellarNetwork.network, address],
    queryFn: () => fetchActivity(address),
    enabled: open,
    staleTime: 15_000,
  })

  function copy(): void {
    void navigator.clipboard.writeText(address).then(() => {
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
        className="border-border bg-card hover:bg-muted/60 focus-visible:ring-ring inline-flex h-9 items-center gap-2.5 rounded-md border pl-3 pr-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2"
      >
        {balance !== undefined ? (
          <span className="hidden tabular-nums sm:inline">
            {amount(balance)} <span className="text-muted-foreground">{balanceSymbol}</span>
          </span>
        ) : null}
        <span className="bg-border hidden h-4 w-px sm:block" aria-hidden="true" />
        <span className="h-5 w-5 rounded-full" style={avatarStyle(address)} aria-hidden="true" />
        <span className="font-mono text-xs">{short(address)}</span>
        <ChevronDown
          className={`text-muted-foreground h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Wallet"
          className="border-border bg-background absolute right-0 z-50 mt-2 w-[22rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border shadow-lg"
        >
          <div className="flex items-center gap-3 px-4 pt-4">
            <span className="h-8 w-8 shrink-0 rounded-full" style={avatarStyle(address)} />
            <div className="min-w-0 flex-1">
              <p className="font-mono text-sm">{short(address)}</p>
              <p className="text-muted-foreground text-xs">{descriptor.networkLabel}</p>
            </div>
            <button
              type="button"
              onClick={copy}
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

          <div className="px-4 pb-4 pt-5">
            <p className="text-muted-foreground text-xs">Balance</p>
            <p className="mt-1 text-3xl tabular-nums tracking-tight">
              {balance !== undefined ? amount(balance) : '—'}{' '}
              <span className="text-muted-foreground text-lg">{balanceSymbol}</span>
            </p>
          </div>

          <div role="tablist" className="border-border flex border-b px-2">
            {(['holdings', 'activity'] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={`-mb-px flex-1 border-b-2 px-3 py-2.5 text-sm transition-colors ${
                  tab === t
                    ? 'border-brand text-foreground'
                    : 'text-muted-foreground hover:text-foreground border-transparent'
                }`}
              >
                {t === 'holdings' ? 'Holdings' : 'Activity'}
              </button>
            ))}
          </div>

          <div role="tabpanel" className="max-h-72 min-h-[9rem] overflow-y-auto">
            {tab === 'holdings' ? (
              <HoldingsList
                holdings={holdings.data}
                loading={holdings.isLoading}
                failed={holdings.isError}
              />
            ) : (
              <ActivityList
                activity={activity.data}
                loading={activity.isLoading}
                failed={activity.isError}
              />
            )}
          </div>

          <div className="border-border border-t p-3">
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

function Rows(): JSX.Element {
  return (
    <div className="flex flex-col gap-3 p-4">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-8 w-8 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-3 w-16" />
          </div>
          <Skeleton className="h-4 w-14" />
        </div>
      ))}
    </div>
  )
}

function Note({ children }: { children: string }): JSX.Element {
  return (
    <p className="text-muted-foreground px-6 py-10 text-center text-sm leading-relaxed">
      {children}
    </p>
  )
}

function HoldingsList({
  holdings,
  loading,
  failed,
}: {
  holdings: Holding[] | undefined
  loading: boolean
  failed: boolean
}): JSX.Element {
  if (loading) return <Rows />
  if (failed) return <Note>Could not read this account right now. Try again in a moment.</Note>
  if (holdings === undefined || holdings.length === 0) {
    return <Note>This account is not funded yet. Send XLM to it to activate it.</Note>
  }
  return (
    <ul>
      {holdings.map((h) => (
        <li key={`${h.code}-${h.issuer ?? 'native'}`} className="flex items-center gap-3 px-4 py-3">
          <TokenIcon symbol={h.code} size={32} />
          <div className="min-w-0 flex-1">
            <p className="text-sm">{h.code}</p>
            {h.native ? <p className="text-muted-foreground text-xs">Stellar Lumens</p> : null}
          </div>
          <p className="text-sm tabular-nums">{amount(h.balance)}</p>
        </li>
      ))}
    </ul>
  )
}

const KIND = {
  received: { Icon: ArrowDownLeft, label: 'Received', sign: '+' },
  sent: { Icon: ArrowUpRight, label: 'Sent', sign: '−' },
  swap: { Icon: ArrowLeftRight, label: 'Swapped', sign: '+' },
} as const

function ActivityList({
  activity,
  loading,
  failed,
}: {
  activity: Activity[] | undefined
  loading: boolean
  failed: boolean
}): JSX.Element {
  if (loading) return <Rows />
  if (failed) return <Note>Could not read this account right now. Try again in a moment.</Note>
  if (activity === undefined || activity.length === 0) {
    return <Note>Nothing here yet. Payments and swaps from this wallet will show up here.</Note>
  }
  return (
    <ul>
      {activity.map((a) => {
        const { Icon, label, sign } = KIND[a.kind]
        return (
          <li key={a.id}>
            <a
              href={`${stellarNetwork.blockExplorerUrl}/tx/${a.hash}`}
              target="_blank"
              rel="noreferrer"
              className="hover:bg-muted/50 flex items-center gap-3 px-4 py-3 transition-colors"
            >
              <span className="bg-muted text-muted-foreground flex h-8 w-8 shrink-0 items-center justify-center rounded-full">
                <Icon className="h-4 w-4" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm">{label}</p>
                <p className="text-muted-foreground truncate text-xs">
                  {a.kind === 'swap' && a.sourceCode !== undefined
                    ? `${a.sourceCode} to ${a.code}`
                    : a.counterparty !== undefined
                      ? `${a.kind === 'sent' ? 'To' : 'From'} ${short(a.counterparty)}`
                      : ''}
                  {' · '}
                  {timeAgo(a.at)}
                </p>
              </div>
              <div className="text-right">
                <p className={`text-sm tabular-nums ${a.kind === 'sent' ? '' : 'text-success'}`}>
                  {sign}
                  {amount(a.amount)} {a.code}
                </p>
                {a.kind === 'swap' && a.sourceAmount !== undefined ? (
                  <p className="text-muted-foreground text-xs tabular-nums">
                    −{amount(a.sourceAmount)} {a.sourceCode}
                  </p>
                ) : null}
              </div>
            </a>
          </li>
        )
      })}
    </ul>
  )
}
