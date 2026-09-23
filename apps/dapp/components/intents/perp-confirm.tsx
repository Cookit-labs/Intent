'use client'

import { Button, Card } from '@intent/ui'
import { CheckCircle2, ExternalLink, Loader2, TriangleAlert } from 'lucide-react'

import type { Perp } from '../../hooks/use-perp'
import { fromBaseUnits } from '../../lib/swap/assets'

/**
 * Reviewing a leveraged position before it is signed.
 *
 * Heavier than the supply card, and it has to be. A supply cannot be
 * liquidated; this can, at a price the contract computes, and the person
 * signing should read that price before the wallet prompt rather than learn
 * it from a closed position. Every figure here is what the server read from
 * the gateway and the simulation — nothing is derived on the client.
 *
 * "Simulated" is not hedging. The entry and liquidation prices come from
 * simulating the prepared envelope against the contract at the current
 * oracle price; the oracle moves before inclusion and the contract will set
 * its own figures then.
 */

function usd(baseUnits: string | undefined, digits = 2): string {
  if (baseUnits === undefined) return '—'
  const n = Number(fromBaseUnits(baseUnits))
  if (!Number.isFinite(n)) return '—'
  return n.toLocaleString(undefined, { maximumFractionDigits: digits })
}

function price(baseUnits: string | undefined): string {
  return usd(baseUnits, 7)
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-6)}` : id
}

export function PerpConfirm({ perp }: { perp: Perp }): JSX.Element | null {
  const { phase, order, prepared } = perp

  if (phase === 'idle') return null

  const headline =
    order !== undefined
      ? `${order.side === 'long' ? 'Long' : 'Short'} ${order.asset} at ${order.leverage}x with ${order.collateral} USDC`
      : 'Open a position'

  if (phase === 'authenticating') {
    return (
      <Card className="flex flex-col gap-3 p-5">
        <div className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Signing in with Noether…
        </div>
        {/* The one wallet prompt here that moves nothing. Said, because a
            prompt right after "long XLM" reads as the position itself. */}
        <p className="text-muted-foreground text-xs">
          Your wallet will ask you to sign a message proving you own this account, so Noether can
          issue an API key for it. It cannot be submitted to the network and moves no funds.
        </p>
      </Card>
    )
  }

  if (phase === 'building') {
    return (
      <Card className="text-muted-foreground flex items-center gap-2 p-5 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        Asking Noether to prepare the position, then simulating it…
      </Card>
    )
  }

  if (phase === 'not-in-beta') {
    return (
      <Card className="flex flex-col gap-3 p-5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <TriangleAlert className="h-4 w-4" />
          Noether is in closed beta
        </div>
        <p className="text-muted-foreground text-sm">{perp.error}</p>
        <Button variant="outline" size="sm" onClick={perp.reset} className="self-start">
          Done
        </Button>
      </Card>
    )
  }

  if (phase === 'failed') {
    return (
      <Card className="flex flex-col gap-3 p-5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <TriangleAlert className="h-4 w-4" />
          This position did not open
        </div>
        <p className="text-muted-foreground text-sm">{perp.error ?? 'Something went wrong.'}</p>
        {perp.hash !== undefined ? (
          <p className="text-muted-foreground text-xs">
            The transaction reached the network and failed there; the fee was spent and no position
            exists. Hash {shortId(perp.hash)}.
          </p>
        ) : (
          <p className="text-muted-foreground text-xs">
            A refusal happens before anything is sent. Your collateral is where it was.
          </p>
        )}
        <Button variant="outline" size="sm" onClick={perp.reset} className="self-start">
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
          Position open on Noether
        </div>
        <p className="text-muted-foreground text-sm">{headline}.</p>
        <p className="text-muted-foreground text-xs">
          Closing it is not built here yet. Noether&apos;s own app lists and closes positions.
        </p>
        <div className="flex items-center gap-3">
          {perp.explorerUrl !== undefined ? (
            <a
              href={perp.explorerUrl}
              target="_blank"
              rel="noreferrer"
              className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs transition-colors"
            >
              View transaction
              <ExternalLink className="h-3 w-3" />
            </a>
          ) : null}
          <Button variant="outline" size="sm" onClick={perp.reset}>
            Done
          </Button>
        </div>
      </Card>
    )
  }

  const busy = phase === 'signing' || phase === 'submitting'

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div>
        <div className="text-sm font-semibold">{headline}</div>
        <p className="text-muted-foreground mt-1 text-sm">
          An isolated position on Noether. One transaction, one signature.
          {order?.leverageDefaulted === true
            ? ' No leverage was named, so 1x is assumed; say "5x" to change it.'
            : ''}
        </p>
      </div>

      {prepared !== undefined && order !== undefined ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
          <dt className="text-muted-foreground">Side</dt>
          <dd>
            {order.side === 'long' ? 'Long' : 'Short'} {order.asset}
          </dd>
          <dt className="text-muted-foreground">Size</dt>
          <dd>
            {usd(prepared.size)} USDC notional ({order.collateral} USDC × {order.leverage})
          </dd>
          <dt className="text-muted-foreground">Leverage</dt>
          <dd>{order.leverage}x</dd>
          <dt className="text-muted-foreground">Mark price</dt>
          <dd>${price(prepared.markPrice)}</dd>
          <dt className="text-muted-foreground">Entry price</dt>
          <dd>${price(prepared.entryPrice)} (simulated)</dd>
          <dt className="text-muted-foreground">Liquidation price</dt>
          <dd>${price(prepared.liquidationPrice)} (simulated)</dd>
          {prepared.acceptablePrice !== '0' ? (
            <>
              <dt className="text-muted-foreground">Worst fill</dt>
              <dd>${price(prepared.acceptablePrice)}, else the contract reverts</dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">Funding</dt>
          <dd>
            Not reported by the gateway. The contract accrues funding on the open position; the rate
            is not readable here.
          </dd>
        </dl>
      ) : null}

      <PerpRisks version={prepared?.version} usdcToken={prepared?.usdcToken} />

      <div className="flex items-center gap-3">
        <Button size="sm" onClick={perp.confirm} disabled={busy}>
          {busy ? (
            <span className="flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {phase === 'signing' ? 'Waiting for your wallet…' : 'Submitting…'}
            </span>
          ) : (
            'Sign and open'
          )}
        </Button>
        {!busy ? (
          <Button variant="outline" size="sm" onClick={perp.reset}>
            Cancel
          </Button>
        ) : null}
      </div>
    </Card>
  )
}

/**
 * What opening a leveraged position actually risks, and what the venue is.
 *
 * The liquidation sentence is the one that matters. The rest are measured
 * facts about the venue — dev-tagged gateway, no audit, testnet — stated
 * because a card that looks like every other confirm card would otherwise
 * imply the same standing.
 */
function PerpRisks({
  version,
  usdcToken,
}: {
  version: string | undefined
  usdcToken: string | undefined
}): JSX.Element {
  return (
    <div className="border-border text-muted-foreground flex flex-col gap-1.5 rounded-md border p-3 text-xs">
      <span className="text-foreground font-medium">Before you sign</span>
      <span>
        If the mark price reaches the liquidation price, the position is closed and the collateral
        is lost. Higher leverage puts that price closer.
      </span>
      <span>
        Noether is unaudited and testnet-only. Its gateway reports version {version ?? '0.0.0-dev'};
        mainnet has not launched.
      </span>
      <span>
        Collateral is Noether&apos;s own USDC token
        {usdcToken !== undefined && usdcToken !== '' ? ` (${shortId(usdcToken)})` : ''}, not the
        USDC this app swaps. A balance of the wrong one fails at simulation, before signing.
      </span>
    </div>
  )
}
