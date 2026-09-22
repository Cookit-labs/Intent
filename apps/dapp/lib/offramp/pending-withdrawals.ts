import type { BundleStep, ChatTurn } from '../chat-history'
import type { Sep24Status } from './sep24'
import { isDeclined, isSettledByAnchor } from './sep24'

export interface PendingWithdrawal {
  turnId: string
  label: string
  anchor: NonNullable<BundleStep['anchor']>
  hash?: string
}

/** Offramp steps whose anchor has not finished — or has never been asked. */
export function pendingWithdrawals(turns: ChatTurn[]): PendingWithdrawal[] {
  const out: PendingWithdrawal[] = []
  for (const turn of turns) {
    for (const step of turn.bundle ?? []) {
      if (step.anchor === undefined) continue
      const status = step.anchor.lastStatus as Sep24Status | undefined
      if (status !== undefined && (isSettledByAnchor(status) || isDeclined(status))) continue
      out.push({
        turnId: turn.id,
        label: step.label,
        anchor: step.anchor,
        ...(step.hash !== undefined ? { hash: step.hash } : {}),
      })
    }
  }
  return out
}
