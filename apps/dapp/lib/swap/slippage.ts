/**
 * The most slippage tolerance the server will build a swap with, in basis
 * points. The UI offers a few tenths of a percent; a request above this is not
 * a setting, it is a swap with no floor.
 */
export const MAX_SLIPPAGE_BPS = 500

export type SlippageCheck = { ok: true; bps: number | undefined } | { ok: false; error: string }

/** `undefined` (or `null`) means the caller named none, and the default applies. */
export function checkSlippageBps(raw: unknown): SlippageCheck {
  if (raw === undefined || raw === null) return { ok: true, bps: undefined }
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    return { ok: false, error: 'slippageBps must be a whole number of basis points' }
  }
  if (raw > MAX_SLIPPAGE_BPS) {
    return {
      ok: false,
      error: `slippageBps ${raw} is above the ${MAX_SLIPPAGE_BPS} this app allows`,
    }
  }
  return { ok: true, bps: raw }
}
