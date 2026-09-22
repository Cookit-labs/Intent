'use client'

import { Button, Card } from '@intent/ui'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { ArrowRight, ExternalLink } from 'lucide-react'

import { useWallet } from '../../hooks/use-wallet'
import { useBlendPosition } from '../../hooks/use-blend-position'
import { useWithdraw } from '../../hooks/use-withdraw'
import { useBorrow } from '../../hooks/use-borrow'
import { useCollateral } from '../../hooks/use-collateral'
import { useWithdrawalStatus } from '../../hooks/use-withdrawal-status'
import { BorrowConfirm } from './borrow-confirm'
import { LIQUIDATION_HF, MINIMUM_SAFE_HF } from '../../lib/lend/health'
import { loadTurns } from '../../lib/chat-history'
import { lookupAnchor } from '../../lib/offramp/anchors'
import { pendingWithdrawals } from '../../lib/offramp/pending-withdrawals'
import type { OpenOffer } from '../../lib/swap/offers'
import { blendPositionUrl } from '../../lib/swap/contract-registry'
import { toBaseUnits } from '../../lib/swap/assets'
import { useChain } from '../../providers/chain-provider'
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

/**
 * What this pool lends.
 *
 * Read from the pool's reserve list rather than a ticker table: Blend's USDC
 * is a different issuer from Circle's, so an asset that looks familiar can be
 * one this pool has never heard of. These four are its whole reserve list,
 * confirmed by reading each contract's own `symbol` rather than inferring it.
 */
const BORROWABLE = [
  { id: 'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU', symbol: 'USDC' },
  { id: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC', symbol: 'XLM' },
  { id: 'CAP5AMC2OHNVREO66DFIN6DHJMPOBAJ2KCDDIMFBR7WWJH5RZBFM3UEI', symbol: 'wBTC' },
  { id: 'CAZAQB3D7KSLSNOSQKYD2V4JP5V2Y3B4RDJZRLBFCCIXDCTE3WHSY3UE', symbol: 'wETH' },
]

/** How a health factor reads to somebody who has never seen one. */
function healthTone(hf: number | undefined): string {
  if (hf === undefined) return 'text-muted-foreground'
  if (hf < LIQUIDATION_HF) return 'text-destructive'
  if (hf < MINIMUM_SAFE_HF) return 'text-foreground'
  return 'text-muted-foreground'
}

export function OpenPositions(): JSX.Element | null {
  const { address, isConnected } = useWallet()
  const { position, positions } = useBlendPosition()
  const withdraw = useWithdraw()
  const borrow = useBorrow()
  const queryClient = useQueryClient()
  // What the user has typed, held as text rather than a number: a half-written
  // "5." is a valid thing to be typing and not a valid number.
  const [draft, setDraft] = useState('')
  const [borrowDraft, setBorrowDraft] = useState('')
  const [borrowAsset, setBorrowAsset] = useState(BORROWABLE[0]?.id ?? '')
  // Posting collateral is a `submit` like any other, so it reuses the same
  // build-review-sign machinery rather than a bespoke path.
  const collateral$ = useCollateral()

  // Withdrawals the anchor has not finished, read from history rather than
  // tracked separately — the same record a reopened conversation shows.
  const { adapter } = useChain()
  const slug = adapter.descriptor.slug
  const withdrawals = useWithdrawalStatus()
  const [pending, setPending] = useState(() => pendingWithdrawals(loadTurns(slug)))
  useEffect(() => {
    setPending(pendingWithdrawals(loadTurns(slug)))
  }, [slug, withdrawals.busy])

  const { data: offers } = useQuery({
    queryKey: ['open-offers', address],
    queryFn: () => loadOffers(address as string),
    enabled: isConnected && address !== undefined,
    refetchInterval: 15_000,
  })

  /**
   * Converts part of a plain supply into collateral.
   *
   * Confirmed first, because this is the step that spends the guarantee: a
   * plain supply cannot be liquidated and collateral can, and no other action
   * in this app changes that. The wallet prompt that follows says nothing
   * about seizure, so the app has to.
   */
  function postCollateral(baseUnits: string, assetId: string, symbol: string): void {
    const display = (Number(baseUnits) / 1e7).toLocaleString(undefined, {
      maximumFractionDigits: 7,
    })
    const agreed = window.confirm(
      `Post ${display} ${symbol} as collateral?\n\n` +
        'It keeps earning, and it can back a loan. It can also be taken from you if a loan ' +
        'you open against it falls below its liquidation threshold.\n\n' +
        'A plain supply carries no such risk. This one will.'
    )
    if (!agreed) return

    collateral$.prepare({ assetId, symbol, amount: baseUnits })
  }

  // A settled withdrawal has moved the money, so the balance above it is now
  // describing a position that no longer exists in that size. Re-read rather
  // than waiting for the next poll: a row still showing the old figure right
  // after a successful withdrawal reads as the withdrawal having failed.
  useEffect(() => {
    if (withdraw.phase !== 'settled') return
    void queryClient.invalidateQueries({ queryKey: ['blend-position', address] })
  }, [withdraw.phase, queryClient, address])

  const resting = offers ?? []
  const collateral = positions?.collateral ?? []
  const borrowed = positions?.borrowed ?? []
  const count =
    resting.length +
    (position != null ? 1 : 0) +
    collateral.length +
    borrowed.length +
    pending.length

  const busy = withdraw.phase !== 'idle'
  const typed = position == null ? undefined : typedBaseUnits(draft, position.amount)

  // A borrow is not bounded by a balance the way a withdrawal is, so this
  // only checks the figure is well formed. The pool decides whether the
  // collateral supports it, and the card shows where that would leave the
  // position before anything is signed.
  const borrowUnits = ((): string | undefined => {
    const trimmed = borrowDraft.trim()
    if (trimmed === '') return undefined
    try {
      const base = toBaseUnits(trimmed)
      return BigInt(base) > BigInt(0) ? base : undefined
    } catch {
      return undefined
    }
  })()

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
            {/* The one action here that takes a guarantee away. A plain supply
                cannot be liquidated; collateral can. Typing an amount and
                pressing this converts that much of it, and the confirmation
                says so plainly rather than treating it as a transfer. */}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                if (typed === undefined) return
                postCollateral(typed, position.assetId, position.symbol)
              }}
              disabled={busy || typed === undefined || collateral$.phase !== 'idle'}
            >
              As collateral
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

      {/* Posting collateral, awaiting its signature. Deliberately spells out
          what changes rather than showing an amount and a button: this is the
          one action here that takes a guarantee away. */}
      {collateral$.phase !== 'idle' ? (
        <Card className="flex flex-col gap-3 p-5">
          {collateral$.phase === 'failed' ? (
            <>
              <div className="text-sm font-medium">That did not go ahead</div>
              <p className="text-muted-foreground text-sm">
                {collateral$.error ?? 'Something went wrong.'}
              </p>
              <p className="text-muted-foreground text-xs">
                Nothing moved, and your supply is unchanged.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={collateral$.reset}
                className="self-start"
              >
                Start over
              </Button>
            </>
          ) : collateral$.phase === 'settled' ? (
            <>
              <div className="text-sm font-medium">Posted as collateral</div>
              <p className="text-muted-foreground text-sm">
                It keeps earning, and it can now back a loan — and be seized if one goes underwater.
              </p>
              <div className="flex items-center gap-3">
                {collateral$.explorerUrl !== undefined ? (
                  <a
                    href={collateral$.explorerUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs transition-colors"
                  >
                    View transaction
                    <ExternalLink className="h-3 w-3" />
                  </a>
                ) : null}
                <Button variant="outline" size="sm" onClick={collateral$.reset}>
                  Done
                </Button>
              </div>
            </>
          ) : collateral$.phase === 'building' ? (
            <p className="text-muted-foreground text-sm">Checking the pool will accept it…</p>
          ) : (
            <>
              <div className="text-sm font-semibold">
                Post {amount(String(Number(collateral$.amount ?? '0') / 1e7))}{' '}
                {collateral$.asset ?? ''} as collateral
              </div>
              <p className="text-muted-foreground text-sm">
                This much of your supply stops being untouchable. It keeps earning the same yield,
                and it becomes seizable if a loan you open against it falls below its liquidation
                threshold.
              </p>
              <div className="flex items-center gap-3">
                <Button
                  size="sm"
                  onClick={collateral$.confirm}
                  disabled={collateral$.phase === 'signing' || collateral$.phase === 'submitting'}
                >
                  {collateral$.phase === 'signing'
                    ? 'Waiting for your wallet…'
                    : collateral$.phase === 'submitting'
                      ? 'Submitting…'
                      : 'Post collateral'}
                </Button>
                {collateral$.phase === 'review' ? (
                  <Button variant="outline" size="sm" onClick={collateral$.reset}>
                    Cancel
                  </Button>
                ) : null}
              </div>
            </>
          )}
        </Card>
      ) : null}

      {/* Collateral, kept visually distinct from a plain supply because the
          difference is whether it can be taken. Both earn; only this one backs
          a loan. */}
      {collateral.map((held) => (
        <Card key={`collateral-${held.assetId}`} className="flex items-center gap-4 p-4">
          <TokenIcon symbol={held.symbol} size={28} />

          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-semibold">Collateral in Blend</span>
              <span className="text-muted-foreground text-xs">backing your loans</span>
            </div>
            <div className="mt-1.5 text-sm font-medium tabular-nums">
              {amount(held.display)} {held.symbol}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {/* Which asset to borrow, since it is rarely the one posted. The
                pool lends four and they are not interchangeable — wBTC at
                $100,000 against XLM at $0.42 means a typo of one decimal is
                the difference between a safe loan and an instant liquidation. */}
            <select
              value={borrowAsset}
              onChange={(e) => setBorrowAsset(e.target.value)}
              aria-label="Asset to borrow"
              disabled={borrow.phase !== 'idle'}
              className="border-border bg-background rounded-md border px-2 py-1.5 text-sm outline-none disabled:opacity-50"
            >
              {BORROWABLE.map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {asset.symbol}
                </option>
              ))}
            </select>
            <input
              value={borrowDraft}
              onChange={(e) => setBorrowDraft(e.target.value)}
              inputMode="decimal"
              placeholder="Amount"
              aria-label="Amount to borrow"
              disabled={borrow.phase !== 'idle'}
              className="border-border bg-background focus:border-foreground/40 w-24 rounded-md border px-2 py-1.5 text-sm tabular-nums outline-none transition-colors disabled:opacity-50"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                if (borrowUnits === undefined) return
                borrow.prepare('borrow', {
                  assetId: borrowAsset,
                  symbol: BORROWABLE.find((a) => a.id === borrowAsset)?.symbol ?? '',
                  amount: borrowUnits,
                })
              }}
              disabled={borrow.phase !== 'idle' || borrowUnits === undefined}
            >
              Borrow
            </Button>
          </div>
        </Card>
      ))}

      {/* Debt. The only row here that grows on its own. */}
      {borrowed.map((owed) => (
        <Card key={`debt-${owed.assetId}`} className="flex items-center gap-4 p-4">
          <TokenIcon symbol={owed.symbol} size={28} />

          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-semibold">Borrowed from Blend</span>
              {positions?.health.healthFactor !== undefined ? (
                <span className={`text-xs ${healthTone(positions.health.healthFactor)}`}>
                  health {positions.health.healthFactor.toFixed(2)}
                </span>
              ) : null}
            </div>
            <div className="mt-1.5 text-sm font-medium tabular-nums">
              {amount(owed.display)} {owed.symbol}
            </div>
            {/* Said on the row rather than only in a card, because this is the
                number somebody checks without meaning to open anything. */}
            {positions?.liquidationPrice !== undefined ? (
              <div className="text-muted-foreground mt-1 text-xs tabular-nums">
                liquidates if collateral falls to ${positions.liquidationPrice.toFixed(4)}
              </div>
            ) : null}
          </div>

          <Button
            size="sm"
            variant="outline"
            onClick={() => borrow.prepare('repay', { assetId: owed.assetId, symbol: owed.symbol })}
            disabled={borrow.phase !== 'idle'}
          >
            Repay all
          </Button>
        </Card>
      ))}

      <BorrowConfirm
        borrow={borrow}
        {...(positions?.health !== undefined ? { projected: positions.health } : {})}
        liquidationPrice={positions?.liquidationPrice}
        collateralSymbol={collateral[0]?.symbol}
      />

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

      {pending.map((w) => {
        const anchor = lookupAnchor(w.anchor.id)
        const status = w.anchor.lastStatus ?? 'sent'
        return (
          <Card
            key={`withdrawal-${w.anchor.transactionId}`}
            className="flex items-center gap-4 p-4"
          >
            <TokenIcon symbol="USDC" size={28} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-semibold">
                  Withdrawal via {anchor?.name ?? w.anchor.id}
                </span>
                {/* on_hold is compliance review and can last days; it reads as
                    waiting, never as a fault. */}
                <span className="text-muted-foreground text-xs">
                  {status === 'on_hold' ? 'under review' : status.replace(/_/g, ' ')}
                </span>
              </div>
              <div className="text-muted-foreground mt-1.5 text-xs">{w.label}</div>
              {withdrawals.error !== undefined ? (
                <div className="text-muted-foreground mt-1 text-xs">{withdrawals.error}</div>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void withdrawals.refresh(w.turnId, w.anchor, slug)}
                disabled={withdrawals.busy}
              >
                {withdrawals.busy ? 'Checking…' : 'Check status'}
              </Button>
              {w.anchor.moreInfoUrl !== undefined ? (
                <a
                  href={w.anchor.moreInfoUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs transition-colors"
                >
                  At the anchor
                  <ExternalLink className="h-3 w-3" />
                </a>
              ) : null}
            </div>
          </Card>
        )
      })}
    </div>
  )
}
