import { isChainSlug } from '@intent/config'
import { notFound } from 'next/navigation'

import { AppShell } from '../../components/layout/app-shell'
import { ChainProvider } from '../../providers/chain-provider'

/**
 * Every dApp screen lives under a chain segment, so the chain a user is looking
 * at is in the URL rather than hidden in client state — links are shareable and
 * a reload cannot lose the chain.
 */
export default function ChainLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: { chain: string }
}): JSX.Element {
  // An unknown slug is a 404 rather than a silent fallback to Arc: quietly
  // showing a different chain than the URL names would be worse than an error.
  if (!isChainSlug(params.chain)) notFound()

  return (
    <ChainProvider slug={params.chain}>
      <AppShell>{children}</AppShell>
    </ChainProvider>
  )
}

export function generateStaticParams(): { chain: string }[] {
  return [{ chain: 'arc' }, { chain: 'stellar' }]
}
