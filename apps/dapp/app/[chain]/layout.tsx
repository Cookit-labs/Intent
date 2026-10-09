import { chainSegments, parseChainSegment } from '@intent/config'
import { notFound } from 'next/navigation'

import { AppShell } from '../../components/layout/app-shell'
import { tradeCapUsd } from '../../lib/server/trade-cap'
import { ChainProvider } from '../../providers/chain-provider'

/**
 * Every dApp screen lives under a chain segment, so the chain a user is looking
 * at is in the URL rather than hidden in client state — links are shareable and
 * a reload cannot lose the chain.
 *
 * Rendered per request: with several Stellar networks served, what a page
 * shows depends on the network of the request, which no static render has.
 */
export const dynamic = 'force-dynamic'
export default function ChainLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: { chain: string }
}): JSX.Element {
  // An unknown slug is a 404 rather than a silent fallback to Arc: quietly
  // showing a different chain than the URL names would be worse than an error.
  if (parseChainSegment(params.chain) === undefined) notFound()

  // A misconfigured cap must not take the whole frame down with it; the
  // routes that enforce it report the problem where it matters.
  let cap: number | undefined
  try {
    cap = tradeCapUsd()
  } catch {
    cap = undefined
  }

  return (
    <ChainProvider segment={params.chain}>
      <AppShell tradeCapUsd={cap}>{children}</AppShell>
    </ChainProvider>
  )
}

export function generateStaticParams(): { chain: string }[] {
  return chainSegments().map((chain) => ({ chain }))
}
