'use client'

import { cn } from '@intent/ui'
import { LogOut } from 'lucide-react'
import { useEffect, useState } from 'react'

/**
 * Ends the email sign-in on this browser.
 *
 * Shown only while the access-gate session cookie is present, so it is absent
 * wherever the gate is off and never offers to end a session that does not
 * exist. The cookie is httpOnly, so whether it exists is asked of the server.
 */
export function SignOutButton(): JSX.Element | null {
  const [email, setEmail] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    fetch('/api/auth/session')
      .then((res) => res.json() as Promise<{ authenticated?: boolean; email?: string }>)
      .then((data) => {
        if (live && data.authenticated === true) setEmail(data.email ?? '')
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])

  if (email === undefined) return null

  async function signOut(): Promise<void> {
    setBusy(true)
    try {
      await fetch('/api/auth/logout', { method: 'POST' })
    } finally {
      window.location.assign('/verify')
    }
  }

  return (
    <button
      type="button"
      onClick={() => void signOut()}
      disabled={busy}
      aria-label="Sign out"
      title={email === '' ? 'Sign out' : `Sign out ${email}`}
      className={cn(
        'text-muted-foreground hover:text-foreground hover:bg-muted/60',
        'flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors',
        'disabled:opacity-50'
      )}
    >
      <LogOut className="h-4 w-4" />
    </button>
  )
}
