/**
 * Where a signed step of a sequence is submitted.
 *
 * The first step of every swap-then-something sequence is built by the
 * ordinary swap builder, which makes whatever the chosen route needs: a
 * classic path payment, a Soroswap router call, an Aquarius call. It must be
 * submitted to the endpoint that understands every one of those, and that is
 * the swap endpoint, which reads the shape from the bytes and applies the
 * matching check.
 *
 * It used to go to the plan endpoint, which admits only classic operations and
 * refused a Soroswap router call with "invokeHostFunction is not an operation
 * this app builds" — after the user had been asked to sign.
 */
export interface SequenceStepKind {
  stepIndex: number
  /** The payout's deposit payment, whose route re-checks it against the stored order. */
  isNairaStep: boolean
  isSendStep: boolean
  isOfframpStep: boolean
  isDefindexStep: boolean
  /** The stored payout order's id, for the naira step. */
  orderId?: string | undefined
}

export function sequenceSubmitEndpoint(step: SequenceStepKind): string {
  if (step.isNairaStep) return `/api/naira/orders/${step.orderId ?? ''}/submit`
  if (step.isSendStep) return '/api/send/submit'
  if (step.isOfframpStep) return '/api/offramp/submit'
  if (step.stepIndex === 0) return '/api/swap/submit'
  if (step.isDefindexStep) return '/api/lend/defindex/submit'
  return '/api/lend/submit'
}
