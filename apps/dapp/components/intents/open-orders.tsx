'use client'

import { Button, Card } from '@intent/ui'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Loader2 } from 'lucide-react'
import { useEffect } from 'react'

import { useLimitOrder, type LimitOrder } from '../../hooks/use-limit-order'
import type { OpenOffer } from '../../lib/swap/offers'
import { TokenIcon } from '../ui/token-icon'

/**
 * Orders currently resting on the book, read from the ledger.
 *
 * Not from anything this app stored. An order can fill, or be cancelled from
 * another wallet, while nobody is looking — so the only trustworthy answer to
 * "what is still open" comes from the network, and asking it again is cheaper
 * than keeping a local copy honest.
 *
 * A shrinking amount is a partial fill, visible without any bookkeeping of our
 * own: Stellar decrements the offer as it trades.
 *
 * Withdrawing runs on its own hook, separate from whatever order is being placed
 * beside it. Sharing one showed a withdrawal as "order placed", and with no order
 * being placed, showed nothing at all, even when it failed.
 */

async function loadOffers(account: string): Promise<OpenOffer[]> {
  const res = await fetch(`/api/offers?account=${encodeURIComponent(account)}`)
  if (!res.ok) throw new Error('could not read open orders')
  const body = (await res.json()) as { offers?: OpenOffer[] }
  return body.offers ?? []
}

function WithdrawStatus({ cancel }: { cancel: LimitOrder }): JSX.Element | null {
  const { phase } = cancel
  if (phase === 'checking' || phase === 'signing' || phase === 'submitting') {
    return (
      <p className="text-muted-foreground flex items-center gap-2 text-xs">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {phase === 'signing' ? 'Waiting for your wallet…' : 'Withdrawing the order…'}
      </p>
    )
  }
  if (phase === 'cancelled') {
    return (
      <p className="text-muted-foreground flex items-center gap-3 text-xs">
        Order withdrawn. What had not traded is back in your wallet.
        {cancel.explorerUrl !== undefined ? (
          <a
            href={cancel.explorerUrl}
            target="_blank"
            rel="noreferrer"
            className="hover:text-foreground flex items-center gap-1 transition-colors"
          >
            View transaction
            <ExternalLink className="h-3 w-3" />
          </a>
        ) : null}
      </p>
    )
  }
  if (phase === 'failed') {
    return (
      <p className="text-muted-foreground text-xs">
        {cancel.error ?? 'The order was not withdrawn.'} It is still resting, and your funds have
        not moved.
      </p>
    )
  }
  return null
}

export function OpenOrders({ account }: { account: string | undefined }): JSX.Element | null {
  const cancel = useLimitOrder()
  const queryClient = useQueryClient()
  const { data, isLoading, error } = useQuery({
    queryKey: ['open-offers', account],
    queryFn: () => loadOffers(account as string),
    enabled: account !== undefined,
    // Often enough to notice a fill without hammering Horizon.
    refetchInterval: 15_000,
  })

  useEffect(() => {
    if (cancel.phase !== 'cancelled') return
    void queryClient.invalidateQueries({ queryKey: ['open-offers', account] })
  }, [cancel.phase, queryClient, account])

  if (account === undefined) return null

  if (isLoading) {
    return (
      <Card className="text-muted-foreground flex items-center gap-2 p-4 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        Reading your open orders…
      </Card>
    )
  }

  if (error !== null) {
    // Distinct from "no orders" on purpose: a user deciding whether to place
    // another needs to know the difference between none and unknown.
    return (
      <Card className="text-muted-foreground p-4 text-sm">
        Could not read your open orders from the network.
      </Card>
    )
  }

  const offers = data ?? []
  const busy =
    cancel.phase === 'checking' || cancel.phase === 'signing' || cancel.phase === 'submitting'

  // The last order just withdrawn still owes its confirmation.
  if (offers.length === 0 && cancel.phase === 'idle') return null

  return (
    <Card className="flex flex-col gap-3 p-4">
      {offers.length > 0 ? (
        <>
          <span className="text-sm font-medium">
            Resting {offers.length === 1 ? 'order' : 'orders'}
          </span>

          <ul className="flex flex-col gap-2">
            {offers.map((offer) => (
              <li
                key={offer.id}
                className="border-border flex items-center justify-between gap-3 rounded-lg border p-3"
              >
                <div className="flex flex-col gap-0.5">
                  <span className="flex items-center gap-2 font-mono text-sm tabular-nums">
                    <TokenIcon symbol={offer.sellingAsset} size={18} />
                    {offer.remaining} {offer.sellingAsset}
                    <span className="text-muted-foreground">for</span>
                    <TokenIcon symbol={offer.buyingAsset} size={18} />
                    {offer.buyingAsset}
                  </span>
                  <span className="text-muted-foreground text-xs tabular-nums">
                    at {offer.price} {offer.buyingAsset} each
                  </span>
                </div>

                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => cancel.cancel(offer.id)}
                >
                  Withdraw
                </Button>
              </li>
            ))}
          </ul>

          <p className="text-muted-foreground text-xs">
            These sit on Stellar and fill on their own. Withdrawing returns whatever has not traded.
          </p>
        </>
      ) : null}

      <WithdrawStatus cancel={cancel} />
    </Card>
  )
}
