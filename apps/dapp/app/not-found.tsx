import type { Metadata } from 'next'

import { NotFoundActions } from '../components/layout/not-found-actions'

export const metadata: Metadata = { title: 'Page not found' }

/**
 * Shown for any address the app does not have, including a chain it does not
 * run on. It sits on the same glow and grain as the rest of the app, drawn
 * from the theme tokens, so it is the right page in light and in dark.
 *
 * The numeral is a tint that fades toward the bottom rather than a solid
 * fill: it is the largest thing here and the least important, and a solid one
 * would outweigh the two things the visitor can actually do.
 */
export default function NotFound(): JSX.Element {
  return (
    <main className="app-canvas flex min-h-screen flex-col items-center justify-center px-6 py-16 text-center">
      <p
        aria-hidden="true"
        className="select-none font-medium leading-[0.85] tracking-tighter"
        style={{
          fontSize: 'clamp(7rem, 26vw, 16rem)',
          color: 'transparent',
          backgroundImage:
            'linear-gradient(to bottom, hsl(var(--glow) / 0.55), hsl(var(--glow) / 0.04))',
          WebkitBackgroundClip: 'text',
          backgroundClip: 'text',
        }}
      >
        404
      </p>
      <h1 className="font-display mt-6 text-2xl font-semibold tracking-tight sm:text-3xl">
        This page does not exist
      </h1>
      <p className="text-muted-foreground mt-2 max-w-md text-sm leading-relaxed">
        The link may be old, or the address mistyped. Nothing was lost.
      </p>
      <NotFoundActions />
    </main>
  )
}
