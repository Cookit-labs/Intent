'use client'

import { Button, ChainMark, Input, Label, cn } from '@intent/ui'
import {
  ArrowLeftRight,
  Brain,
  ChevronDown,
  Eye,
  EyeOff,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'

import { ThemeToggle } from '../layout/theme-toggle'

import { RANGE_OPTIONS, SCOPES, ScopeProvider, useScope, type AdminRange } from './scope'
import { StatsProvider, useStats } from './stats'

interface NavItem {
  href: string
  label: string
  icon: LucideIcon
  /** Pages about people on the waitlist do not change with the chain. */
  chainless?: boolean
}

const NAV: NavItem[] = [
  { href: '/admin', label: 'Overview', icon: LayoutDashboard },
  { href: '/admin/transactions', label: 'Transactions', icon: ArrowLeftRight },
  { href: '/admin/intents', label: 'Intents', icon: Brain },
  { href: '/admin/wallets', label: 'Wallets', icon: Wallet },
  { href: '/admin/waitlist', label: 'Waitlist', icon: ListChecks, chainless: true },
]

function ScopeSwitcher(): JSX.Element {
  const { scope, setScopeKey } = useScope()
  const [open, setOpen] = useState(false)
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

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Showing ${scope.name} ${scope.label}. Change chain`}
        className="border-border bg-card hover:bg-muted/60 inline-flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm font-medium transition-colors"
      >
        <ChainMark chain={scope.chain} className="h-4 w-4" />
        {scope.name}
        <span className="text-muted-foreground font-normal">{scope.label}</span>
        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Choose a chain"
          className="border-border bg-background absolute left-0 z-50 mt-1.5 w-56 rounded-lg border p-1 shadow-lg"
        >
          {SCOPES.map((option) =>
            option.available ? (
              <button
                key={option.key}
                type="button"
                role="menuitem"
                onClick={() => {
                  setScopeKey(option.key)
                  setOpen(false)
                }}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors',
                  option.key === scope.key ? 'bg-muted font-medium' : 'hover:bg-muted/60'
                )}
              >
                <ChainMark chain={option.chain} className="h-4 w-4 shrink-0" />
                <span className="flex flex-col leading-tight">
                  <span>{option.name}</span>
                  <span className="text-muted-foreground text-xs">{option.label}</span>
                </span>
              </button>
            ) : (
              <div
                key={option.key}
                role="menuitem"
                aria-disabled="true"
                className="text-muted-foreground flex w-full cursor-not-allowed items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm"
              >
                <ChainMark chain={option.chain} className="h-4 w-4 shrink-0" />
                <span className="flex flex-col leading-tight">
                  <span>{option.name}</span>
                  <span className="text-xs">{option.label}</span>
                </span>
              </div>
            )
          )}
        </div>
      ) : null}
    </div>
  )
}

function RangePicker(): JSX.Element {
  const { range, setRange } = useScope()
  return (
    <div role="group" aria-label="Date range" className="bg-muted/60 flex w-fit rounded-lg p-1">
      {RANGE_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={range === option.value}
          onClick={() => setRange(option.value as AdminRange)}
          className={cn(
            'whitespace-nowrap rounded-md px-2.5 py-1 text-sm transition-colors',
            range === option.value
              ? 'bg-card text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

function Sidebar(): JSX.Element {
  const pathname = usePathname()
  return (
    <nav aria-label="Admin" className="flex gap-1 md:flex-col">
      {NAV.map((item) => {
        const active =
          item.href === '/admin' ? pathname === '/admin' : pathname.startsWith(item.href)
        const Icon = item.icon
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex shrink-0 items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors',
              active
                ? 'bg-brand text-brand-foreground font-medium'
                : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
            )}
          >
            <Icon className="h-4 w-4" />
            {item.label}
          </Link>
        )
      })}
    </nav>
  )
}

function Workspace({
  children,
  onSignOut,
}: {
  children: ReactNode
  onSignOut: () => void
}): JSX.Element {
  const pathname = usePathname()
  const { loading, refresh } = useStats()
  const chainless = NAV.find((n) => n.href === pathname)?.chainless === true

  return (
    <div className="app-canvas bg-surface-base flex min-h-screen flex-col md:flex-row">
      <aside className="border-border flex shrink-0 flex-col gap-4 border-b px-4 py-3 md:sticky md:top-0 md:h-screen md:w-56 md:border-b-0 md:border-r md:py-5">
        <div className="flex items-center justify-between md:block">
          <div className="flex items-baseline gap-2">
            <span className="font-display text-lg">Intent</span>
            <span className="text-muted-foreground text-sm">Admin</span>
          </div>
          <div className="flex items-center md:hidden">
            <ThemeToggle />
            <Button variant="ghost" size="sm" onClick={onSignOut} aria-label="Sign out">
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div className="-mx-1 overflow-x-auto px-1 md:mx-0 md:overflow-visible md:px-0">
          <Sidebar />
        </div>
        <div className="mt-auto hidden items-center justify-between md:flex">
          <ThemeToggle />
          <Button variant="ghost" size="sm" onClick={onSignOut} className="gap-1.5">
            <LogOut className="h-4 w-4" />
            Sign out
          </Button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6 md:h-16 md:py-0">
          {chainless ? (
            <p className="text-muted-foreground text-sm">The waitlist is shared by every chain.</p>
          ) : (
            <>
              <ScopeSwitcher />
              <div className="flex items-center gap-3">
                <span aria-live="polite" className="text-muted-foreground text-xs">
                  {loading ? 'Updating…' : 'Live'}
                </span>
                <button
                  type="button"
                  onClick={refresh}
                  className="text-muted-foreground hover:text-foreground text-xs underline-offset-2 hover:underline"
                >
                  Refresh
                </button>
                <RangePicker />
              </div>
            </>
          )}
        </header>
        <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 pb-16 sm:px-6">
          {children}
        </main>
      </div>
    </div>
  )
}

function SignIn({ onDone }: { onDone: () => void }): JSX.Element {
  const [token, setToken] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault()
    setBusy(true)
    setError(undefined)
    const res = await fetch('/api/admin/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token.trim() }),
    })
    setBusy(false)
    if (res.ok) {
      setToken('')
      onDone()
      return
    }
    setError(
      res.status === 503
        ? 'AUTH_SECRET must be set (32+ characters) to sign in.'
        : 'That token was not accepted. Copy ADMIN_TOKEN from apps/dapp/.env.local.'
    )
  }

  return (
    <div className="app-canvas bg-surface-base flex min-h-screen flex-col">
      <header className="flex h-16 shrink-0 items-center justify-between px-4 sm:px-6">
        <div className="flex items-baseline gap-2">
          <span className="font-display text-lg">Intent</span>
          <span className="text-muted-foreground text-sm">Admin</span>
        </div>
        <ThemeToggle />
      </header>
      <main className="flex flex-1 items-center justify-center px-4 pb-24">
        <form
          onSubmit={submit}
          className="border-border bg-card flex w-full max-w-sm flex-col gap-5 rounded-2xl border p-7 shadow-sm"
        >
          <div className="flex flex-col gap-1">
            <h1 className="font-display text-2xl">Admin sign-in</h1>
            <p className="text-muted-foreground text-sm">
              Sign in to see usage, volume and the tester waitlist.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="token">Admin token</Label>
            <div className="relative">
              <Input
                id="token"
                type={show ? 'text' : 'password'}
                value={token}
                autoComplete="off"
                autoFocus
                onChange={(e) => setToken(e.target.value)}
                className="pr-10 font-mono"
              />
              <button
                type="button"
                onClick={() => setShow((v) => !v)}
                aria-label={show ? 'Hide token' : 'Show token'}
                className="text-muted-foreground hover:text-foreground absolute inset-y-0 right-0 flex w-10 items-center justify-center"
              >
                {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            {error !== undefined ? (
              <p role="alert" className="text-destructive text-sm">
                {error}
              </p>
            ) : null}
          </div>
          <Button type="submit" disabled={busy || token.trim() === ''}>
            {busy ? 'Checking…' : 'Sign in'}
          </Button>
        </form>
      </main>
    </div>
  )
}

export function AdminShell({ children }: { children: ReactNode }): JSX.Element {
  const [authed, setAuthed] = useState<boolean | undefined>(undefined)

  useEffect(() => {
    fetch('/api/admin/session')
      .then(async (res) =>
        setAuthed(((await res.json()) as { authenticated?: boolean }).authenticated === true)
      )
      .catch(() => setAuthed(false))
  }, [])

  async function signOut(): Promise<void> {
    await fetch('/api/admin/session', { method: 'DELETE' })
    setAuthed(false)
  }

  if (authed === undefined) return <div className="app-canvas bg-surface-base min-h-screen" />
  if (!authed) return <SignIn onDone={() => setAuthed(true)} />

  return (
    <ScopeProvider>
      <StatsProvider>
        <Workspace onSignOut={() => void signOut()}>{children}</Workspace>
      </StatsProvider>
    </ScopeProvider>
  )
}
