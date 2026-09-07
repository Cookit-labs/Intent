'use client'

/**
 * INACTIVE — access-gate feature, not wired into Intent.
 *
 * Built from a prompt meant for another project. The gate is switched off in
 * `middleware.ts`, so this page is reachable only by typing its URL. Kept for
 * possible later use; see the note in middleware.ts to re-enable.
 */
import { Button, Card, Input, Label } from '@intent/ui'
import Link from 'next/link'
import { useState } from 'react'

export default function WaitlistPage(): JSX.Element {
  const [email, setEmail] = useState('')
  const [note, setNote] = useState('')
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setBusy(true)
    setError(undefined)
    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, note }),
      })
      if (res.ok) setDone(true)
      else setError('That address does not look right.')
    } catch {
      setError('Network error. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="bg-surface-base flex min-h-screen items-center justify-center px-6 py-16">
      <Card className="flex w-full max-w-md flex-col gap-5 p-8">
        {done ? (
          <div className="flex flex-col gap-3">
            <h1 className="font-display text-2xl">You&apos;re on the list</h1>
            <p className="text-muted-foreground text-sm">
              We will email {email} when a testing spot opens up.
            </p>
            <Link
              href="/verify"
              className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2"
            >
              Back to sign in
            </Link>
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-2">
              <h1 className="font-display text-2xl">Join the waitlist</h1>
              <p className="text-muted-foreground text-sm">
                Intent is in private testing. Leave your email and we will reach out as spots open.
              </p>
            </div>

            <form onSubmit={submit} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  required
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@company.com"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="note">What would you use Intent for? (optional)</Label>
                <Input
                  id="note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Execution for a treasury, agent research, …"
                />
              </div>
              <Button type="submit" disabled={busy || email === ''}>
                {busy ? 'Submitting…' : 'Request access'}
              </Button>
            </form>

            {error !== undefined ? <p className="text-destructive text-sm">{error}</p> : null}

            <p className="text-muted-foreground border-border border-t pt-4 text-xs">
              Already approved?{' '}
              <Link href="/verify" className="underline underline-offset-2">
                Verify your email
              </Link>
            </p>
          </>
        )}
      </Card>
    </main>
  )
}
