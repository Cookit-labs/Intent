import { historyOwner } from './history-owner'

/**
 * A swap that settled meaning to be followed by a naira cash-out, where the
 * cash-out order was never actually created — because the tab closed, the
 * browser crashed, or the user navigated away before reaching the bank-detail
 * form.
 *
 * Local-only, not a `ChatTurn` field: `conversation-client.ts`'s
 * `saveTurnRemote`/`updateTurnRemote` only forward a fixed, named set of
 * fields to the server, so a new field added to `ChatTurn` would be silently
 * dropped on sync rather than persisted — exactly the kind of lost state this
 * exists to prevent. This is deliberately scoped smaller: it survives this
 * browser closing and reopening, which is the actual gap (the swap itself is
 * already in history once it settles; what was missing was the reminder that
 * a second step was still owed).
 */

const STORAGE_BASE = 'intent.pending-cashout.v1'

function storageKey(): string {
  const owner = historyOwner()
  return owner === undefined ? STORAGE_BASE : `${STORAGE_BASE}:${owner}`
}

export interface PendingCashOut {
  /** The swap's transaction hash, so the reminder can link back to it. */
  swapHash: string
  /** What the swap delivered, for "cash out the ~82 USDC still waiting". */
  receiveDisplay: string
  setAt: string
}

/** Marks a swap as settled with its cash-out not yet started. Overwrites any previous one. */
export function setPendingCashOut(swapHash: string, receiveDisplay: string): void {
  try {
    const value: PendingCashOut = { swapHash, receiveDisplay, setAt: new Date().toISOString() }
    window.localStorage.setItem(storageKey(), JSON.stringify(value))
  } catch {
    // Storage can be full or blocked; the reminder is a convenience, not a
    // guarantee, so a write failure here must not break the swap flow itself.
  }
}

/** The pending cash-out for this wallet, if one was left behind. */
export function pendingCashOut(): PendingCashOut | undefined {
  try {
    const raw = window.localStorage.getItem(storageKey())
    if (raw === null) return undefined
    const parsed = JSON.parse(raw) as Partial<PendingCashOut>
    return typeof parsed.swapHash === 'string' && typeof parsed.receiveDisplay === 'string'
      ? {
          swapHash: parsed.swapHash,
          receiveDisplay: parsed.receiveDisplay,
          setAt: parsed.setAt ?? '',
        }
      : undefined
  } catch {
    return undefined
  }
}

/** Clears the reminder: the cash-out was started (an order exists) or the user moved on. */
export function clearPendingCashOut(): void {
  try {
    window.localStorage.removeItem(storageKey())
  } catch {
    // Same reasoning as the write above.
  }
}
