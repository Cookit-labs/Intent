import type { LedgerPreview as LedgerPreviewData } from '../../lib/swap/preview'

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
    <div className="border-border flex flex-col gap-1.5 border-t pt-3">
      <span className="text-muted-foreground text-xs">
        {preview.basis === 'simulated'
          ? 'What changes in your wallet, from a simulation of this exact transaction'
          : 'What changes in your wallet, as the operations you are signing state it'}
      </span>
      <ul className="flex flex-col gap-1 text-sm">
        {preview.changes.map((c) => (
          <li
            key={`${c.code}-${c.bound}-${c.note ?? ''}`}
            className="flex flex-wrap items-baseline gap-x-2"
          >
            <span className="text-foreground font-mono tabular-nums">
              {c.delta} {c.code}
            </span>
            {c.bound === 'at_least' ? (
              <span className="text-muted-foreground text-xs">
                at least, enforced by the network
              </span>
            ) : null}
            {c.bound === 'at_most' ? (
              <span className="text-muted-foreground text-xs">at most</span>
            ) : null}
            {c.note !== undefined ? (
              <span className="text-muted-foreground text-xs">{c.note}</span>
            ) : null}
          </li>
        ))}
        <li className="text-muted-foreground flex items-baseline gap-x-2 text-xs">
          <span className="font-mono tabular-nums">-{preview.feeXlm} XLM</span>
          <span>network fee</span>
        </li>
        {preview.unresolved > 0 ? (
          <li className="text-muted-foreground text-xs">
            {preview.unresolved === 1
              ? 'One step is a contract call whose amounts could not be read ahead of signing.'
              : `${preview.unresolved} steps are contract calls whose amounts could not be read ahead of signing.`}
          </li>
        ) : null}
      </ul>
    </div>
  )
}
