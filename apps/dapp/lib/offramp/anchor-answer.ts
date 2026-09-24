/**
 * What the browser does with the anchor route's answer.
 *
 * Two failures look alike from outside and mean opposite things. A 502 is
 * an anchor that could not be reached: said out loud, and the sequence still
 * prepared without limits, because the build route refuses an out-of-range
 * withdrawal later and losing the early warning is the honest degradation.
 * A 400 is the server refusing this anchor here at all — on mainnet with no
 * off-ramp configured, that is the whole answer — and a swap prepared on top
 * of it would spend the user's money on a second half the app already knows
 * cannot happen. The decision is the server's, because whether an off-ramp
 * exists depends on configuration the browser cannot see.
 */

export type AnchorAnswer<L> =
  | { kind: 'ok'; limits?: L }
  | { kind: 'refused'; message: string }
  | { kind: 'unreachable'; message: string }

export function classifyAnchorAnswer<L>(
  status: number,
  body: { limits?: L | null; error?: string }
): AnchorAnswer<L> {
  if (status >= 200 && status < 300) {
    return body.limits !== null && body.limits !== undefined
      ? { kind: 'ok', limits: body.limits }
      : { kind: 'ok' }
  }
  if (status === 400) {
    return { kind: 'refused', message: body.error ?? 'this anchor cannot be used here' }
  }
  return {
    kind: 'unreachable',
    message: `The anchor could not be reached: ${body.error ?? `the request failed (${status}).`}`,
  }
}
