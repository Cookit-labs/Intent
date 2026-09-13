'use client'

import { cn } from '@intent/ui'
import { Moon, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useEffect, useState } from 'react'

/**
 * Switching between light and dark.
 *
 * The theme lives in localStorage, which the server cannot read, so the first
 * client render must match the server's HTML or React reports a hydration
 * mismatch and the page flickers. `mounted` is the standard answer: render a
 * placeholder of the same size until the client knows which theme is active,
 * then swap in the real control.
 *
 * The placeholder matters more than it looks. Returning null would collapse
 * the header layout for a frame and shift everything beside it.
 */
export function ThemeToggle(): JSX.Element {
  const { resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  useEffect(() => setMounted(true), [])

  if (!mounted) {
    // Same footprint as the button below, so nothing moves when it appears.
    return <span className="h-8 w-8 shrink-0" aria-hidden />
  }

  const isDark = resolvedTheme === 'dark'

  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      // Named for what it will do, not for the current state: a screen reader
      // user needs the action, and "dark mode, on" leaves them guessing what
      // pressing it achieves.
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={isDark ? 'Light mode' : 'Dark mode'}
      className={cn(
        'text-muted-foreground hover:text-foreground hover:bg-muted/60',
        'flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors'
      )}
    >
      {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  )
}
