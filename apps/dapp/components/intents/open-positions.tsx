'use client'

import { Button, Card } from '@intent/ui'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { ExternalLink } from 'lucide-react'

import { useWallet } from '../../hooks/use-wallet'
import { useBlendPosition } from '../../hooks/use-blend-position'
import { useSupply } from '../../hooks/use-supply'
import { useWithdraw } from '../../hooks/use-withdraw'
import { useBorrow } from '../../hooks/use-borrow'
import { useCollateral } from '../../hooks/use-collateral'
import { useWithdrawalStatus } from '../../hooks/use-withdrawal-status'
import { BorrowConfirm } from './borrow-confirm'
import { LIQUIDATION_HF, MINIMUM_SAFE_HF } from '../../lib/lend/health'
import { blendReserves } from '../../lib/lend/reserves'
import { loadTurns, onTurnsChanged } from '../../lib/chat-history'
import { lookupAnchor } from '../../lib/offramp/anchors'
import { pendingWithdrawals } from '../../lib/offramp/pending-withdrawals'
import type { OpenOffer } from '../../lib/swap/offers'
import { blendPositionUrl } from '../../lib/swap/contract-registry'
import { toBaseUnits } from '../../lib/swap/assets'
import { useChain } from '../../providers/chain-provider'
import { TokenIcon } from '../ui/token-icon'
import { OpenOrders } from './open-orders'
import { PoolPositions, loadPoolShares } from './pool-positions'
import { ManageSheet, PositionList, PositionRow } from './position-card'
import { SupplyConfirm } from './supply-confirm'
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

/** A typed amount, a button for it, and a button for all of it. "All" is the only way to empty one. */
function AmountAction({
  label,
  symbol,
  held,
  busy,
  onSome,
  onAll,
  secondary,
}: {
  label: string
  symbol: string
  /** Base units. A typed figure above this is refused rather than quietly changed. */
  held: string
  busy: boolean
  onSome: (baseUnits: string) => void
  onAll: () => void
  /** A second use for the typed amount. */
  secondary?: { label: string; disabled: boolean; onSome: (baseUnits: string) => void }
}): JSX.Element {
  // Held as text rather than a number: a half-written "5." is a valid thing to
  // be typing and not a valid number.
  const [draft, setDraft] = useState('')
  const typed = typedBaseUnits(draft, held)

  return (
    <div className="flex shrink-0 items-center gap-2">
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        inputMode="decimal"
        placeholder="Amount"
        aria-label={`Amount of ${symbol} to ${label.toLowerCase()}`}
        disabled={busy}
        className="border-border bg-background focus:border-foreground/40 w-24 rounded-md border px-2 py-1.5 text-sm tabular-nums outline-none transition-colors disabled:opacity-50"
      />
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          if (typed !== undefined) onSome(typed)
        }}
        disabled={busy || typed === undefined}
      >
        {label}
      </Button>
      {/* Distinct from typing the balance shown. That figure is stale the moment
          it renders, as interest moves it every ledger, so only this path can
          actually empty it. */}
      <Button size="sm" variant="ghost" onClick={onAll} disabled={busy}>
        All
      </Button>
      {secondary !== undefined ? (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            if (typed !== undefined) secondary.onSome(typed)
          }}
          disabled={busy || typed === undefined || secondary.disabled}
        >
          {secondary.label}
        </Button>
      ) : null}
    </div>
  )
}

/** How a health factor reads to somebody who has never seen one. */
function healthTone(hf: number | undefined): string {
  if (hf === undefined) return 'text-muted-foreground'
  if (hf < LIQUIDATION_HF) return 'text-destructive'
  if (hf < MINIMUM_SAFE_HF) return 'text-foreground'
  return 'text-muted-foreground'
}

export function OpenPositions({
  inChat = false,
}: {
  /** Says so when nothing is open, where a page can simply leave the section out. */
  inChat?: boolean
} = {}): JSX.Element | null {
  const { address, isConnected } = useWallet()
  const { positions, error: blendUnread, loading: blendLoading } = useBlendPosition()
  const withdraw = useWithdraw()
  const supply = useSupply()
  const [openKey, setOpenKey] = useState<string | null>(null)
  const inBase = (amount: string): string | undefined => {
    try {
      return toBaseUnits(amount)
    } catch {
      return undefined
    }
  }
  const borrow = useBorrow()
  const queryClient = useQueryClient()
  // What this network's pool lends: a list for the wrong network offers a loan
  // the pool has never heard of.
  const borrowable = blendReserves()
  const [borrowDraft, setBorrowDraft] = useState('')
  const [borrowAsset, setBorrowAsset] = useState(borrowable[0]?.id ?? '')
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
  }, [slug, withdrawals.refreshed])
  // A withdrawal signed in this session is written to history by the chat,
  // which is a sibling of this component rather than a parent — so without
  // this the row did not appear until a reload, and a withdrawal that had
  // just been paid looked like it had not been recorded at all.
  useEffect(() => onTurnsChanged(() => setPending(pendingWithdrawals(loadTurns(slug)))), [slug])

  const { data: offers, isError: offersUnread } = useQuery({
    queryKey: ['open-offers', address],
    queryFn: () => loadOffers(address as string),
    enabled: isConnected && address !== undefined,
    refetchInterval: 15_000,
  })
  const { data: poolShares, isError: poolsUnread } = useQuery({
    queryKey: ['pool-shares', address],
    queryFn: () => loadPoolShares(address as string),
    enabled: isConnected && address !== undefined,
    refetchInterval: 60_000,
  })

  /**
   * Posts collateral, from the wallet.
   *
   * Confirmed first, because this is the step that takes on the risk: a plain
   * supply cannot be liquidated and collateral can. It does not convert a supply:
   * Blend's `apply_supply_collateral` takes the amount from the spender. The wallet
   * prompt that follows says nothing about seizure, so the app has to.
   */
  function postCollateral(baseUnits: string, assetId: string, symbol: string): void {
    const display = (Number(baseUnits) / 1e7).toLocaleString(undefined, {
      maximumFractionDigits: 7,
    })
    const agreed = window.confirm(
      `Post ${display} ${symbol} from your wallet as collateral?\n\n` +
        'It earns, and it can back a loan. It can also be taken from you if a loan ' +
        'you open against it falls below its liquidation threshold.\n\n' +
        'What you already have supplied stays as it is, and carries no such risk.'
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
  useEffect(() => {
    if (borrow.phase !== 'settled') return
    void queryClient.invalidateQueries({ queryKey: ['blend-position', address] })
  }, [borrow.phase, queryClient, address])
  useEffect(() => {
    if (supply.phase !== 'settled') return
    void queryClient.invalidateQueries({ queryKey: ['blend-position', address] })
  }, [supply.phase, queryClient, address])

  const supplied = positions?.supplied ?? []
  const collateral = positions?.collateral ?? []
  const borrowed = positions?.borrowed ?? []
  const count =
    (offers?.length ?? 0) +
    (poolShares?.length ?? 0) +
    supplied.length +
    collateral.length +
    borrowed.length +
    pending.length

  const busy = withdraw.phase !== 'idle'
  const sheetHeld = supplied.find((held) => `supply-${held.assetId}` === openKey)
  function closeSheet(): void {
    setOpenKey(null)
    if (withdraw.phase === 'settled' || withdraw.phase === 'failed' || withdraw.phase === 'review')
      withdraw.reset()
    if (supply.phase === 'settled' || supply.phase === 'failed' || supply.phase === 'review')
      supply.reset()
  }

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
  // A read that failed is not "nothing open", which is the one thing this must not imply.
  if (!isConnected) return null
  if (count === 0 && !blendUnread && !offersUnread && !poolsUnread) {
    if (!inChat || blendLoading) return null
    return (
      <Card className="text-muted-foreground p-4 text-sm">
        You have nothing open on Stellar. Tokens in your wallet aren’t listed here.
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="text-muted-foreground flex items-baseline justify-between text-xs">
        <span>Open positions</span>
        <span>{count}</span>
      </div>

      {blendUnread ? (
        <Card className="text-muted-foreground p-4 text-sm">
          Could not read your Blend position from the network, so this list may be missing money you
          hold there. It will try again shortly.
        </Card>
      ) : null}

      {/* Lending first: it earns continuously and has no expiry, so it is the
          position most easily forgotten. Every asset, not only XLM: a supply of
          anything else used to be invisible here, and so had no way out. */}
      {supplied.length > 0 ? (
        <PositionList count={supplied.length} heading={false}>
          {supplied.map((held) => (
            <PositionRow
              key={`supply-${held.assetId}`}
              venueId="blend"
              venueName="Blend"
              symbol={held.symbol}
              amount={held.display}
              label="Supplied"
              note="earning"
              onOpen={() => setOpenKey(`supply-${held.assetId}`)}
            />
          ))}
        </PositionList>
      ) : null}

      {sheetHeld !== undefined ? (
        <ManageSheet
          open
          onClose={closeSheet}
          venueId="blend"
          venueName="Blend"
          symbol={sheetHeld.symbol}
          held={sheetHeld.display}
          label="Supplied"
          busy={busy || supply.phase !== 'idle'}
          maxPlaces={7}
          out={{
            label: 'Withdraw',
            onAmount: (amount) => {
              const base = inBase(amount)
              if (base === undefined) return
              withdraw.prepare({
                assetId: sheetHeld.assetId,
                symbol: sheetHeld.symbol,
                amount: base,
                from: 'supply',
              })
            },
          }}
          into={{
            label: 'Top up',
            onAmount: (amount) => {
              const base = inBase(amount)
              if (base === undefined) return
              supply.prepare({ assetId: sheetHeld.assetId, symbol: sheetHeld.symbol, amount: base })
            },
          }}
          all={{
            label: 'Withdraw all',
            onPress: () =>
              withdraw.prepare({
                assetId: sheetHeld.assetId,
                symbol: sheetHeld.symbol,
                from: 'supply',
              }),
          }}
          secondary={{
            label: 'Post this much as collateral instead',
            disabled: collateral$.phase !== 'idle',
            onAmount: (amount) => {
              const base = inBase(amount)
              if (base === undefined) return
              setOpenKey(null)
              postCollateral(base, sheetHeld.assetId, sheetHeld.symbol)
            },
          }}
          review={
            withdraw.phase !== 'idle' ? (
              <WithdrawConfirm withdraw={withdraw} />
            ) : supply.phase !== 'idle' ? (
              <SupplyConfirm supply={supply} />
            ) : undefined
          }
          onBack={
            withdraw.phase === 'review' || withdraw.phase === 'failed'
              ? withdraw.reset
              : supply.phase === 'review' || supply.phase === 'failed'
                ? supply.reset
                : undefined
          }
          extra={
            <a
              href={blendPositionUrl()}
              target="_blank"
              rel="noreferrer"
              className="text-muted-foreground hover:text-foreground mx-auto flex w-fit items-center gap-1 text-xs transition-colors"
            >
              Open on Blend
              <ExternalLink className="h-3 w-3" />
            </a>
          }
        />
      ) : null}

      {/* Sits directly under the position it acts on, so the amount being
          withdrawn and the amount held are readable together. */}
      {openKey === null ? <WithdrawConfirm withdraw={withdraw} /> : null}

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
                Nothing moved, and your wallet is unchanged.
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
                This much moves from your wallet into the pool. It earns the same yield as a supply,
                and it can be seized if a loan you open against it falls below its liquidation
                threshold. What you already have supplied stays as it is.
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
        <Card key={`collateral-${held.assetId}`} className="flex flex-wrap items-center gap-4 p-4">
          <TokenIcon symbol={held.symbol} size={28} />

          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-semibold">Collateral in Blend</span>
              <span className="text-muted-foreground text-xs">
                {borrowed.length > 0 ? 'backing your loans' : 'earning'}
              </span>
            </div>
            <div className="mt-1.5 text-sm font-medium tabular-nums">
              {amount(held.display)} {held.symbol}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* The way out, which this row did not have. The pool pays it to the
                wallet, and refuses if a loan still needs it. */}
            <AmountAction
              label="Withdraw"
              symbol={held.symbol}
              held={held.amount}
              busy={busy}
              onSome={(baseUnits) =>
                withdraw.prepare({
                  assetId: held.assetId,
                  symbol: held.symbol,
                  amount: baseUnits,
                  from: 'collateral',
                })
              }
              onAll={() =>
                withdraw.prepare({
                  assetId: held.assetId,
                  symbol: held.symbol,
                  from: 'collateral',
                })
              }
            />
            {/* Which asset to borrow, since it is rarely the one posted. The
                pool lends several and they are not interchangeable: a typo of
                one decimal is the difference between a safe loan and an instant
                liquidation. */}
            <select
              value={borrowAsset}
              onChange={(e) => setBorrowAsset(e.target.value)}
              aria-label="Asset to borrow"
              disabled={borrow.phase !== 'idle'}
              className="border-border bg-background rounded-md border px-2 py-1.5 text-sm outline-none disabled:opacity-50"
            >
              {borrowable.map((asset) => (
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
                  symbol: borrowable.find((a) => a.id === borrowAsset)?.symbol ?? '',
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
        <Card key={`debt-${owed.assetId}`} className="flex flex-wrap items-center gap-4 p-4">
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

          <AmountAction
            label="Repay"
            symbol={owed.symbol}
            held={owed.amount}
            busy={borrow.phase !== 'idle'}
            onSome={(baseUnits) =>
              borrow.prepare('repay', {
                assetId: owed.assetId,
                symbol: owed.symbol,
                amount: baseUnits,
              })
            }
            onAll={() => borrow.prepare('repay', { assetId: owed.assetId, symbol: owed.symbol })}
          />
        </Card>
      ))}

      <BorrowConfirm
        borrow={borrow}
        {...(positions?.health !== undefined ? { projected: positions.health } : {})}
        liquidationPrice={positions?.liquidationPrice}
        collateralSymbol={collateral[0]?.symbol}
      />

      {/* Read from the ledger, each with its way out. */}
      <OpenOrders account={address} />

      <PoolPositions account={address} />

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
