import { CHAIN_DESCRIPTORS, parseChainSegment } from '@intent/config'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { TokenExplorer } from '../../../components/tokens/token-explorer'

export const metadata: Metadata = { title: 'Tokens' }

export default async function TokensPage({
  params,
}: {
  params: Promise<{ chain: string }>
}): Promise<JSX.Element> {
  const route = parseChainSegment((await params).chain)
  if (route === undefined || route.slug === 'arc') notFound()
  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
      <div className="mb-8">
        <h1 className="font-display text-3xl font-semibold tracking-tight">Tokens</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          What trades on {CHAIN_DESCRIPTORS[route.slug].name}, who has verified it, and how deep it
          runs.
        </p>
      </div>
      <TokenExplorer />
    </div>
  )
}
