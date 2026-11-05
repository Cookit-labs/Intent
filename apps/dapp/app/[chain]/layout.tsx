import { chainSegments, parseChainSegment } from '@intent/config'
import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'

import { WalletGate } from '../../components/connect/wallet-gate'
import { ChatHost } from '../../components/intents/chat-host'
import { AppShell } from '../../components/layout/app-shell'
import { BetaChainNotice } from '../../components/layout/beta-chain-notice'
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
export default async function ChainLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ chain: string }>
}): Promise<JSX.Element> {
  const { chain } = await params
  // An unknown slug is a 404 rather than a silent fallback to Arc: quietly
  // showing a different chain than the URL names would be worse than an error.
  if (parseChainSegment(chain) === undefined) notFound()

  // For the browser tests, which have no wallet. Needs the server's own setting
  // as well as the cookie, so a visitor cannot switch the gate off in production.
  const bypass =
    process.env['E2E_WALLET_GATE_BYPASS'] === '1' &&
    (await cookies()).get('e2e-no-wallet-gate') !== undefined

  return (
    <ChainProvider segment={chain}>
      <WalletGate bypass={bypass}>
        <BetaChainNotice />
        <AppShell>
          <ChatHost key={chain}>{children}</ChatHost>
        </AppShell>
      </WalletGate>
    </ChainProvider>
  )
}

export function generateStaticParams(): { chain: string }[] {
  return chainSegments().map((chain) => ({ chain }))
}
