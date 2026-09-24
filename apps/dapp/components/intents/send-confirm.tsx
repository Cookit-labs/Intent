'use client'

import { Check, Copy, TriangleAlert } from 'lucide-react'
import { useState } from 'react'

import type { SendReview } from '../../hooks/use-sequence'
import { pinStatusLine, plainAmount, resolvedOnLabel } from '../../lib/send/labels'
import { LedgerPreview } from './ledger-preview'

/**
 * What the payment will do, as the server resolved it.
 *
 * Every figure here came from the server's own resolution of the recipient,
 * and the envelope about to be signed was checked against it. The address is
 * shown in full, because a name is a pointer somebody else controls and the
 * address is the only thing that says where the money goes.
 *
 * The address book's line is the one that earns this card its space. A name
 * paid before that now points somewhere new is exactly how a redirected name
 * takes money quietly; here it is a warning and a checkbox, and the signature
 * waits for the tick.
 */
export function SendConfirm({
  send,
  acknowledged,
  onAcknowledge,
}: {
  send: SendReview
  acknowledged: boolean
  onAcknowledge: (checked: boolean) => void
}): JSX.Element {
  const [copied, setCopied] = useState(false)
  const origin = resolvedOnLabel({
    kind: send.kind,
    input: send.recipient,
    ...(send.resolvedOn !== undefined ? { resolvedOn: send.resolvedOn } : {}),
  })
  const isName = send.kind !== 'address'
  const moved = send.pin.status === 'changed'

  function copy(): void {
    if (typeof navigator === 'undefined') return
    void navigator.clipboard
      .writeText(send.address)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => undefined)
  }

  return (
    <div className="border-border flex flex-col gap-1.5 rounded-md border p-3 text-xs">
      <span className="text-foreground font-medium">Payment to {send.recipient}</span>
      <span className="text-muted-foreground">
        Amount:{' '}
        <span className="text-foreground font-mono">
          {plainAmount(send.amount)} {send.asset}
        </span>
      </span>
      <span className="text-muted-foreground break-all">
        To: <span className="text-foreground font-mono">{send.address}</span>
        <button
          type="button"
          onClick={copy}
          aria-label="Copy the address"
          className="text-muted-foreground hover:text-foreground ml-1.5 inline-flex align-middle"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        </button>
      </span>
      {send.memo !== undefined ? (
        <span className="text-muted-foreground break-all">
          Memo ({send.memoType ?? 'text'}):{' '}
          <span className="text-foreground font-mono">{send.memo}</span>
        </span>
      ) : null}
      {origin !== undefined ? <span className="text-muted-foreground">{origin}</span> : null}

      {isName && moved ? (
        <div className="border-border mt-1 flex flex-col gap-2 rounded-md border border-dashed p-2">
          <span className="text-foreground flex items-start gap-1.5">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="break-all">{pinStatusLine(send.pin)}</span>
          </span>
          <label className="text-foreground flex items-center gap-2">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => onAcknowledge(e.target.checked)}
            />
            I checked the new address
          </label>
        </div>
      ) : null}
      {isName && !moved ? (
        <span className="text-muted-foreground">{pinStatusLine(send.pin)}</span>
      ) : null}

      <LedgerPreview preview={send.preview} />

      <span className="text-muted-foreground mt-1">
        The address was resolved on the server just now and checked against the transaction you are
        about to sign. It is resolved again when the payment is submitted, and a name that has moved
        in between is refused. Once sent, it cannot be reversed by this app.
      </span>
    </div>
  )
}
