'use client'

import { DEFAULT_CHAIN, parseChainSegment } from '@intent/config'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

/**
 * What a visitor can do about a missing page: see which address was asked
 * for, and go somewhere real. The links stay on the chain the address was
 * under, so a mistyped Stellar page lands back on Stellar rather than the
 * default chain.
 */
export function NotFoundActions(): JSX.Element {
  const pathname = usePathname()
  const first = pathname.split('/')[1] ?? ''
  const chain = parseChainSegment(first) !== undefined ? first : DEFAULT_CHAIN

  return (
    <>
      <p className="border-border bg-card text-muted-foreground mt-6 max-w-full truncate rounded-full border px-3.5 py-1.5 font-mono text-xs">
        {pathname}
      </p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <Link
          href={`/${chain}/intents`}
          className="bg-brand text-brand-foreground focus-visible:ring-ring inline-flex h-10 items-center rounded-md px-5 text-sm transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
        >
          Go to intents
        </Link>
        <Link
          href={`/${chain}/apps`}
          className="border-border hover:bg-muted/60 focus-visible:ring-ring inline-flex h-10 items-center rounded-md border px-5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
        >
          Browse apps
        </Link>
      </div>
    </>
  )
}
