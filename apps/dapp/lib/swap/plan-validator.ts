import { stellarTestnet } from '@intent/config'
import { FeeBumpTransaction, TransactionBuilder, type Operation } from '@stellar/stellar-sdk'

/**
 * Validating a transaction that does several things at once.
 *
 * Until now every builder asserted **exactly one operation**, and that single
 * line was what stood between a user and an agent-composed transaction that
 * quietly paid somebody else. Multi-step plans require relaxing it — which
 * means the guarantee has to be rebuilt operation by operation, not dropped.
 *
 * The threat is worth naming precisely. An agent proposes "swap half, supply
 * the rest, rest a limit order for the remainder". That is three operations
 * the user wants. If a fourth can be slipped in, they approve it with the same
 * signature, and the dangerous one is invisible beside the ones they asked
 * for. Nobody reads XDR before clicking confirm.
 *
 * So this works as an allowlist rather than a denylist. Operations the app
 * legitimately builds are enumerated; everything else fails, including
 * operation types that do not exist yet. A denylist would silently admit
 * whatever the next protocol version adds.
 */

/**
 * How many steps a plan may contain.
 *
 * Stellar permits 100. That is not the constraint that matters: a plan nobody
 * can read before signing has not been reviewed, whatever the network allows.
 * Ten is roughly what fits on a confirmation screen without scrolling.
 */
export const MAX_PLAN_STEPS = 10

/**
 * Operation types the app builds, and which are safe inside a plan.
 *
 * Each entry is here because a builder produces it and its effects are
 * confined to the signing account. Conspicuously absent:
 *
 * - `payment` — the whole point. A plan must not move funds to a third party.
 * - `accountMerge` — hands the entire balance away, permanently.
 * - `setOptions` — can add a signer or change thresholds, outliving every
 *   trade in the plan.
 * - `createAccount`, `clawback`, `beginSponsoringFutureReserves` — none are
 *   produced by any builder, and all have consequences beyond a trade.
 */
const ALLOWED_OPERATIONS = new Set([
  'pathPaymentStrictSend',
  'pathPaymentStrictReceive',
  'manageSellOffer',
  'manageBuyOffer',
  'createPassiveSellOffer',
  'liquidityPoolDeposit',
  'liquidityPoolWithdraw',
  'invokeHostFunction',
  // Buying an asset the account cannot yet hold requires this first, and
  // splitting it into a separate signature is exactly what multi-step exists
  // to avoid. It grants nothing to anyone else.
  'changeTrust',
])

/** Operations that deliver value, and must therefore deliver it to the signer. */
const DELIVERS_TO_DESTINATION = new Set(['pathPaymentStrictSend', 'pathPaymentStrictReceive'])

export interface PlanStep {
  index: number
  type: string
}

/**
 * Refuses any transaction the app should not sign on the user's behalf.
 *
 * Replaces the four separate single-operation assertions with one check that
 * permits a plan while examining every step of it. The single-operation case
 * is not special-cased — it is simply a plan of length one, which means the
 * existing builders keep their guarantee without keeping their own copy of it.
 */
export function assertSelfPlan(xdr: string, account: string): PlanStep[] {
  const decoded = TransactionBuilder.fromXDR(xdr, stellarTestnet.networkPassphrase)

  // A fee bump wraps another transaction, so the operations visible here are
  // not the ones that would execute. Refusing outright beats inspecting the
  // wrong envelope and reporting it safe.
  if (decoded instanceof FeeBumpTransaction) {
    throw new Error('fee-bump transactions are not supported here')
  }
  const tx = decoded

  if (tx.source !== account) {
    throw new Error(`refusing to sign: transaction source ${tx.source} is not the account`)
  }

  if (tx.operations.length === 0) {
    throw new Error('refusing to sign: the transaction has no operations')
  }

  if (tx.operations.length > MAX_PLAN_STEPS) {
    throw new Error(
      `refusing to sign: too many steps (${tx.operations.length}). ` +
        `A plan longer than ${MAX_PLAN_STEPS} cannot be reviewed before signing.`
    )
  }

  const steps: PlanStep[] = []

  tx.operations.forEach((op: Operation, index) => {
    // The union of operation shapes does not expose `type` on the base, though
    // every member carries it.
    const type = (op as unknown as { type: string }).type

    if (!ALLOWED_OPERATIONS.has(type)) {
      // Named in the message because "invalid operation" tells a developer
      // nothing, and this failure should be diagnosable from a screenshot.
      throw new Error(
        `refusing to sign step ${index + 1}: ${type} is not an operation this app builds. ` +
          'Only swaps, offers, pool deposits, trustlines and router calls may appear in a plan.'
      )
    }

    // Stellar lets each operation carry its own source account. An operation
    // attributed to somebody else inside the user's transaction is never
    // something the app builds, and would execute with that account's
    // authority if they also signed.
    const opSource = (op as { source?: string }).source
    if (opSource !== undefined && opSource !== account) {
      throw new Error(
        `refusing to sign step ${index + 1}: it is sourced from ${opSource}, not the signing account`
      )
    }

    // The subtle failure: the right operation type pointed somewhere else. A
    // path payment to a third party is a transfer wearing a swap's clothes.
    if (DELIVERS_TO_DESTINATION.has(type)) {
      const destination = (op as { destination?: string }).destination
      if (destination !== account) {
        throw new Error(
          `refusing to sign step ${index + 1}: it delivers to ${destination ?? 'an unknown account'}, ` +
            'which is not the signing account. Swaps must return funds to the sender.'
        )
      }
    }

    steps.push({ index, type })
  })

  return steps
}

/** Human-readable names for the confirmation screen. */
const STEP_LABELS: Record<string, string> = {
  pathPaymentStrictSend: 'Swap',
  pathPaymentStrictReceive: 'Swap',
  manageSellOffer: 'Place order',
  manageBuyOffer: 'Place order',
  createPassiveSellOffer: 'Place order',
  liquidityPoolDeposit: 'Add liquidity',
  liquidityPoolWithdraw: 'Withdraw liquidity',
  invokeHostFunction: 'Swap via router',
  changeTrust: 'Allow asset',
}

/**
 * What each step does, in words.
 *
 * A plan the user cannot read is a plan they cannot refuse. Showing "3 steps"
 * without saying which three would make multi-step less safe than single
 * operations, not more.
 */
export function describePlan(steps: PlanStep[]): string[] {
  return steps.map((s, i) => `${i + 1}. ${STEP_LABELS[s.type] ?? s.type}`)
}
