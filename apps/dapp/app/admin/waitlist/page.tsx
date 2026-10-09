'use client'

import { Badge, Button, Input, Label, cn } from '@intent/ui'
import { Check, Eye, EyeOff, LogOut, RotateCcw, Search, UserPlus, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'

import { ThemeToggle } from '../../../components/layout/theme-toggle'

type Status = 'pending' | 'accepted' | 'rejected'
type Filter = Status | 'all'

interface Entry {
  id: string
  email: string
  status: Status
  note: string | null
  createdAt: string
  acceptedAt: string | null
  firstLoginAt: string | null
}

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'pending', label: 'Waiting' },
  { value: 'accepted', label: 'Let in' },
  { value: 'rejected', label: 'Declined' },
  { value: 'all', label: 'Everyone' },
]

const STATUS_STYLE: Record<Status, { label: string; className: string }> = {
  pending: { label: 'Waiting', className: 'border-border text-muted-foreground' },
  accepted: { label: 'Let in', className: 'border-success/40 text-success' },
  rejected: { label: 'Declined', className: 'border-destructive/40 text-destructive' },
}

const ORDER: Record<Status, number> = { pending: 0, accepted: 1, rejected: 2 }

function day(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

function Frame({
  children,
  onSignOut,
}: {
  children: ReactNode
  onSignOut?: () => void
}): JSX.Element {
  return (
    <div className="app-canvas bg-surface-base flex min-h-screen flex-col">
      <header className="flex h-16 shrink-0 items-center justify-between px-4 sm:px-6">
        <div className="flex items-baseline gap-2">
          <span className="font-display text-lg">Intent</span>
          <span className="text-muted-foreground text-sm">Admin</span>
        </div>
        <div className="flex items-center gap-1">
          <ThemeToggle />
          {onSignOut !== undefined ? (
            <Button variant="ghost" size="sm" onClick={onSignOut} className="gap-1.5">
              <LogOut className="h-4 w-4" />
              Sign out
            </Button>
          ) : null}
        </div>
      </header>
      {children}
    </div>
  )
}

export default function AdminWaitlistPage(): JSX.Element {
  const [token, setToken] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [authed, setAuthed] = useState(false)
  const [entries, setEntries] = useState<Entry[]>([])
  const [error, setError] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [invite, setInvite] = useState('')
  const [filter, setFilter] = useState<Filter>('pending')
  const [query, setQuery] = useState('')

  const load = useCallback(async (withToken: string): Promise<boolean> => {
    const res = await fetch('/api/admin/waitlist', { headers: { 'x-admin-token': withToken } })
    if (res.status === 401) return false
    const data = (await res.json()) as { signups?: Entry[] }
    setEntries(data.signups ?? [])
    return true
  }, [])

  useEffect(() => {
    if (!authed) return
    const id = setInterval(() => void load(token), 15_000)
    return () => clearInterval(id)
  }, [authed, token, load])

  async function signIn(e: FormEvent): Promise<void> {
    e.preventDefault()
    setBusy(true)
    setError(undefined)
    const ok = await load(token.trim())
    if (ok) setToken(token.trim())
    else setError('That token was not accepted. Copy ADMIN_TOKEN from apps/dapp/.env.local.')
    setAuthed(ok)
    setBusy(false)
  }

  function signOut(): void {
    setAuthed(false)
    setToken('')
    setEntries([])
    setNotice(undefined)
  }

  async function update(email: string, status: Status, done: string): Promise<void> {
    setBusy(true)
    setNotice(undefined)
    const res = await fetch('/api/admin/waitlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
      body: JSON.stringify({ email, status }),
    })
    if (res.ok) {
      await load(token)
      setNotice(`${email} ${done}.`)
    } else {
      setNotice(`Could not update ${email}. Try again.`)
    }
    setBusy(false)
  }

  async function letIn(e: FormEvent): Promise<void> {
    e.preventDefault()
    const email = invite.trim()
    if (email === '') return
    await update(email, 'accepted', 'can now sign in')
    setInvite('')
  }

  const counts = useMemo(() => {
    const c = { pending: 0, accepted: 0, rejected: 0, all: entries.length }
    for (const entry of entries) c[entry.status] += 1
    return c
  }, [entries])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return entries
      .filter((entry) => filter === 'all' || entry.status === filter)
      .filter((entry) => q === '' || entry.email.includes(q))
      .sort(
        (a, b) =>
          ORDER[a.status] - ORDER[b.status] ||
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      )
  }, [entries, filter, query])

  if (!authed) {
    return (
      <Frame>
        <main className="flex flex-1 items-center justify-center px-4 pb-24">
          <form
            onSubmit={signIn}
            className="border-border bg-card flex w-full max-w-sm flex-col gap-5 rounded-2xl border p-7 shadow-sm"
          >
            <div className="flex flex-col gap-1">
              <h1 className="font-display text-2xl">Tester access</h1>
              <p className="text-muted-foreground text-sm">
                Sign in with the admin token to let people into the mainnet beta.
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="token">Admin token</Label>
              <div className="relative">
                <Input
                  id="token"
                  type={showToken ? 'text' : 'password'}
                  value={token}
                  autoComplete="off"
                  autoFocus
                  onChange={(e) => setToken(e.target.value)}
                  className="pr-10 font-mono"
                />
                <button
                  type="button"
                  onClick={() => setShowToken((v) => !v)}
                  aria-label={showToken ? 'Hide token' : 'Show token'}
                  className="text-muted-foreground hover:text-foreground absolute inset-y-0 right-0 flex w-10 items-center justify-center"
                >
                  {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
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
      </Frame>
    )
  }

  return (
    <Frame onSignOut={signOut}>
      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-4 pb-16 sm:px-6">
        <div className="flex flex-col gap-1">
          <h1 className="font-display text-3xl">Tester access</h1>
          <p className="text-muted-foreground text-sm">
            Only people marked Let in receive a sign-in code for mainnet. You can let in an email
            that has not signed up.
          </p>
        </div>

        <form onSubmit={letIn} className="flex flex-col gap-2 sm:flex-row">
          <Input
            type="email"
            value={invite}
            onChange={(e) => setInvite(e.target.value)}
            placeholder="Email to let in"
            aria-label="Email to let in"
          />
          <Button
            type="submit"
            disabled={busy || invite.trim() === ''}
            className="gap-1.5 sm:shrink-0"
          >
            <UserPlus className="h-4 w-4" />
            Let in
          </Button>
        </form>

        <p aria-live="polite" className="text-muted-foreground -mt-3 min-h-5 text-sm">
          {notice}
        </p>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="bg-muted/60 flex w-fit max-w-full overflow-x-auto rounded-lg p-1">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                aria-pressed={filter === f.value}
                onClick={() => setFilter(f.value)}
                className={cn(
                  'flex shrink-0 items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors',
                  filter === f.value
                    ? 'bg-card text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {f.label}
                <span className="font-mono text-xs tabular-nums">{counts[f.value]}</span>
              </button>
            ))}
          </div>

          <div className="relative sm:w-64">
            <Search className="text-muted-foreground pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search emails"
              aria-label="Search emails"
              className="pl-9"
            />
          </div>
        </div>

        <div className="border-border bg-card divide-border divide-y overflow-hidden rounded-2xl border shadow-sm">
          {visible.length === 0 ? (
            <p className="text-muted-foreground p-8 text-center text-sm">
              {entries.length === 0
                ? 'Nobody has signed up yet. Let someone in above to give them a sign-in code.'
                : query.trim() !== ''
                  ? 'No email matches that search.'
                  : 'Nobody here right now.'}
            </p>
          ) : (
            visible.map((entry) => (
              <div
                key={entry.id}
                className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:gap-4"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate font-mono text-sm">{entry.email}</span>
                  <span className="text-muted-foreground text-xs">
                    Signed up {day(entry.createdAt)}
                    {' · '}
                    {entry.firstLoginAt !== null
                      ? `first sign-in ${day(entry.firstLoginAt)}`
                      : 'has not signed in yet'}
                  </span>
                  {entry.note !== null ? (
                    <span className="text-muted-foreground truncate text-xs">{entry.note}</span>
                  ) : null}
                </div>

                <Badge
                  variant="outline"
                  className={cn('w-fit', STATUS_STYLE[entry.status].className)}
                >
                  {STATUS_STYLE[entry.status].label}
                </Badge>

                <div className="flex gap-2">
                  {entry.status !== 'accepted' ? (
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => void update(entry.email, 'accepted', 'can now sign in')}
                      className="gap-1.5"
                    >
                      <Check className="h-4 w-4" />
                      Let in
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void update(entry.email, 'pending', 'was moved back to waiting')
                      }
                      className="gap-1.5"
                    >
                      <RotateCcw className="h-4 w-4" />
                      Revoke
                    </Button>
                  )}
                  {entry.status === 'pending' ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void update(entry.email, 'rejected', 'was declined')}
                      className="gap-1.5"
                    >
                      <X className="h-4 w-4" />
                      Decline
                    </Button>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </div>
      </main>
    </Frame>
  )
}
