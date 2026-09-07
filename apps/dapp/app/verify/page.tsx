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
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense, useState } from 'react'

type Stage = 'email' | 'code' | 'not_accepted'

function VerifyForm(): JSX.Element {
  const router = useRouter()
  const params = useSearchParams()
  const next = params.get('next') ?? '/arc/intents'

  const [stage, setStage] = useState<Stage>('email')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [onWaitlist, setOnWaitlist] = useState(false)

  async function requestCode(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setBusy(true)
    setError(undefined)
    try {
      const res = await fetch('/api/auth/request-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const data = (await res.json()) as {
        status?: string
        retryAfter?: number
        onWaitlist?: boolean
      }

      if (data.status === 'sent') setStage('code')
      else if (data.status === 'not_accepted') {
        setOnWaitlist(data.onWaitlist === true)
        setStage('not_accepted')
      } else if (data.status === 'rate_limited') {
        setError(`Too many requests. Try again in ${data.retryAfter ?? 60}s.`)
      } else setError('Could not send a code. Check the address and try again.')
    } catch {
      setError('Network error. Is the app still running?')
    } finally {
      setBusy(false)
    }
  }

  async function submitCode(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setBusy(true)
    setError(undefined)
    try {
      const res = await fetch('/api/auth/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code }),
      })
      const data = (await res.json()) as { status?: string }

      if (data.status === 'verified') {
        router.push(next)
        router.refresh()
        return
      }

      const messages: Record<string, string> = {
        invalid: 'That code is not right.',
        expired: 'That code has expired. Request a new one.',
        too_many_attempts: 'Too many attempts. Request a new code.',
        not_accepted: 'This address is no longer approved for testing.',
      }
      setError(messages[data.status ?? ''] ?? 'Verification failed.')
    } catch {
      setError('Network error. Try again.')
    } finally {
      setBusy(false)
    }
  }

  if (stage === 'not_accepted') {
    return (
      <Card className="flex w-full max-w-md flex-col gap-4 p-8">
        <div className="flex flex-col gap-2">
          <h1 className="font-display text-2xl">You&apos;re not on the list yet</h1>
          <p className="text-muted-foreground text-sm">
            {onWaitlist
              ? 'You are on the waitlist. We will email you when a spot opens up.'
              : 'Intent is in private testing. Join the waitlist and we will be in touch.'}
          </p>
        </div>
        {onWaitlist ? null : (
          <Link
            href="/waitlist"
            className="bg-foreground text-background inline-flex h-10 items-center justify-center rounded-md px-4 text-sm font-medium transition-opacity hover:opacity-90"
          >
            Join the waitlist
          </Link>
        )}
        <button
          type="button"
          onClick={() => {
            setStage('email')
            setError(undefined)
          }}
          className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2"
        >
          Use a different email
        </button>
      </Card>
    )
  }

  return (
    <Card className="flex w-full max-w-md flex-col gap-5 p-8">
      <div className="flex flex-col gap-2">
        <h1 className="font-display text-2xl">Verify your email</h1>
        <p className="text-muted-foreground text-sm">
          {stage === 'email'
            ? 'Intent is in private testing. Enter the email you were approved with.'
            : `We sent a 6-digit code to ${email}.`}
        </p>
      </div>

      {stage === 'email' ? (
        <form onSubmit={requestCode} className="flex flex-col gap-3">
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
          <Button type="submit" disabled={busy || email === ''}>
            {busy ? 'Sending…' : 'Send code'}
          </Button>
        </form>
      ) : (
        <form onSubmit={submitCode} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="code">Access code</Label>
            <Input
              id="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              required
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              placeholder="000000"
              className="text-center font-mono text-lg tracking-[0.4em]"
            />
          </div>
          <Button type="submit" disabled={busy || code.length !== 6}>
            {busy ? 'Verifying…' : 'Verify'}
          </Button>
          <button
            type="button"
            onClick={() => {
              setStage('email')
              setCode('')
              setError(undefined)
            }}
            className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2"
          >
            Use a different email
          </button>
        </form>
      )}

      {error !== undefined ? <p className="text-destructive text-sm">{error}</p> : null}

      <p className="text-muted-foreground border-border border-t pt-4 text-xs">
        Not approved yet?{' '}
        <Link href="/waitlist" className="underline underline-offset-2">
          Join the waitlist
        </Link>
      </p>
    </Card>
  )
}

export default function VerifyPage(): JSX.Element {
  return (
    <main className="bg-surface-base flex min-h-screen items-center justify-center px-6 py-16">
      <Suspense fallback={null}>
        <VerifyForm />
      </Suspense>
    </main>
  )
}
