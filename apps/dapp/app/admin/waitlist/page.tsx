'use client'

/**
 * INACTIVE — access-gate feature, not wired into Intent.
 *
 * Built from a prompt meant for another project. The gate is switched off in
 * `middleware.ts`, so this page is reachable only by typing its URL. Kept for
 * possible later use; see the note in middleware.ts to re-enable.
 */
import { Badge, Button, Card, Input, Label } from '@intent/ui'
import { useCallback, useEffect, useState } from 'react'

interface Entry {
  id: string
  email: string
  status: 'pending' | 'accepted' | 'rejected'
  note: string | null
  createdAt: string
  firstLoginAt: string | null
}

/**
 * Waitlist admin.
 *
 * The token is held in component state and sent per request rather than stored
 * in a cookie or localStorage: this page is an operator tool, and a token that
 * outlives the tab is a credential sitting on disk in a browser profile.
 */
export default function AdminWaitlistPage(): JSX.Element {
  const [token, setToken] = useState('')
  const [authed, setAuthed] = useState(false)
  const [entries, setEntries] = useState<Entry[]>([])
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  const load = useCallback(
    async (withToken: string): Promise<boolean> => {
      setError(undefined)
      const res = await fetch('/api/admin/waitlist', { headers: { 'x-admin-token': withToken } })
      if (res.status === 401) {
        setError('That token was not accepted.')
        return false
      }
      const data = (await res.json()) as { signups?: Entry[] }
      setEntries(data.signups ?? [])
      return true
    },
    []
  )

  useEffect(() => {
    if (!authed) return
    const id = setInterval(() => void load(token), 15_000)
    return () => clearInterval(id)
  }, [authed, token, load])

  async function signIn(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setBusy(true)
    const ok = await load(token)
    setAuthed(ok)
    setBusy(false)
  }

  async function update(email: string, status: Entry['status']): Promise<void> {
    setBusy(true)
    await fetch('/api/admin/waitlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
      body: JSON.stringify({ email, status }),
    })
    await load(token)
    setBusy(false)
  }

  if (!authed) {
    return (
      <main className="bg-surface-base flex min-h-screen items-center justify-center px-6">
        <Card className="flex w-full max-w-sm flex-col gap-4 p-8">
          <h1 className="font-display text-xl">Waitlist admin</h1>
          <form onSubmit={signIn} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="token">Admin token</Label>
              <Input
                id="token"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="ADMIN_TOKEN from .env.local"
              />
            </div>
            <Button type="submit" disabled={busy || token === ''}>
              {busy ? 'Checking…' : 'Sign in'}
            </Button>
          </form>
          {error !== undefined ? <p className="text-destructive text-sm">{error}</p> : null}
        </Card>
      </main>
    )
  }

  const pending = entries.filter((e) => e.status === 'pending')

  return (
    <main className="bg-surface-base min-h-screen px-6 py-10">
      <div className="mx-auto flex max-w-4xl flex-col gap-6">
        <div className="flex items-baseline justify-between">
          <h1 className="font-display text-2xl">Waitlist</h1>
          <span className="text-muted-foreground text-sm">
            {entries.length} total · {pending.length} pending
          </span>
        </div>

        <Card className="divide-border divide-y">
          {entries.length === 0 ? (
            <p className="text-muted-foreground p-6 text-sm">No signups yet.</p>
          ) : (
            entries.map((entry) => (
              <div key={entry.id} className="flex items-center gap-4 p-4">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-mono text-sm">{entry.email}</span>
                  {entry.note !== null ? (
                    <span className="text-muted-foreground truncate text-xs">{entry.note}</span>
                  ) : null}
                  <span className="text-muted-foreground text-xs">
                    {new Date(entry.createdAt).toLocaleDateString()}
                    {entry.firstLoginAt !== null ? ' · signed in' : ''}
                  </span>
                </div>

                <Badge
                  variant="outline"
                  className={
                    entry.status === 'accepted'
                      ? 'border-success/40 text-success'
                      : entry.status === 'rejected'
                        ? 'border-destructive/40 text-destructive'
                        : ''
                  }
                >
                  {entry.status}
                </Badge>

                <div className="flex gap-2">
                  {entry.status !== 'accepted' ? (
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => void update(entry.email, 'accepted')}
                    >
                      Accept
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void update(entry.email, 'pending')}
                    >
                      Revoke
                    </Button>
                  )}
                </div>
              </div>
            ))
          )}
        </Card>
      </div>
    </main>
  )
}
