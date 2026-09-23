import { stellarTestnet } from '@intent/config'
import {
  Address,
  FeeBumpTransaction,
  TransactionBuilder,
  xdr,
  type Operation,
} from '@stellar/stellar-sdk'

import { labelForCall } from './contract-registry'

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
  // Permitted by type, but not on that alone: the contract and function are
  // checked against the registry below. Allowing the type by itself would admit
  // a call to any contract on the network and narrate it as a swap.
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
  /**
   * For a contract call, what it does in words — resolved from the contract
   * rather than the operation type.
   *
   * Carried on the step because `describePlan` sees only steps, and a step
   * that knows only "invokeHostFunction" cannot tell a Soroswap swap from a
   * Blend supply. Absent for classic operations, whose type is enough.
   */
  label?: string
}

/**
 * The contract and function an `invokeHostFunction` operation calls.
 *
 * Read back out of the encoded XDR rather than taken from whatever built it,
 * which is the same discipline the rest of this file applies: the inputs are
 * already believed correct, and what matters is what the bytes about to be
 * signed actually say.
 *
 * Anything that is not a contract invocation — uploading Wasm, creating a
 * contract — returns nothing and is refused by the caller. Neither is something
 * a trading plan does.
 */
export function readContractCall(op: Operation): { contractId?: string; functionName?: string } {
  // A decoded operation carries the host function already converted out of the
  // raw union: `type` is a plain string and `invokeContract` a plain property,
  // not the accessor methods the XDR classes expose. Verified against a decoded
  // envelope rather than assumed from the type definitions.
  const hostFunction = (op as unknown as { func?: { type?: string; invokeContract?: unknown } })
    .func
  if (hostFunction === undefined) return {}

  // Uploading Wasm or creating a contract are host functions too, and neither
  // is something a trading plan does. Both fall through to a refusal.
  if (hostFunction.type !== 'hostFunctionTypeInvokeContract') return {}

  const invocation = hostFunction.invokeContract as
    | { contractAddress?: xdr.ScAddress; functionName?: unknown }
    | undefined
  if (invocation === undefined) return {}

  const result: { contractId?: string; functionName?: string } = {}

  try {
    if (invocation.contractAddress !== undefined) {
      result.contractId = Address.fromScAddress(invocation.contractAddress).toString()
    }
  } catch {
    // Left undefined; the caller refuses a call whose contract cannot be read.
  }

  // The function name decodes to an `XdrString`, not a plain string and not a
  // byte array. Its `toString()` yields the symbol; `Buffer.from()` on it
  // silently yields the right number of *zero* bytes, which would match nothing
  // in the registry and refuse every call for an unrelated reason. Verified
  // against a decoded envelope rather than inferred from the types.
  const name = invocation.functionName
  if (typeof name === 'string') {
    result.functionName = name
  } else if (name !== undefined && name !== null) {
    const text = String(name)
    if (text.length > 0) result.functionName = text
  }

  return result
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

    // A contract call is the one operation whose type says nothing about what
    // it does. Every other entry in the allowlist is self-describing;
    // `invokeHostFunction` could be a swap, a supply, a borrow, or a transfer
    // of the whole balance to somebody else's contract.
    if (type === 'invokeHostFunction') {
      const { contractId, functionName } = readContractCall(op)
      const resolved = labelForCall(contractId, functionName)
      if (!resolved.ok) {
        throw new Error(
          `refusing to sign step ${index + 1}: ${resolved.reason}. ` +
            'A plan may only call contracts this app integrates.'
        )
      }
      steps.push({ index, type, label: resolved.label })
      return
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
  changeTrust: 'Allow asset',
  // Deliberately absent: `invokeHostFunction`. There is no honest label for a
  // contract call that does not name the contract, and the previous entry
  // ("Swap via router") described a Blend supply as a swap. A step of this type
  // always carries its own label, resolved from the registry.
}

/**
 * What each step does, in words.
 *
 * A plan the user cannot read is a plan they cannot refuse. Showing "3 steps"
 * without saying which three would make multi-step less safe than single
 * operations, not more.
 */
export function describePlan(steps: PlanStep[]): string[] {
  // The step's own label wins where it has one: only the step knows which
  // contract a call went to, and that is the difference between "Supply to
  // Blend" and "Swap via Soroswap".
  return steps.map((s, i) => `${i + 1}. ${s.label ?? STEP_LABELS[s.type] ?? s.type}`)
}
