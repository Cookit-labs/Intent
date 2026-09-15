'use client'

import { Card } from '@intent/ui'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, ExternalLink } from 'lucide-react'

import { useWallet } from '../../hooks/use-wallet'
import { useBlendPosition } from '../../hooks/use-blend-position'
import type { OpenOffer } from '../../lib/swap/offers'
import { blendPositionUrl } from '../../lib/swap/contract-registry'
import { TokenIcon } from '../ui/token-icon'

/**
 * Everything still live, above everything already finished.
 *
 * History conflated two different kinds of thing: a settled swap is a record of
 * something that happened and needs no further decision, while a resting order
 * or a lending position is money still committed and still the user's to act
 * on. Listing them together by timestamp buried the second kind among the
 * first — a limit order placed yesterday sat below three swaps from this
 * morning, so the things needing attention were the hardest to find.
 *
 * Read from the network, never from what this app recorded. An order can fill
 * or be cancelled from another wallet, and a lending position grows every
 * ledger — so a stored copy is wrong the moment it is written.
 */
async function loadOffers(account: string): Promise<OpenOffer[]> {
  const res = await fetch(`/api/offers?account=${encodeURIComponent(account)}`)
  if (!res.ok) throw new Error('could not read open orders')
  const body = (await res.json()) as { offers?: OpenOffer[] }
  return body.offers ?? []
}

function amount(raw: string): string {
  const n = Number(raw)
  if (!Number.isFinite(n)) return raw
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 })
}

export function OpenPositions(): JSX.Element | null {
  const { address, isConnected } = useWallet()
  const { position } = useBlendPosition()

  const { data: offers } = useQuery({
    queryKey: ['open-offers', address],
    queryFn: () => loadOffers(address as string),
    enabled: isConnected && address !== undefined,
    refetchInterval: 15_000,
  })

  const resting = offers ?? []
  const count = resting.length + (position != null ? 1 : 0)

  // Nothing open is a perfectly good state and says so once, rather than
  // rendering an empty titled section that reads as something failing to load.
  if (!isConnected || count === 0) return null

  return (
    <div className="flex flex-col gap-3">
      <div className="text-muted-foreground flex items-baseline justify-between text-xs">
        <span>Open positions</span>
        <span>{count}</span>
      </div>

      {/* Lending first: it earns continuously and has no expiry, so it is the
          position most easily forgotten. */}
      {position != null ? (
        <Card className="flex items-center gap-4 p-4">
          <TokenIcon symbol={position.symbol} size={28} />

          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-semibold">Supplied to Blend</span>
              <span className="text-muted-foreground text-xs">earning</span>
            </div>
            <div className="mt-1.5 text-sm font-medium tabular-nums">
              {amount(position.display)} {position.symbol}
            </div>
          </div>

          <a
            href={blendPositionUrl()}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs transition-colors"
          >
            Manage
            <ExternalLink className="h-3 w-3" />
          </a>
        </Card>
      ) : null}

      {resting.map((offer) => (
        <Card key={offer.id} className="flex items-center gap-4 p-4">
          <TokenIcon symbol={offer.sellingAsset} size={28} />

          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-semibold">Limit order</span>
              <span className="text-muted-foreground text-xs">resting</span>
            </div>
            <div className="mt-1.5 flex items-center gap-2 text-sm tabular-nums">
              <span className="font-medium">
                {amount(offer.remaining)} {offer.sellingAsset}
              </span>
              <ArrowRight className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
              <span className="text-muted-foreground flex items-center gap-1.5">
                <TokenIcon symbol={offer.buyingAsset} size={18} />
                {offer.buyingAsset}
              </span>
            </div>
          </div>

          <span className="text-muted-foreground text-xs tabular-nums">@ {offer.price}</span>
        </Card>
      ))}
    </div>
  )
}
