'use client'

import { Button, Card } from '@intent/ui'
import { CheckCircle2, ExternalLink, Loader2, TriangleAlert } from 'lucide-react'

import type { Borrow } from '../../hooks/use-borrow'
import { LIQUIDATION_HF, MINIMUM_SAFE_HF } from '../../lib/lend/health'
import type { PositionHealth } from '../../lib/lend/health'

/**
 * Reviewing a borrow, and what it would cost if the market moves.
 *
 * This is the only card in the app that describes a risk the user keeps after
 * signing. A swap settles; an order rests harmlessly; a supply earns. A borrow
 * accrues interest and can be liquidated while nobody is watching, so the card
 * has to say what would have to happen for that, in numbers, before the
 * signature rather than after.
 *
 * **The health factor shown is the projected one, not the current one.** A user
 * deciding whether to borrow needs to know where they will be, not where they
 * are. Showing the current figure beside a borrow that would halve it would be
 * accurate and useless.
 *
 * Testnet oracle prices are mock and admin-settable — XLM at $0.42 against a
 * real market near $0.19 — so every figure here is true for testnet and says
 * nothing about mainnet. The card says so rather than implying a precision it
 * does not have.
 */

function display(baseUnits: string | undefined): string | undefined {
  if (baseUnits === undefined) return undefined
  const n = Number(baseUnits) / 1e7
  if (!Number.isFinite(n)) return undefined
  return n.toLocaleString(undefined, { maximumFractionDigits: 7 })
}

/** How a health factor reads to someone who has never seen one. */
function healthLabel(hf: number | undefined): { text: string; tone: 'safe' | 'tight' | 'danger' } {
  if (hf === undefined) return { text: 'nothing borrowed', tone: 'safe' }
  if (hf < LIQUIDATION_HF) return { text: 'liquidatable now', tone: 'danger' }
  if (hf < MINIMUM_SAFE_HF) return { text: 'close to liquidation', tone: 'tight' }
  if (hf < 2) return { text: 'some room', tone: 'tight' }
  return { text: 'comfortable', tone: 'safe' }
}

export function BorrowConfirm({
  borrow,
  /** Where the position would stand if this were signed. */
  projected,
  /** The collateral price at which liquidation would begin. */
  liquidationPrice,
  /** What that collateral is worth now, for the fall-to-liquidation figure. */
  currentPrice,
  collateralSymbol,
}: {
  borrow: Borrow
  projected?: PositionHealth | undefined
  liquidationPrice?: number | undefined
  currentPrice?: number | undefined
  collateralSymbol?: string | undefined
}): JSX.Element | null {
  const { phase, direction } = borrow

  if (phase === 'idle') return null

  const verb = direction === 'repay' ? 'repayment' : 'borrow'

  if (phase === 'building') {
    return (
      <Card className="text-muted-foreground flex items-center gap-2 p-5 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        {direction === 'repay' ? 'Checking what you owe…' : 'Checking the pool will lend it…'}
      </Card>
    )
  }

  if (phase === 'failed') {
    return (
      <Card className="flex flex-col gap-3 p-5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <TriangleAlert className="h-4 w-4" />
          This {verb} did not go ahead
        </div>
        <p className="text-muted-foreground text-sm">{borrow.error ?? 'Something went wrong.'}</p>
        {/* A refusal that clears on its own is a different instruction from one
            that does not, and the contract reports both identically. */}
        {borrow.transient === true ? (
          <p className="text-muted-foreground text-xs">
            This one may clear by itself — the pool frees up as borrowers repay. Nothing about your
            position needs to change.
          </p>
        ) : null}
        <p className="text-muted-foreground text-xs">
          Nothing moved, and your position is unchanged.
        </p>
        <Button variant="outline" size="sm" onClick={borrow.reset} className="self-start">
          Start over
        </Button>
      </Card>
    )
  }

  if (phase === 'settled') {
    return (
      <Card className="flex flex-col gap-3 p-5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <CheckCircle2 className="h-4 w-4" />
          {direction === 'repay' ? 'Repaid' : 'Borrowed to your wallet'}
        </div>
        <p className="text-muted-foreground text-sm">
          {direction === 'repay'
            ? borrow.everything === true
              ? `Your ${borrow.asset ?? ''} debt is cleared.`
              : `${display(borrow.amount) ?? ''} ${borrow.asset ?? ''} repaid.`
            : `${display(borrow.amount) ?? ''} ${borrow.asset ?? ''} is in your wallet. Interest accrues from now.`}
        </p>
        <div className="flex items-center gap-3">
          {borrow.explorerUrl !== undefined ? (
            <a
              href={borrow.explorerUrl}
              target="_blank"
              rel="noreferrer"
              className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs transition-colors"
            >
              View transaction
              <ExternalLink className="h-3 w-3" />
            </a>
          ) : null}
          <Button variant="outline" size="sm" onClick={borrow.reset}>
            Done
          </Button>
        </div>
      </Card>
    )
  }

  const busy = phase === 'signing' || phase === 'submitting'
  const health = healthLabel(projected?.healthFactor)
  const tooRisky =
    direction === 'borrow' &&
    projected?.healthFactor !== undefined &&
    projected.healthFactor < MINIMUM_SAFE_HF

  const fallToLiquidation =
    liquidationPrice !== undefined && currentPrice !== undefined && currentPrice > 0
      ? ((currentPrice - liquidationPrice) / currentPrice) * 100
      : undefined

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div>
        <div className="text-sm font-semibold">
          {direction === 'repay' ? 'Repay' : 'Borrow'}{' '}
          {borrow.everything === true ? 'everything' : (display(borrow.amount) ?? '')}{' '}
          {borrow.asset ?? ''}
        </div>
        <p className="text-muted-foreground mt-1 text-sm">
          {direction === 'repay'
            ? 'Clearing a debt returns the collateral behind it to your control.'
            : 'Borrowed against the collateral you have posted. Interest accrues from the moment it settles.'}
        </p>
      </div>

      {/* The risk panel. Only meaningful for a borrow: a repayment can only
          improve a position, so projecting one would be noise. */}
      {direction === 'borrow' && projected !== undefined ? (
        <div className="border-border flex flex-col gap-2 rounded-xl border p-4 text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-muted-foreground text-xs">Health factor after this</span>
            <span className="font-medium tabular-nums">
              {projected.healthFactor?.toFixed(2) ?? '—'}{' '}
              <span
                className={
                  health.tone === 'danger'
                    ? 'text-destructive text-xs font-normal'
                    : 'text-muted-foreground text-xs font-normal'
                }
              >
                {health.text}
              </span>
            </span>
          </div>

          {liquidationPrice !== undefined ? (
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-muted-foreground text-xs">
                {collateralSymbol ?? 'Collateral'} liquidates at
              </span>
              <span className="font-medium tabular-nums">
                ${liquidationPrice.toFixed(4)}
                {fallToLiquidation !== undefined ? (
                  <span className="text-muted-foreground ml-1.5 text-xs font-normal">
                    a {fallToLiquidation.toFixed(0)}% fall
                  </span>
                ) : null}
              </span>
            </div>
          ) : null}

          <p className="text-muted-foreground mt-1 text-xs">
            Below {LIQUIDATION_HF.toFixed(2)} anyone can repay your debt and take the collateral
            behind it. Interest pushes the health factor down on its own, without the price moving
            at all.
          </p>
        </div>
      ) : null}

      {/* Refusing outright rather than warning. A position that is legal to
          open is not necessarily one worth opening: at the edge, the next
          ledger's interest alone can open a liquidation. */}
      {tooRisky ? (
        <p className="text-destructive text-xs">
          This would leave the position below {MINIMUM_SAFE_HF.toFixed(2)}, close enough that
          ordinary interest could trigger a liquidation. Borrow less, or post more collateral.
        </p>
      ) : null}

      <p className="text-muted-foreground text-xs">
        Testnet prices come from the pool&apos;s own oracle and are set by its administrators, so
        these figures describe testnet only.
      </p>

      <div className="flex items-center gap-3">
        <Button size="sm" onClick={borrow.confirm} disabled={busy || tooRisky}>
          {busy ? (
            <span className="flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {phase === 'signing' ? 'Waiting for your wallet…' : 'Submitting…'}
            </span>
          ) : direction === 'repay' ? (
            'Repay'
          ) : (
            'Borrow'
          )}
        </Button>
        {!busy ? (
          <Button variant="outline" size="sm" onClick={borrow.reset}>
            Cancel
          </Button>
        ) : null}
      </div>
    </Card>
  )
}
