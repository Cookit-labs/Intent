'use client'

import { Card } from '@intent/ui'

import { IntentActivity } from '../../../components/intents/intent-activity'
import { OpenPositions } from '../../../components/intents/open-positions'
import { SwapHistory } from '../../../components/intents/swap-history'
import { useWallet } from '../../../hooks/use-wallet'

/**
 * Everything a wallet has done here, on its own page.
 *
 * Gated on a connected wallet rather than on a session: the rows are the
 * wallet's trades, orders and positions, and with no wallet there is nothing
 * to show and nobody to show it to.
 */
export default function HistoryPage(): JSX.Element {
  const { isConnected } = useWallet()

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-10">
      <div className="mb-8">
        <h1 className="font-display text-3xl font-semibold tracking-tight">History</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Every intent, order and position of the connected wallet, as it settled.
        </p>
      </div>

      {isConnected ? (
        <div className="flex flex-col gap-8">
          {/* Anything still live comes first. A settled swap is a record and
              needs no decision; a resting order or a lending position is money
              still committed. */}
          <OpenPositions />
          {/* On-chain swaps before tracked intents: they are the trades that
              actually happened. */}
          <SwapHistory />
          <IntentActivity />
        </div>
      ) : (
        <Card className="p-12 text-center">
          <p className="text-muted-foreground text-sm">Connect a wallet to see its history.</p>
        </Card>
      )}
    </div>
  )
}
