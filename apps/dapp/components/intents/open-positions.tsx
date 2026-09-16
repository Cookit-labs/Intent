'use client'

import { Button, Card } from '@intent/ui'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { ArrowRight, ExternalLink } from 'lucide-react'

import { useWallet } from '../../hooks/use-wallet'
import { useBlendPosition } from '../../hooks/use-blend-position'
import { useWithdraw } from '../../hooks/use-withdraw'
import type { OpenOffer } from '../../lib/swap/offers'
import { blendPositionUrl } from '../../lib/swap/contract-registry'
import { toBaseUnits } from '../../lib/swap/assets'
import { TokenIcon } from '../ui/token-icon'
import { WithdrawConfirm } from './withdraw-confirm'

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

/**
 * A typed amount as base units, or undefined when it is not one yet.
 *
 * `toBaseUnits` throws on anything that is not a positive decimal of at most
 * seven places, and a throw inside a click handler is silent -- the button
 * would simply do nothing, which is the exact failure shape that took an
 * afternoon to find once already. So the conversion is attempted here, and a
 * value that cannot convert disables the button instead of breaking it.
 *
 * An amount larger than the position is refused rather than clamped. The pool
 * would clamp it, but accepting "9999" against a balance of 5,656 and quietly
 * withdrawing a different number is worse than saying no -- and "All" already
 * expresses "everything" precisely.
 */
function typedBaseUnits(draft: string, heldBase: string): string | undefined {
  const trimmed = draft.trim()
  if (trimmed === '') return undefined

  let base: string
  try {
    base = toBaseUnits(trimmed)
  } catch {
    return undefined
  }

  const value = BigInt(base)
  if (value <= BigInt(0)) return undefined
  if (value > BigInt(heldBase)) return undefined
  return base
}

export function OpenPositions(): JSX.Element | null {
  const { address, isConnected } = useWallet()
  const { position } = useBlendPosition()
  const withdraw = useWithdraw()
  const queryClient = useQueryClient()
  // What the user has typed, held as text rather than a number: a half-written
  // "5." is a valid thing to be typing and not a valid number.
  const [draft, setDraft] = useState('')

  const { data: offers } = useQuery({
    queryKey: ['open-offers', address],
    queryFn: () => loadOffers(address as string),
    enabled: isConnected && address !== undefined,
    refetchInterval: 15_000,
  })

  // A settled withdrawal has moved the money, so the balance above it is now
  // describing a position that no longer exists in that size. Re-read rather
  // than waiting for the next poll: a row still showing the old figure right
  // after a successful withdrawal reads as the withdrawal having failed.
  useEffect(() => {
    if (withdraw.phase !== 'settled') return
    void queryClient.invalidateQueries({ queryKey: ['blend-position', address] })
  }, [withdraw.phase, queryClient, address])

  const resting = offers ?? []
  const count = resting.length + (position != null ? 1 : 0)

  const busy = withdraw.phase !== 'idle'
  const typed = position == null ? undefined : typedBaseUnits(draft, position.amount)

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

          <div className="flex shrink-0 items-center gap-2">
            {/* The reason this section exists. Blend's own dashboard does not
                offer a withdrawal for a plain (non-collateral) supply, which is
                how a real position became visible here and retrievable
                nowhere. */}
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              inputMode="decimal"
              placeholder="Amount"
              aria-label={`Amount of ${position.symbol} to withdraw`}
              disabled={busy}
              className="border-border bg-background focus:border-foreground/40 w-24 rounded-md border px-2 py-1.5 text-sm tabular-nums outline-none transition-colors disabled:opacity-50"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                if (typed === undefined) return
                withdraw.prepare({
                  assetId: position.assetId,
                  symbol: position.symbol,
                  amount: typed,
                })
              }}
              disabled={busy || typed === undefined}
            >
              Withdraw
            </Button>
            {/* Distinct from typing the balance shown. That figure is stale the
                moment it renders -- the position earns every ledger -- so only
                this path can actually empty it. */}
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                withdraw.prepare({ assetId: position.assetId, symbol: position.symbol })
              }
              disabled={busy}
            >
              All
            </Button>
            <a
              href={blendPositionUrl()}
              target="_blank"
              rel="noreferrer"
              className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs transition-colors"
            >
              Manage
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </Card>
      ) : null}

      {/* Sits directly under the position it acts on, so the amount being
          withdrawn and the amount held are readable together. */}
      <WithdrawConfirm withdraw={withdraw} />

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
