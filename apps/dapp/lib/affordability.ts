import type { StellarBalances } from './stellar-account'

/**
 * Can this account actually pay for the intent it just asked for?
 *
 * Nothing checked this before: a wallet holding $12 could open a $4,000 limit
 * order, and the app would show it as a live position waiting to fill. The
 * order was never fundable, so the only thing it could ever do is fail — after
 * the user had been told for hours that it was working.
 *
 * Checked at the point the intent is created rather than at execution, because
 * the useful moment to hear "you cannot afford this" is before the order is
 * placed, not when it finally triggers.
 */

export type AffordabilityReason =
  | 'ok'
  | 'not_connected'
  | 'unfunded'
  | 'no_trustline'
  | 'insufficient'
  | 'unknown_asset'

export interface Affordability {
  ok: boolean
  reason: AffordabilityReason
  /** What the account holds of the input asset, in display units. */
  available?: string
  /** What the intent needs, in display units. */
  required?: string
  /** User-facing sentence. Empty when `ok`. */
  message: string
}

/**
 * Fees are paid in XLM and the network holds a base reserve, so an account
 * cannot spend its last lumen. Leaving headroom here means a swap that passes
 * this check is not rejected by the network moments later.
 */
const XLM_HEADROOM = 1.5

function format(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 4 })
}

export function checkAffordability(
  amountIn: string,
  tokenIn: string,
  balances: StellarBalances | undefined
): Affordability {
  if (balances === undefined) {
    return {
      ok: false,
      reason: 'not_connected',
      message: 'Connect a wallet to place this order.',
    }
  }

  if (!balances.exists) {
    return {
      ok: false,
      reason: 'unfunded',
      message: 'This account is not funded yet, so it cannot place an order.',
    }
  }

  const required = Number(amountIn)
  if (!Number.isFinite(required) || required <= 0) {
    return { ok: true, reason: 'ok', message: '' }
  }

  const symbol = tokenIn.toUpperCase()

  if (symbol === 'XLM') {
    const held = Number(balances.xlm)
    // The reserve is not spendable, so comparing against the raw balance would
    // approve an order the network then refuses.
    const spendable = Math.max(0, held - XLM_HEADROOM)
    if (required > spendable) {
      return {
        ok: false,
        reason: 'insufficient',
        available: format(spendable),
        required: format(required),
        message: `Not enough XLM. This order needs ${format(required)} XLM and ${format(spendable)} is spendable — the rest covers fees and the account reserve.`,
      }
    }
    return {
      ok: true,
      reason: 'ok',
      available: format(spendable),
      required: format(required),
      message: '',
    }
  }

  if (symbol === 'USDC') {
    if (!balances.hasUsdcTrustline) {
      return {
        ok: false,
        reason: 'no_trustline',
        message:
          'This account has no USDC trustline, so it cannot hold or spend USDC. Add the trustline first.',
      }
    }
    const held = Number(balances.usdc ?? '0')
    if (required > held) {
      return {
        ok: false,
        reason: 'insufficient',
        available: format(held),
        required: format(required),
        message: `Not enough USDC. This order needs ${format(required)} USDC and the account holds ${format(held)}.`,
      }
    }
    return {
      ok: true,
      reason: 'ok',
      available: format(held),
      required: format(required),
      message: '',
    }
  }

  // An asset this app cannot read a balance for is not approved by default:
  // silently allowing it would put the unaffordable-order bug straight back.
  return {
    ok: false,
    reason: 'unknown_asset',
    message: `This app cannot read a ${tokenIn} balance for this account, so it cannot confirm the order is funded.`,
  }
}
