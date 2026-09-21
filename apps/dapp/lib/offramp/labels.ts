import type { AnchorId } from './anchors'
import { ANCHORS } from './anchors'
import type { WithdrawLimits } from './sep24'

/** The withdraw step, as it reads in the review list. */
export function withdrawStepLabel(anchor: AnchorId, amount?: string): string {
  const name = ANCHORS[anchor].name
  return amount !== undefined
    ? `Withdraw about ${amount} USDC to your bank through ${name}`
    : `Withdraw the USDC received to your bank through ${name}`
}

/**
 * Whether the anchor will take this size, said before anything is signed.
 *
 * Undefined means no objection. Compared against the anchor's live `/info`,
 * because the SDF test anchor caps at 10 USDC and a swap sized for a
 * realistic order would settle and then have nowhere to go.
 */
export function offrampSizeWarning(
  amountDisplay: string,
  limits: WithdrawLimits | undefined
): string | undefined {
  if (limits === undefined) return undefined
  if (!limits.enabled) return 'This anchor is not accepting withdrawals right now.'
  const n = Number(amountDisplay)
  if (!Number.isFinite(n)) return undefined
  if (limits.minAmount !== undefined && n < limits.minAmount) {
    return `About ${amountDisplay} USDC is below the anchor's minimum of ${limits.minAmount} USDC, so the withdrawal would be refused.`
  }
  if (limits.maxAmount !== undefined && n > limits.maxAmount) {
    return `About ${amountDisplay} USDC is above the anchor's maximum of ${limits.maxAmount} USDC. Only the maximum will be withdrawn; the rest stays in your wallet.`
  }
  return undefined
}
