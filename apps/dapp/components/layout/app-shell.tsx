'use client'

import { cn } from '@intent/ui'
import { Menu, X } from 'lucide-react'
import { usePathname } from 'next/navigation'
import { useEffect, useState, type ReactNode } from 'react'

import { Header } from './header'
import { Sidebar } from './sidebar'

/**
 * The application frame, and where it adapts to a narrow screen.
 *
 * The sidebar is 240px of a 375px phone, which left 135px for everything the
 * user actually came for. So below `lg` it becomes a drawer: hidden by
 * default, opened from a button in the header, and closed by navigating,
 * tapping the backdrop, or pressing Escape.
 *
 * Rendered twice rather than repositioned. One element that is a column on
 * desktop and an overlay on mobile needs conflicting layout, transform and
 * stacking rules at each breakpoint, and the version that reads clearly is two
 * declarations that each do one thing.
 */
export function AppShell({ children }: { children: ReactNode }): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const pathname = usePathname()

  // A route change from anywhere — a link inside the page, the browser's back
  // button — should not leave the menu covering the destination.
  useEffect(() => setMenuOpen(false), [pathname])

  // Escape closes it, which is what a keyboard user will try first.
  useEffect(() => {
    if (!menuOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menuOpen])

  return (
    <div className="bg-surface-base flex h-screen overflow-hidden">
      {/* Desktop: a permanent column. */}
      <Sidebar className="hidden lg:flex" />

      {/* Mobile: a drawer over the page. Kept out of the tree entirely when
          closed, so its links are not reachable by tab from the page behind. */}
      {menuOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setMenuOpen(false)}
            className="bg-background/70 absolute inset-0 backdrop-blur-sm"
          />
          <Sidebar
            className="animate-in slide-in-from-left relative z-10 duration-200"
            onNavigate={() => setMenuOpen(false)}
          />
        </div>
      ) : null}

      {/* `app-canvas`: this column carries the brand glow and grain that the
          header and page sit on. See globals.css. */}
      <div className="app-canvas flex min-w-0 flex-1 flex-col overflow-hidden">
        <Header
          onOpenMenu={() => setMenuOpen(true)}
          menuButton={
            <button
              type="button"
              onClick={() => setMenuOpen(true)}
              aria-label="Open menu"
              aria-expanded={menuOpen}
              className={cn(
                'text-muted-foreground hover:text-foreground hover:bg-muted/60',
                'flex h-9 w-9 shrink-0 items-center justify-center rounded-md transition-colors lg:hidden'
              )}
            >
              {menuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          }
        />
        {/* `min-w-0` on the column above and here: without it a wide child —
            a long hash, a table — forces the whole layout wider than the
            viewport and the page scrolls sideways. */}
        <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  )
}
