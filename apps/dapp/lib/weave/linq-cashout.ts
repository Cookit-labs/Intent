import type { LinqClient, LinqOrder } from '../linq/client'
import { NIGERIAN_BANKS } from '../naira/banks'

import type { CashoutChain } from './types'

const plain = (text: string): string => text.toUpperCase().replace(/[^A-Z0-9]/g, '')

/**
 * Linq's bank for the one Weave's list named. Weave lists Paycrest codes and Linq takes NIP codes,
 * so the two meet on the bank's name, which both take from the same register. A bank whose name
 * isn't matched exactly has no Linq code, and the cash-out stays with Weave.
 */
export function linqBank(institutionName: string): { code: string; name: string } | undefined {
  const wanted = plain(institutionName)
  const bank = NIGERIAN_BANKS.find((b) => plain(b.name) === wanted)
  return bank === undefined ? undefined : { code: bank.code, name: bank.name }
}

const words = (text: string): string =>
  text
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((w) => w !== '')
    .sort()
    .join(' ')

/**
 * Whether two lookups of an account name the same holder. Case, spacing, punctuation and the order
 * of the names don't matter, since banks list surnames first or last. Every word must match.
 */
export function sameHolder(a: string, b: string): boolean {
  const left = words(a)
  return left !== '' && left === words(b)
}

export interface LinqPlacementInput {
  linq: Pick<LinqClient, 'configured' | 'verifyBank' | 'createOrder'>
  chain: CashoutChain
  currency: string
  /** USDC, decimal text, already read to the chain's decimals. */
  amount: string
  institutionName: string
  accountIdentifier: string
  /** The holder Weave's lookup named. Linq's lookup must name the same one. */
  accountName: string
  /** The person's own wallet, where Linq returns the deposit if the payout fails. */
  refundAddress: string
  customerRef: string
  idempotencyKey: string
}

export type LinqPlacement =
  | { placed: LinqOrder }
  | {
      /** Why the cash-out falls back to Weave. Never shown; reported, since Linq should take it. */
      skipped:
        | 'not_offered'
        | 'no_bank'
        | 'not_verified'
        | 'other_holder'
        | 'order_refused'
        | 'order_unknown'
        | 'order_unexpected'
        | 'locked_nothing'
    }

/** The chains where a naira cash-out can go to Linq or Weave. Stellar naira has its own Linq form. */
export function comparesLinq(chain: CashoutChain): chain is 'sui' | 'solana' {
  return chain === 'sui' || chain === 'solana'
}

/**
 * Places every Sui or Solana naira cash-out with Linq, whatever Weave quotes, because Linq locks the
 * naira it pays and Weave's estimate comes in lower than shown. Decided by the user, 10 November 2026.
 *
 * Weave takes it only when Linq can't: a bank it doesn't know, a lookup or order that fails, or an
 * answer that can't be confirmed. An order Linq made but this app doesn't keep is never shown to
 * anyone, so nothing can be paid into it.
 */
export async function placeWithLinq(input: LinqPlacementInput): Promise<LinqPlacement> {
  const { linq, chain } = input
  if (input.currency !== 'NGN' || !comparesLinq(chain) || !linq.configured) {
    return { skipped: 'not_offered' }
  }

  const bank = linqBank(input.institutionName)
  if (bank === undefined) return { skipped: 'no_bank' }
  const verified = await linq.verifyBank({
    bankCode: bank.code,
    accountNumber: input.accountIdentifier,
  })
  if (!verified.ok) return { skipped: 'not_verified' }
  if (!sameHolder(verified.value.accountName, input.accountName)) {
    return { skipped: 'other_holder' }
  }

  const made = await linq.createOrder({
    chain,
    coin: 'usdc',
    amountStableCoin: Number(input.amount),
    bankCode: bank.code,
    bankName: bank.name,
    bankAccount: input.accountIdentifier,
    accountName: verified.value.accountName,
    refundAddress: input.refundAddress,
    customerRef: input.customerRef,
    idempotencyKey: input.idempotencyKey,
  })
  if (!made.ok) {
    return {
      skipped:
        made.code === 'unknown'
          ? 'order_unknown'
          : made.code === 'unexpected_order'
            ? 'order_unexpected'
            : 'order_refused',
    }
  }

  // The order locks its own naira, which is what the person is shown and paid.
  if (!(made.value.amountNGN > 0)) return { skipped: 'locked_nothing' }
  return { placed: made.value }
}
