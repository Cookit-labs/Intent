'use client'

import { Button, Card } from '@intent/ui'
import { ExternalLink, Loader2 } from 'lucide-react'

import type { ChainAction } from '../../hooks/use-chain-action'
import { stepErrorMessage } from '../../lib/agents/chain-race'

/** Review, sign and result for an action on a chain other than Stellar. */
export function ChainActionConfirm({
  action,
  sequenceSettled = false,
  typedStep,
}: {
  action: ChainAction
  /** This card is step 2, after a swap that was signed and settled. */
  sequenceSettled?: boolean
  /** That step as a request of its own, for when it can't go on from here. */
  typedStep?: string | undefined
}): JSX.Element {
  const { phase, prepared, hash, explorerUrl, earlier } = action
  const error = stepErrorMessage(action.error, sequenceSettled, typedStep)
  const busy = phase === 'signing' || phase === 'submitting'

  return (
    <Card className="flex flex-col gap-3 p-5">
      {phase === 'building' ? (
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden="true" />
          {action.building === 'send' ? 'Building this transfer' : 'Getting a live price'}
        </p>
      ) : null}

      {phase === 'failed' ? (
        <>
          <p role="alert" className="text-sm leading-relaxed">
            {error}
          </p>
          <div>
            <Button variant="ghost" size="sm" onClick={action.reset}>
              Dismiss
            </Button>
          </div>
        </>
      ) : null}

      {phase === 'pending' ? (
        <>
          <p role="status" className="text-sm leading-relaxed">
            {error}
          </p>
          <div>
            <Button variant="ghost" size="sm" onClick={action.reset}>
              Done
            </Button>
          </div>
        </>
      ) : null}

      {prepared !== undefined && phase !== 'failed' && phase !== 'pending' ? (
        <>
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium [overflow-wrap:anywhere]">{prepared.summary}</span>
            <span className="text-muted-foreground text-xs">
              {prepared.kind === 'send'
                ? `This moves ${prepared.pay.amount} ${prepared.pay.symbol} from your wallet`
                : `You pay ${prepared.pay.amount} ${prepared.pay.symbol} on ${prepared.venueName}`}
              {prepared.receive !== undefined
                ? `, and receive ${prepared.receive.approximate ? 'about ' : ''}${prepared.receive.amount} ${prepared.receive.symbol}`
                : ''}
            </span>
            {prepared.apy !== undefined ? (
              <span className="text-muted-foreground text-xs">
                Current rate {prepared.apy.basePercent.toFixed(2)}%
                {prepared.apy.rewardPercent !== undefined
                  ? `, plus ${prepared.apy.rewardPercent.toFixed(2)}% in rewards that can end`
                  : ''}
                . Rates change.
              </span>
            ) : null}
          </div>

          {prepared.notes.length > 0 ? (
            <ul className="text-muted-foreground list-disc space-y-1 pl-4 text-xs leading-relaxed">
              {prepared.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          ) : null}

          {phase === 'review' && earlier !== undefined ? (
            <p role="alert" className="flex flex-wrap items-center gap-2 text-sm leading-relaxed">
              {earlier.text}
              {earlier.explorerUrl !== undefined && earlier.hash !== undefined ? (
                <a
                  href={earlier.explorerUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs underline underline-offset-2"
                >
                  {`${earlier.hash.slice(0, 6)}…${earlier.hash.slice(-4)}`}
                  <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </a>
              ) : null}
            </p>
          ) : null}

          {phase === 'review' && error !== undefined ? (
            <p role="alert" className="text-sm leading-relaxed">
              {error}
            </p>
          ) : null}

          {phase === 'settled' ? (
            <p className="flex items-center gap-2 text-sm font-medium" role="status">
              Sent
              {explorerUrl !== undefined ? (
                <a
                  href={explorerUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs font-normal underline underline-offset-2"
                >
                  {hash !== undefined ? `${hash.slice(0, 6)}…${hash.slice(-4)}` : 'View'}
                  <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </a>
              ) : null}
            </p>
          ) : (
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={action.confirm} disabled={busy}>
                {busy ? (
                  <span className="flex items-center gap-2">
                    <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden="true" />
                    {phase === 'signing' ? 'Waiting for your wallet' : 'Sending'}
                  </span>
                ) : (
                  'Sign and send'
                )}
              </Button>
              {!busy ? (
                <Button variant="ghost" size="sm" onClick={action.reset}>
                  Cancel
                </Button>
              ) : null}
            </div>
          )}
        </>
      ) : null}
    </Card>
  )
}
