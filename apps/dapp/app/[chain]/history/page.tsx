'use client'

import { Card } from '@intent/ui'

import { ChainPositions } from '../../../components/intents/chain-positions'
import { IntentActivity } from '../../../components/intents/intent-activity'
import { OpenPositions } from '../../../components/intents/open-positions'
import { SwapHistory } from '../../../components/intents/swap-history'
import { useWallet } from '../../../hooks/use-wallet'
import { useWalletHistory } from '../../../hooks/use-wallet-history'
import { chainPositionsSource, composeInviteShown } from '../../../lib/chains/activity'
import { useChain } from '../../../providers/chain-provider'

/**
 * Everything a wallet has done here, on its own page.
 *
 * Gated on a connected wallet rather than on a session: the rows are the
 * wallet's trades, orders and positions, and with no wallet there is nothing
 * to show and nobody to show it to.
 */
export default function HistoryPage(): JSX.Element {
  const { isConnected } = useWallet()
  const { slug } = useChain()
  const history = useWalletHistory()
  const positions = chainPositionsSource(slug)

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
              still committed. Each chain asks its own reader: Blend, the book and the
              pools only exist on Stellar, and would refuse any other chain's address. */}
          {positions === 'blend' ? <OpenPositions /> : null}
          {positions === 'venues' ? <ChainPositions /> : null}
          {/* On-chain swaps before tracked intents: they are the trades that
              actually happened. */}
          <SwapHistory />
          <IntentActivity
            firstIntent={composeInviteShown({
              rows: history.hasActivity ? 1 : 0,
              settled: history.settled,
            })}
          />
        </div>
      ) : (
        <Card className="p-12 text-center">
          <p className="text-muted-foreground text-sm">Connect a wallet to see its history.</p>
        </Card>
      )}
    </div>
  )
}
