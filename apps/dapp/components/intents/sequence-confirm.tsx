'use client'

import { Button, Card } from '@intent/ui'
import { CheckCircle2, Circle, ExternalLink, Loader2, TriangleAlert } from 'lucide-react'

import type { Sequence } from '../../hooks/use-sequence'

/**
 * Reviewing a sequence before signing the first of its steps.
 *
 * A plan card can promise atomicity: Stellar runs every operation or none.
 * A sequence cannot, because **Soroban permits exactly one operation per
 * transaction**, so a swap and a Blend supply are genuinely two signatures.
 *
 * That makes this card's job different. It has to show both steps *before* the
 * first signature, so nobody approves step one without knowing a second is
 * coming, and it has to say plainly where someone stands if they stop partway.
 *
 * Stopping is not a failure. Someone who signs the swap and declines the supply
 * holds the asset — a position, not a stuck state — and this must say so.
 */
export function SequenceConfirm({ sequence }: { sequence: Sequence }): JSX.Element | null {
  const { phase, steps, current } = sequence

  if (phase === 'idle') return null

  if (phase === 'failed') {
    return (
      <Card className="flex flex-col gap-3 p-5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <TriangleAlert className="h-4 w-4" />
          This sequence stopped
        </div>
        <p className="text-muted-foreground text-sm">{sequence.error ?? 'Something went wrong.'}</p>
        <StepList steps={steps} current={current} />
        <Button variant="outline" size="sm" onClick={sequence.reset} className="self-start">
          Start over
        </Button>
      </Card>
    )
  }

  if (phase === 'stopped') {
    return (
      <Card className="flex flex-col gap-3 p-5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <CheckCircle2 className="h-4 w-4" />
          Stopped after step {current}
        </div>
        {/* The sentence that keeps a normal outcome from reading as a fault.
            Branched on kind: an offramp never had a lending position to
            compare against, so that comparison only belongs to swap-then-lend. */}
        <p className="text-muted-foreground text-sm">
          {sequence.kind === 'swap-then-offramp'
            ? 'Nothing went wrong. The swap has settled and you are holding the USDC it delivered. Nothing was sent to the anchor.'
            : sequence.kind === 'offramp-only'
              ? 'Nothing went wrong. Nothing was sent to the anchor; your USDC is where it was.'
              : 'Nothing went wrong. What has already settled stands, and you are holding the asset from it rather than a lending position.'}
        </p>
        <StepList steps={steps} current={current} />
        <Button variant="outline" size="sm" onClick={sequence.reset} className="self-start">
          Done
        </Button>
      </Card>
    )
  }

  if (phase === 'anchor-declined') {
    return (
      <Card className="flex flex-col gap-3 p-5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <TriangleAlert className="h-4 w-4" />
          The anchor ended this withdrawal
        </div>
        {/* Said first, because it is the thing someone reading this needs to
              know: no payment was sent. */}
        <p className="text-muted-foreground text-sm">
          Nothing was sent. {sequence.error ?? ''} You are holding the USDC.
        </p>
        <StepList steps={steps} current={current} />
        <Button variant="outline" size="sm" onClick={sequence.reset} className="self-start">
          Done
        </Button>
      </Card>
    )
  }

  if (phase === 'authenticating') {
    return (
      <Card className="flex flex-col gap-3 p-5">
        <StepList steps={steps} current={current} />
        <div className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Signing in with {sequence.offramp?.anchorName ?? 'the anchor'}…
        </div>
        {/* The one wallet prompt here that moves nothing. Said, because a
              second prompt right after the swap reads as a second payment. */}
        <p className="text-muted-foreground text-xs">
          Your wallet will ask you to sign a message proving you own this account. It cannot be
          submitted to the network and moves no funds.
        </p>
      </Card>
    )
  }

  if (phase === 'anchor-interactive') {
    return (
      <Card className="flex flex-col gap-3 p-5">
        <StepList steps={steps} current={current} />
        <div className="text-sm font-medium">
          Finish with {sequence.offramp?.anchorName ?? 'the anchor'}
        </div>
        <p className="text-muted-foreground text-sm">
          The anchor has opened its own page to verify you and take your bank details. Nothing is
          sent until you finish there. This card updates on its own.
        </p>
        {sequence.offramp?.anchorStatus !== undefined ? (
          <p className="text-muted-foreground text-xs">
            Anchor status: {sequence.offramp.anchorStatus}
          </p>
        ) : null}
        {sequence.offramp?.popupOpen === false ? (
          <p className="text-muted-foreground text-xs">
            The anchor&apos;s page did not open automatically. Open it here to finish.
          </p>
        ) : null}
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={sequence.reopenAnchor}>
            {sequence.offramp?.popupOpen === true
              ? 'Reopen the anchor page'
              : 'Open the anchor page'}
          </Button>
          <Button variant="ghost" size="sm" onClick={sequence.stop}>
            Stop here
          </Button>
        </div>
      </Card>
    )
  }

  if (phase === 'anchor-ready') {
    return (
      <Card className="text-muted-foreground flex items-center gap-2 p-5 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        The anchor is ready. Reading where to send the payment…
      </Card>
    )
  }

  if (phase === 'settled') {
    return (
      <Card className="flex flex-col gap-3 p-5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <CheckCircle2 className="h-4 w-4" />
          {steps.length === 1 ? 'Withdrawal sent' : 'Both steps settled'}
        </div>
        <StepList steps={steps} current={steps.length} />
        {sequence.kind === 'swap-then-offramp' || sequence.kind === 'offramp-only' ? (
          <p className="text-muted-foreground text-xs">
            The payment is on-chain. The anchor now moves the money to your bank, which can take
            from minutes to days. Track it under Open positions.
          </p>
        ) : null}
        <Button variant="outline" size="sm" onClick={sequence.reset} className="self-start">
          Done
        </Button>
      </Card>
    )
  }

  if (phase === 'building') {
    return (
      <Card className="text-muted-foreground flex items-center gap-2 p-5 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        {current === 0
          ? 'Building the sequence…'
          : sequence.kind === 'swap-then-lend'
            ? 'Sizing the supply to what you received…'
            : 'Building the payment from what the anchor named…'}
      </Card>
    )
  }

  const busy = phase === 'signing' || phase === 'submitting'

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium">
          {steps.length === 1
            ? '1 step, 1 signature'
            : `${steps.length} steps, ${steps.length} signatures`}
        </span>
        {/* Stated rather than implied. A user who has signed multi-step plans
            here would otherwise reasonably expect one signature. */}
        <span className="text-muted-foreground text-xs">
          These cannot share a signature, so your wallet asks once per step. Approving here starts
          the run and the next prompt follows on its own. Declining any prompt stops it, leaving you
          with whatever the earlier steps produced.
        </span>
      </div>

      <StepList steps={steps} current={current} />

      {/* Said before the button, not after it. A size the anchor will refuse
          or cap is something to read while the trade can still be cancelled. */}
      {sequence.warning !== undefined ? (
        <p className="border-border text-muted-foreground rounded-md border border-dashed p-3 text-xs">
          {sequence.warning}
        </p>
      ) : null}

      {/* Only once the supply is the step in hand: the risks below are about
          lending, and showing them beside a swap would misattribute them. */}
      {current > 0 && sequence.kind === 'swap-then-lend' ? (
        <SupplyRisks venue={sequence.lendVenue} />
      ) : null}
      {sequence.offramp !== undefined && sequence.offramp.destination !== '' ? (
        <OfframpReview offramp={sequence.offramp} />
      ) : null}

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={sequence.confirm} disabled={busy}>
          {busy ? (
            <span className="flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {phase === 'signing' ? 'Waiting for your wallet…' : 'Submitting…'}
            </span>
          ) : current === 0 && steps.length > 1 ? (
            `Approve and sign ${steps.length} steps`
          ) : sequence.offramp !== undefined ? (
            'Sign the payment to the anchor'
          ) : (
            `Sign step ${current + 1} of ${steps.length}`
          )}
        </Button>
        {!busy ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={current === 0 ? sequence.reset : sequence.stop}
          >
            {current === 0 ? 'Cancel' : 'Stop here'}
          </Button>
        ) : null}
      </div>
    </Card>
  )
}

function StepList({
  steps,
  current,
}: {
  steps: {
    label: string
    hash?: string
    explorerUrl?: string
    positionUrl?: string
    positionLabel?: string
  }[]
  current: number
}): JSX.Element {
  return (
    <ol className="border-border flex flex-col gap-2 border-l pl-4 text-sm">
      {steps.map((step, i) => {
        const done = i < current || step.hash !== undefined
        return (
          <li key={step.label} className="flex items-start gap-2">
            {done ? (
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            ) : (
              <Circle className="text-muted-foreground mt-0.5 h-3.5 w-3.5 shrink-0" />
            )}
            <span className={done ? 'text-foreground' : 'text-muted-foreground'}>
              {i + 1}. {step.label}
              {step.explorerUrl !== undefined ? (
                <a
                  href={step.explorerUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-muted-foreground hover:text-foreground ml-2 inline-flex items-center gap-1 text-xs underline underline-offset-2"
                >
                  Transaction
                  <ExternalLink className="h-3 w-3" />
                </a>
              ) : null}
              {/* The position, not the receipt. A supply's explorer link
                  proves it happened and shows nothing about what it earns. */}
              {step.positionUrl !== undefined ? (
                <a
                  href={step.positionUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-muted-foreground hover:text-foreground ml-2 inline-flex items-center gap-1 text-xs underline underline-offset-2"
                >
                  {step.positionLabel ?? 'View position on Blend'}
                  <ExternalLink className="h-3 w-3" />
                </a>
              ) : null}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/**
 * What supplying actually risks.
 *
 * **No liquidation warning, deliberately.** A supply-only position cannot be
 * liquidated: the pool never checks health on a supply, and it panics outright
 * when asked to open a liquidation auction against an account with no
 * liabilities. Confirmed in two independent gates in the pool source. Warning
 * about it would train people to ignore a warning that is false here and true
 * elsewhere.
 *
 * The real risks are different, and less familiar, which is exactly why they
 * are worth the space.
 *
 * A DeFindex vault has its own list. Its strategy supplies Blend underneath
 * (the XLM vault's one strategy is "XLM Blend Strategy", read from the vault
 * on 2026-09-23), so Blend's risks apply at one remove; on top of that the
 * vault takes fees from the yield (its `get_fees` reports 100 and 2000 basis
 * points: 1% to the vault, 20% to DeFindex) and the rate shown is a trailing
 * 7-day figure, not a forecast.
 */
function SupplyRisks({ venue }: { venue: string | undefined }): JSX.Element {
  if (venue === 'defindex') {
    return (
      <div className="border-border text-muted-foreground flex flex-col gap-1.5 rounded-md border p-3 text-xs">
        <span className="text-foreground font-medium">Before you deposit</span>
        <span>
          The vault hands your deposit to a strategy that supplies Blend, so Blend’s risks apply
          underneath: withdrawals can stall while its pool is near full use, and suppliers absorb
          defaults beyond the backstop.
        </span>
        <span>
          Fees come out of what the vault earns, not your principal: 1% to the vault and 20% to
          DeFindex, as the vault itself reports. The rate shown is net of them.
        </span>
        <span>
          The rate is a trailing 7-day figure on testnet, not a forecast. You receive vault shares,
          and what they are worth moves with the strategy.
        </span>
      </div>
    )
  }

  return (
    <div className="border-border text-muted-foreground flex flex-col gap-1.5 rounded-md border p-3 text-xs">
      <span className="text-foreground font-medium">Before you supply</span>
      <span>
        Withdrawals fail while the pool is near full use. This reserve is close to that line now, so
        getting funds out may not be immediate.
      </span>
      <span>
        If borrowers default beyond what the backstop covers, suppliers absorb the loss. Your
        principal is not guaranteed.
      </span>
      <span>The rate moves with borrowing demand. It is not fixed at the figure shown.</span>
    </div>
  )
}

/**
 * What the payment will do, as the server read it from the anchor.
 *
 * Every figure here came from the anchor's own answer for this withdrawal,
 * read on the server, and the envelope about to be signed was checked
 * against it. Shown verbatim because this is the one transaction in the app
 * that pays somebody else, and the user should see who.
 */
function OfframpReview({ offramp }: { offramp: NonNullable<Sequence['offramp']> }): JSX.Element {
  return (
    <div className="border-border flex flex-col gap-1.5 rounded-md border p-3 text-xs">
      <span className="text-foreground font-medium">Payment to {offramp.anchorName}</span>
      <span className="text-muted-foreground">
        Amount: <span className="text-foreground font-mono">{offramp.amount} USDC</span>
      </span>
      <span className="text-muted-foreground break-all">
        To: <span className="text-foreground font-mono">{offramp.destination}</span>
      </span>
      <span className="text-muted-foreground break-all">
        Memo ({offramp.memoType}): <span className="text-foreground font-mono">{offramp.memo}</span>
      </span>
      <span className="text-muted-foreground mt-1">
        The memo is what tells the anchor this payment is yours. It was read from the anchor just
        now and checked against the transaction you are about to sign. Once sent, it cannot be
        reversed by this app.
      </span>
    </div>
  )
}
