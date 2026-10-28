/**
 * Whether a swap's USD size warrants a forced pause before signing.
 *
 * Not a second signature gate — the wallet's own prompt is still the real
 * confirmation — but a short, visible countdown on the sign button for a
 * trade above the threshold, so the one mistake a wallet's prompt does
 * nothing to catch (a fat-fingered amount, a plan read too quickly) gets a
 * moment to be noticed. Pulled out of `swap-confirm.tsx` so the USD-size
 * calculation is unit-tested rather than only exercised by eye.
 */

/**
 * The USD figure the pause threshold is checked against: the larger of what
 * is spent and what is received, not their sum or either side alone.
 *
 * For a fair-priced swap the two sides are close anyway, and taking the
 * larger one is what catches the case this pause exists for: a bad quote
 * where one side is priced far off the other, which is exactly when relying
 * on only the "send" side (say) could under-report the trade's real size.
 * `undefined` when neither side has a priced value — nothing to compare, so
 * no pause.
 */
export function confirmPauseUsd(
  sendUsd: number | undefined,
  receiveUsd: number | undefined
): number | undefined {
  if (sendUsd === undefined && receiveUsd === undefined) return undefined
  return Math.max(sendUsd ?? 0, receiveUsd ?? 0)
}

/** Whether `confirmPauseUsd`'s figure clears the configured threshold. */
export function needsConfirmPause(pauseUsd: number | undefined, thresholdUsd: number): boolean {
  return pauseUsd !== undefined && pauseUsd >= thresholdUsd
}
