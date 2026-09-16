/**
 * What the pool's refusals mean, in words a person can act on.
 *
 * Blend reports failures as `Error(Contract, #1205)` and nothing else. That is
 * precise and useless: it names no cause, suggests no remedy, and appears at
 * exactly the moment somebody is worried about their money. One of these codes
 * went unexplained in this codebase for a day because the meaning is not
 * anywhere in the transaction — it lives in `pool/src/errors.rs`.
 *
 * The numbers below are transcribed from that file rather than inferred from
 * observed behaviour. Two were then confirmed against the live pool: #1217 by
 * reclaiming collateral that was never posted, #1207 by borrowing wBTC while
 * its reserve sat at 94.3% utilisation.
 *
 * **An unknown code keeps its raw text rather than getting a friendly guess.**
 * A wrong explanation is worse than an opaque one — it sends someone looking
 * for a problem they do not have, and hides the one they do.
 */

interface PoolError {
  /** What went wrong, in the second person. */
  message: string
  /** Whether waiting and retrying could plausibly succeed. */
  transient: boolean
}

const POOL_ERRORS: Record<number, PoolError> = {
  1204: {
    message: 'This pool is not accepting that operation right now.',
    transient: true,
  },
  1205: {
    message: 'Not enough collateral for that borrow. Post more collateral, or borrow less.',
    transient: false,
  },
  1206: { message: 'This pool is not currently active.', transient: true },
  1207: {
    // The one most likely to be met first, and the least self-explanatory.
    // wBTC sits within a percent of its ceiling, so a perfectly sound borrow
    // gets refused for reasons that have nothing to do with the borrower.
    message:
      'The pool has lent out too much of this asset right now, so it cannot be borrowed or withdrawn. This usually clears as borrowers repay — try again later, or use a smaller amount.',
    transient: true,
  },
  1208: {
    message: 'This pool allows at most 8 positions per account, and yours is full.',
    transient: false,
  },
  1210: {
    message: 'The price feed for this asset is unavailable, so the pool cannot value it.',
    transient: true,
  },
  1215: {
    message: 'That amount is too small for the pool to account for. Try a larger one.',
    transient: false,
  },
  1217: {
    message: 'You have nothing supplied in this asset to withdraw.',
    transient: false,
  },
  1219: {
    message: 'You have nothing borrowed in this asset to repay.',
    transient: false,
  },
  1220: {
    message: 'This reserve has reached its supply cap, so it cannot accept more right now.',
    transient: true,
  },
  1223: { message: 'This asset is disabled in the pool at the moment.', transient: true },
  1224: {
    message: 'That is below the minimum collateral this pool requires.',
    transient: false,
  },
}

/** The contract error code in a host error, if there is one. */
export function poolErrorCode(reason: string): number | undefined {
  const match = /Error\(Contract,\s*#(\d+)\)/.exec(reason)
  if (match?.[1] === undefined) return undefined

  const code = Number(match[1])
  return Number.isFinite(code) ? code : undefined
}

/**
 * A refusal, rephrased.
 *
 * Returns the original text unchanged when the code is unrecognised or absent,
 * so a failure this table has never seen still reaches the user rather than
 * being flattened into "something went wrong".
 */
export function explainPoolError(reason: string): string {
  const code = poolErrorCode(reason)
  if (code === undefined) return reason

  const known = POOL_ERRORS[code]
  if (known === undefined) return reason

  return known.message
}

/** Whether retrying later could plausibly work. Unknown codes are not assumed to be. */
export function isTransientPoolError(reason: string): boolean {
  const code = poolErrorCode(reason)
  if (code === undefined) return false

  return POOL_ERRORS[code]?.transient ?? false
}
