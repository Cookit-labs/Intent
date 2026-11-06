'use client'

import { Button, cn } from '@intent/ui'
import { ArrowRight, ChevronDown, ExternalLink, Loader2 } from 'lucide-react'
import { useState } from 'react'

import type { ChainAction } from '../../hooks/use-chain-action'
import { stepErrorMessage } from '../../lib/agents/chain-race'
import { limitSettledNote } from '../../lib/chains/orders-view'
import { useChain } from '../../providers/chain-provider'
import type { PreparedAction } from '../../lib/chains/types'
import { TokenIcon } from '../ui/token-icon'
import { toolCard, toolPanel } from './bubble'

function cardLine({ kind, pay, venueName }: PreparedAction): string {
  const what = `${pay.amount} ${pay.symbol}`
  switch (kind) {
    case 'send':
      return `This moves ${what} from your wallet`
    case 'withdraw':
    case 'unstake':
      return `You take ${what} out of ${venueName}`
    case 'borrow':
      return `You borrow ${what} from ${venueName}, and owe it back with interest`
    case 'repay':
      return `You repay ${what} to ${venueName}`
    case 'stream':
      return `This commits ${what} from your wallet to a stream on ${venueName}`
    case 'invoice':
      return `This bills ${what} on ${venueName}, and moves nothing from your wallet`
    case 'claim':
      return `You collect ${what} from ${venueName}`
    case 'cancel':
      return `You end this stream on ${venueName}, and get back ${what} that hasn't streamed`
    default:
      return `You pay ${what} on ${venueName}`
  }
}

const VERB: Partial<Record<PreparedAction['kind'], string>> = {
  swap: 'Swap',
  supply: 'Deposit',
  stake: 'Stake',
  limit: 'Limit order',
  withdraw: 'Withdraw',
  unstake: 'Unstake',
  borrow: 'Borrow',
  repay: 'Repay',
  stream: 'Stream',
  invoice: 'Invoice',
  pay_invoice: 'Pay invoice',
  claim: 'Claim',
  cancel: 'End stream',
}

function cardTitle({ kind, venueName }: PreparedAction): string {
  if (kind === 'send') return 'Send'
  return `${VERB[kind] ?? 'Pay'} on ${venueName}`
}

/** Kinds whose sentence says what the amounts alone don't: a debt, a commitment, nothing moved. */
const SAYS_MORE: ReadonlySet<PreparedAction['kind']> = new Set([
  'borrow',
  'stream',
  'invoice',
  'cancel',
])

/** What one unit of the paid asset fetches, for a swap between two different assets. */
function rateLine({ pay, receive }: PreparedAction): string | undefined {
  if (receive === undefined || receive.symbol === pay.symbol) return undefined
  const paid = Number(pay.amount)
  const got = Number(receive.amount)
  if (!(paid > 0) || !(got > 0)) return undefined
  const each = got / paid
  const shown = Number(each >= 1 ? each.toFixed(4) : each.toPrecision(4))
  return `${receive.approximate ? '≈ ' : ''}${shown} ${receive.symbol} per ${pay.symbol}`
}

const short = (hash: string): string => `${hash.slice(0, 6)}…${hash.slice(-4)}`

/** The venue's own logo, or its initial when there is none. */
function VenueMark({ id, name }: { id: string; name: string }): JSX.Element {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return (
      <span className="bg-bubble-me text-bubble-me-foreground flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold">
        {name.charAt(0)}
      </span>
    )
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/images/venues/${id}.webp`}
      alt=""
      width={40}
      height={40}
      onError={() => setFailed(true)}
      className="ring-border/60 h-10 w-10 shrink-0 rounded-full object-cover ring-1"
    />
  )
}

function Amount({
  amount,
  symbol,
  approximate = false,
}: {
  amount: string
  symbol: string
  approximate?: boolean
}): JSX.Element {
  return (
    <span className="flex min-w-0 items-center gap-2 text-lg font-semibold [overflow-wrap:anywhere]">
      <TokenIcon symbol={symbol} size={24} />
      <span>
        {approximate ? <span className="text-muted-foreground font-normal">≈ </span> : null}
        {amount} {symbol}
      </span>
    </span>
  )
}

function statusLine(phase: ChainAction['phase'], canContinue: boolean): string {
  if (phase === 'settled') return canContinue ? 'Done. One more signature finishes this.' : 'Sent'
  if (phase === 'signing') return 'Waiting for your wallet'
  if (phase === 'submitting') return 'Sending'
  return 'Review, then sign in your wallet'
}

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
  const { slug } = useChain()
  const error = stepErrorMessage(action.error, sequenceSettled, typedStep)
  const busy = phase === 'signing' || phase === 'submitting'
  const rate = prepared !== undefined ? rateLine(prepared) : undefined

  return (
    <div className={cn(toolCard, 'gap-4')}>
      {phase === 'building' ? (
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden="true" />
          {action.building === 'swap' || action.building === 'supply' || action.building === 'stake'
            ? 'Getting a live price'
            : 'Building this transaction'}
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
          <div className="flex items-center gap-3">
            <VenueMark id={prepared.venueId} name={prepared.venueName} />
            <div className="flex min-w-0 flex-col leading-tight">
              <span className="text-sm font-semibold">{cardTitle(prepared)}</span>
              <span className="text-muted-foreground text-xs" role="status">
                {statusLine(phase, action.canContinue)}
              </span>
            </div>
          </div>

          <div
            className={cn(
              toolPanel,
              'flex flex-col items-center justify-center gap-2 px-4 py-5 tabular-nums sm:flex-row sm:gap-3'
            )}
          >
            <Amount amount={prepared.pay.amount} symbol={prepared.pay.symbol} />
            {prepared.receive !== undefined ? (
              <>
                <ArrowRight
                  className="text-muted-foreground h-4 w-4 shrink-0 rotate-90 sm:rotate-0"
                  aria-label="for"
                />
                <Amount
                  amount={prepared.receive.amount}
                  symbol={prepared.receive.symbol}
                  approximate={prepared.receive.approximate}
                />
              </>
            ) : null}
          </div>

          {prepared.receive === undefined || SAYS_MORE.has(prepared.kind) ? (
            <p className="text-muted-foreground text-xs leading-relaxed [overflow-wrap:anywhere]">
              {prepared.receive === undefined ? prepared.summary : `${cardLine(prepared)}.`}
            </p>
          ) : null}

          {rate !== undefined || prepared.apy !== undefined ? (
            <dl className="divide-bubble-agent-border flex flex-col divide-y text-sm tabular-nums dark:divide-white/[0.07]">
              {rate !== undefined ? (
                <div className="flex items-center justify-between gap-4 py-2">
                  <dt className="text-muted-foreground">Rate</dt>
                  <dd className="text-right font-medium">{rate}</dd>
                </div>
              ) : null}
              {prepared.apy !== undefined ? (
                <div className="flex items-center justify-between gap-4 py-2">
                  <dt className="text-muted-foreground">Current rate</dt>
                  <dd className="text-right font-medium">
                    {prepared.apy.basePercent.toFixed(2)}%
                    {prepared.apy.rewardPercent !== undefined
                      ? ` + ${prepared.apy.rewardPercent.toFixed(2)}% rewards that can end`
                      : ''}
                  </dd>
                </div>
              ) : null}
            </dl>
          ) : null}

          {prepared.notes.length > 0 ? (
            <details
              key={phase === 'settled' ? 'after' : 'before'}
              open={phase !== 'settled'}
              className="border-bubble-agent-border group rounded-2xl border px-4 py-3 text-xs dark:border-white/[0.07]"
            >
              <summary className="text-muted-foreground hover:text-foreground flex cursor-pointer list-none items-center justify-between gap-2 font-medium [&::-webkit-details-marker]:hidden">
                {phase === 'settled' ? 'What you agreed to' : 'Before you sign'}
                <ChevronDown
                  className="h-3.5 w-3.5 transition-transform group-open:rotate-180"
                  aria-hidden="true"
                />
              </summary>
              <ul className="text-muted-foreground mt-2.5 flex flex-col gap-2 leading-relaxed">
                {prepared.notes.map((note) => (
                  <li key={note} className="flex gap-2">
                    <span
                      aria-hidden="true"
                      className="bg-brand/50 mt-[0.45rem] h-1 w-1 shrink-0 rounded-full"
                    />
                    {note}
                  </li>
                ))}
              </ul>
            </details>
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
                  {short(earlier.hash)}
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

          {phase === 'settled' && action.canContinue ? (
            <div>
              <Button size="sm" onClick={action.continueSetup}>
                Continue
              </Button>
            </div>
          ) : null}

          {phase === 'settled' &&
          !action.canContinue &&
          prepared.kind === 'limit' &&
          action.source?.kind === 'request' ? (
            <p className="text-muted-foreground text-xs leading-relaxed">
              {limitSettledNote(slug)}
            </p>
          ) : null}

          {phase === 'settled' && action.canContinue ? null : phase === 'settled' ? (
            explorerUrl !== undefined ? (
              <a
                href={explorerUrl}
                target="_blank"
                rel="noreferrer"
                className="bg-bubble-me text-bubble-me-foreground hover:bg-brand hover:text-brand-foreground inline-flex w-fit items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors"
              >
                View transaction{hash !== undefined ? ` ${short(hash)}` : ''}
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
            ) : null
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
    </div>
  )
}
