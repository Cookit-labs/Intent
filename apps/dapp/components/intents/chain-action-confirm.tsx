'use client'

import { Button, Card, cn } from '@intent/ui'
import { useQuery } from '@tanstack/react-query'
import { ArrowDown, ArrowLeftRight, Check, ChevronRight, ExternalLink, Loader2 } from 'lucide-react'

import type { ChainAction } from '../../hooks/use-chain-action'
import { stepErrorMessage } from '../../lib/agents/chain-race'
import { limitSettledNote } from '../../lib/chains/orders-view'
import { useChain } from '../../providers/chain-provider'
import type { PreparedAction } from '../../lib/chains/types'
import type { NativeCoinPrice } from '../../lib/prices/native-coin'
import { TokenIcon } from '../ui/token-icon'
import { toolCard, toolPanel } from './bubble'
import {
  AmountRow,
  CardHeader,
  HashChip,
  PRIMARY,
  SECONDARY,
  SourceLogo,
  amount,
} from './swap-confirm'

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

const EXPLORER_NAME: Partial<Record<string, string>> = {
  solana: 'Solscan',
  sui: 'Suiscan',
  near: 'NearBlocks',
  avalanche: 'Snowtrace',
  monad: 'MonadVision',
}

const STABLE = new Set(['USDC', 'USDT', 'USDC.E'])

async function loadNativePrice(chain: string): Promise<NativeCoinPrice | null> {
  const res = await fetch(`/api/prices/native?chain=${encodeURIComponent(chain)}`)
  if (!res.ok) throw new Error('could not read the price')
  const body = (await res.json()) as { price?: NativeCoinPrice | null }
  return body.price ?? null
}

/** A dollar figure only where the price is known: the chain's own coin, or a dollar stablecoin. */
function useUsd(): (amount: string, symbol: string) => string | undefined {
  const { slug, descriptor } = useChain()
  const { data: price } = useQuery({
    queryKey: ['native-coin-price', slug],
    queryFn: () => loadNativePrice(slug),
    refetchInterval: 60_000,
    staleTime: 30_000,
  })
  return (value, symbol) => {
    const upper = symbol.toUpperCase()
    const each = STABLE.has(upper)
      ? 1
      : upper === descriptor.nativeCurrency.symbol.toUpperCase()
        ? price?.usd
        : undefined
    const qty = Number(value)
    if (each === undefined || !Number.isFinite(qty)) return undefined
    return `~$${(qty * each).toLocaleString('en-US', { maximumFractionDigits: 2 })}`
  }
}

/** A swap on any chain but Stellar, drawn with the Stellar swap card's parts. */
function ChainSwapCard({
  action,
  error,
  bare,
}: {
  action: ChainAction
  error: string | undefined
  bare: boolean
}): JSX.Element | null {
  const { phase, prepared, hash, explorerUrl, earlier } = action
  const { slug, descriptor } = useChain()
  const usd = useUsd()
  if (prepared === undefined || prepared.receive === undefined) return null
  const { pay, receive, venueId, venueName, notes } = prepared
  const busy = phase === 'signing' || phase === 'submitting'
  const shell = bare ? 'flex flex-col gap-4' : cn(toolCard, 'gap-4')

  if (phase === 'settled') {
    return (
      <div className={shell}>
        <CardHeader
          tone="verified"
          icon={null}
          title="Swap complete"
          subtitle={`Settled on ${descriptor.name}`}
        />
        <div
          className={cn(toolPanel, 'flex flex-wrap items-center justify-center gap-3 px-4 py-5')}
        >
          <span className="flex items-center gap-2 text-lg font-semibold tabular-nums">
            <TokenIcon symbol={pay.symbol} size={24} />
            {amount(pay.amount)} {pay.symbol}
          </span>
          <ArrowLeftRight className="text-muted-foreground h-4 w-4" aria-hidden="true" />
          <span className="flex items-center gap-2 text-lg font-semibold tabular-nums">
            <TokenIcon symbol={receive.symbol} size={24} />
            {amount(receive.amount)} {receive.symbol}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {explorerUrl !== undefined ? (
            <a
              href={explorerUrl}
              target="_blank"
              rel="noreferrer"
              className="bg-bubble-me text-bubble-me-foreground hover:bg-brand hover:text-brand-foreground inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors"
            >
              View on {EXPLORER_NAME[slug] ?? 'the explorer'}
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </a>
          ) : null}
          {hash !== undefined ? <HashChip hash={hash} /> : null}
        </div>
      </div>
    )
  }

  return (
    <div className={shell}>
      <CardHeader
        icon={<ArrowLeftRight className="h-5 w-5" />}
        title="Review swap"
        subtitle={`via ${venueName}`}
      />

      <div className={cn(toolPanel, 'flex flex-col gap-3 px-4 py-4')}>
        <AmountRow
          label="You pay"
          symbol={pay.symbol}
          value={pay.amount}
          usd={usd(pay.amount, pay.symbol)}
        />
        <div className="relative flex items-center">
          <span className="border-bubble-agent-border w-full border-t dark:border-white/[0.07]" />
          <span className="bg-bubble-me text-bubble-me-foreground absolute left-1/2 flex h-7 w-7 -translate-x-1/2 items-center justify-center rounded-full">
            <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
        </div>
        <AmountRow
          label={receive.approximate ? 'You receive, about' : 'You receive'}
          symbol={receive.symbol}
          value={receive.amount}
          usd={usd(receive.amount, receive.symbol)}
        />
      </div>

      <dl className="divide-bubble-agent-border flex flex-col divide-y text-sm dark:divide-white/[0.07]">
        <div className="flex items-center justify-between gap-4 py-2">
          <dt className="text-muted-foreground">Route</dt>
          <dd className="flex items-center justify-end gap-1.5 text-right font-medium">
            <SourceLogo source={venueId} />
            <span>{venueName}</span>
          </dd>
        </div>
      </dl>

      {earlier !== undefined ? (
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

      {error !== undefined ? (
        <p role="alert" className="text-sm leading-relaxed">
          {error}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={action.confirm}
          disabled={busy}
          className={cn(PRIMARY, 'flex-1')}
        >
          {busy ? (
            <Loader2
              className="h-4 w-4 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : null}
          {phase === 'signing'
            ? 'Confirm in your wallet'
            : phase === 'submitting'
              ? 'Sending…'
              : 'Sign & swap'}
        </button>
        {!busy ? (
          <button type="button" onClick={action.reset} className={SECONDARY}>
            Cancel
          </button>
        ) : null}
      </div>

      <Notes notes={notes} settled={false} what="this swap" />
    </div>
  )
}

/**
 * Before signing, the first note stays in view: it is the one that says what the person is
 * guaranteed. The rest fold away, and after the step is sent all of them do.
 */
function Notes({
  notes,
  settled,
  what,
}: {
  notes: readonly string[]
  settled: boolean
  what: string
}): JSX.Element | null {
  if (notes.length === 0) return null
  const shown = settled ? [] : notes.slice(0, 1)
  const folded = settled ? notes : notes.slice(1)
  return (
    <div className="text-muted-foreground flex flex-col gap-2 text-xs leading-relaxed">
      {shown.map((note) => (
        <p key={note}>{note}</p>
      ))}
      {folded.length > 0 ? (
        <details className="group">
          <summary className="hover:text-foreground focus-visible:ring-ring inline-flex cursor-pointer list-none items-center gap-1 rounded-sm focus-visible:outline-none focus-visible:ring-2 [&::-webkit-details-marker]:hidden">
            <ChevronRight
              className="h-3.5 w-3.5 transition-transform group-open:rotate-90 motion-reduce:transition-none"
              aria-hidden="true"
            />
            More about {what}
          </summary>
          <ul className="mt-2 flex flex-col gap-2 pl-[1.125rem]">
            {folded.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  )
}

/** Review, sign and result for an action on a chain other than Stellar. */
export function ChainActionConfirm({
  action,
  sequenceSettled = false,
  typedStep,
  bare = false,
}: {
  action: ChainAction
  /** This card is step 2, after a swap that was signed and settled. */
  sequenceSettled?: boolean
  /** That step as a request of its own, for when it can't go on from here. */
  typedStep?: string | undefined
  /** Inside a panel that is already its own surface, so it draws no box of its own. */
  bare?: boolean
}): JSX.Element {
  const { phase, prepared, hash, explorerUrl, earlier } = action
  const { slug } = useChain()
  const error = stepErrorMessage(action.error, sequenceSettled, typedStep)
  const busy = phase === 'signing' || phase === 'submitting'
  const Surface = bare ? 'div' : Card

  if (
    prepared?.kind === 'swap' &&
    prepared.receive !== undefined &&
    (phase === 'review' || busy || (phase === 'settled' && !action.canContinue))
  ) {
    return (
      <ChainSwapCard action={action} error={phase === 'review' ? error : undefined} bare={bare} />
    )
  }

  return (
    <Surface className={bare ? 'flex flex-col gap-3' : 'flex flex-col gap-3 p-5'}>
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
          {
            <div className="flex flex-col gap-1">
              <span className="text-[15px] font-semibold leading-snug [overflow-wrap:anywhere]">
                {prepared.summary}
              </span>
              {/* A swap's summary already says both amounts; saying them twice was noise. */}
              {prepared.kind !== 'swap' ? (
                <span className="text-muted-foreground text-xs">
                  {cardLine(prepared)}
                  {prepared.receive !== undefined
                    ? `, and receive ${prepared.receive.approximate ? 'about ' : ''}${prepared.receive.amount} ${prepared.receive.symbol}`
                    : ''}
                </span>
              ) : null}
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
          }

          <Notes
            notes={prepared.notes}
            settled={phase === 'settled'}
            what={prepared.kind === 'swap' ? 'this swap' : 'this step'}
          />

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

          {phase === 'settled' && action.canContinue ? (
            <div className="flex flex-col gap-2">
              <p className="flex items-center gap-2 text-sm font-medium" role="status">
                Done. One more signature finishes this.
              </p>
              <div>
                <Button size="sm" onClick={action.continueSetup}>
                  Continue
                </Button>
              </div>
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
            <p className="flex items-center gap-2 text-sm font-medium" role="status">
              <Check className="text-brand h-4 w-4" aria-hidden="true" />
              Sent
              {explorerUrl !== undefined ? (
                <a
                  href={explorerUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-muted-foreground hover:text-foreground ml-auto inline-flex items-center gap-1 text-xs font-normal tabular-nums hover:underline hover:underline-offset-2"
                >
                  {hash !== undefined ? `${hash.slice(0, 6)}…${hash.slice(-4)}` : 'View'}
                  <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </a>
              ) : null}
            </p>
          ) : (
            <div className={bare ? 'flex flex-col gap-1' : 'flex items-center gap-2'}>
              <Button
                size={bare ? 'lg' : 'sm'}
                className={bare ? 'h-12 w-full rounded-full text-[15px]' : undefined}
                onClick={action.confirm}
                disabled={busy}
              >
                {busy ? (
                  <span className="flex items-center gap-2">
                    <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden="true" />
                    {phase === 'signing' ? 'Waiting for your wallet' : 'Sending'}
                  </span>
                ) : (
                  'Sign and send'
                )}
              </Button>
              {!busy && !bare ? (
                <Button variant="ghost" size="sm" onClick={action.reset}>
                  Cancel
                </Button>
              ) : null}
            </div>
          )}
        </>
      ) : null}
    </Surface>
  )
}
