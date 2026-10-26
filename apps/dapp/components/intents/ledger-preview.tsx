import { cn } from '@intent/ui'

import type { LedgerPreview as LedgerPreviewData } from '../../lib/swap/preview'
import { TokenIcon } from '../ui/token-icon'
import { toolPanel } from './bubble'

/**
 * What changes in the wallet, read from the transaction rather than from
 * the agent that proposed it.
 *
 * The card above this already says what the agent intends. This says what
 * the bytes about to be signed will do, and where the number comes from: a
 * classic transaction's amounts are in its operations and the network
 * enforces them, so those are guarantees; a contract call's amounts come from
 * the network's own simulation of it, so those are what the ledger said a
 * moment ago. Either way, none of it is the agent's claim.
 */
export function LedgerPreview({
  preview,
}: {
  preview: LedgerPreviewData | undefined
}): JSX.Element | null {
  if (preview === undefined) return null
  if (preview.changes.length === 0 && preview.unresolved === 0) return null

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium">Wallet changes</span>
        <span
          className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-[10px] font-medium"
          title={
            preview.basis === 'simulated'
              ? 'From a simulation of this exact transaction'
              : 'As the operations you are signing state it'
          }
        >
          {preview.basis === 'simulated' ? 'simulated' : 'from the transaction'}
        </span>
      </div>
      <ul
        className={cn(
          toolPanel,
          'divide-bubble-agent-border flex flex-col divide-y px-4 dark:divide-white/[0.07]'
        )}
      >
        {preview.changes.map((c) => {
          const incoming = !c.delta.startsWith('-')
          return (
            <li
              key={`${c.code}-${c.bound}-${c.note ?? ''}`}
              className="flex items-center justify-between gap-3 py-2.5"
            >
              <span className="flex min-w-0 items-center gap-2">
                <TokenIcon symbol={c.code} size={20} />
                <span className="text-sm font-medium">{c.code}</span>
                {c.note !== undefined ? (
                  <span className="text-muted-foreground truncate text-xs">{c.note}</span>
                ) : null}
              </span>
              <span className="flex shrink-0 items-center gap-2">
                {c.bound === 'at_least' ? (
                  <span
                    className="bg-success/15 text-success rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                    title="The network refuses the swap if less than this arrives"
                  >
                    at least
                  </span>
                ) : null}
                {c.bound === 'at_most' ? (
                  <span className="bg-muted text-muted-foreground rounded-full px-1.5 py-0.5 text-[10px] font-medium">
                    at most
                  </span>
                ) : null}
                <span
                  className={cn(
                    'font-semibold tabular-nums',
                    incoming ? 'text-success' : 'text-foreground'
                  )}
                >
                  {incoming && !c.delta.startsWith('+') ? '+' : ''}
                  {c.delta}
                </span>
              </span>
            </li>
          )
        })}
        <li className="text-muted-foreground flex items-center justify-between gap-3 py-2 text-xs">
          <span>Network fee</span>
          {preview.feePaidBy === 'sponsor' ? (
            <span title="Nothing leaves your wallet for it">
              <span className="tabular-nums line-through">{preview.feeXlm} XLM</span> paid by Intent
            </span>
          ) : (
            <span className="tabular-nums">-{preview.feeXlm} XLM</span>
          )}
        </li>
      </ul>
      {preview.unresolved > 0 ? (
        <p className="text-muted-foreground text-xs">
          {preview.unresolved === 1
            ? 'One step is a contract call whose amounts could not be read ahead of signing.'
            : `${preview.unresolved} steps are contract calls whose amounts could not be read ahead of signing.`}
        </p>
      ) : null}
    </div>
  )
}
