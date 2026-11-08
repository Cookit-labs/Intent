import type { LinqClient, LinqOrder } from '../linq/client'
import { NIGERIAN_BANKS } from '../naira/banks'

import { bestNairaOffer, nairaOffers, type PayoutOffer } from './best-payout'
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

/** Whether two lookups of an account name the same holder, ignoring case, spacing and punctuation. */
export function sameHolder(a: string, b: string): boolean {
  const left = plain(a)
  return left !== '' && left === plain(b)
}

export interface LinqPlacementInput {
  linq: Pick<LinqClient, 'configured' | 'getRate' | 'verifyBank' | 'createOrder'>
  chain: CashoutChain
  currency: string
  /** USDC, decimal text, already read to the chain's decimals. */
  amount: string
  /** Weave's naira for the same cash-out after its fees, or nothing when it has no usable quote. */
  weaveNaira: number | undefined
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
      /** Why the cash-out stays with Weave. Never shown; reported when it is a fault. */
      skipped:
        | 'not_offered'
        | 'weave_pays_more'
        | 'no_bank'
        | 'not_verified'
        | 'other_holder'
        | 'order_refused'
        | 'order_unknown'
        | 'order_unexpected'
        | 'locked_lower'
    }

/** The chains where a naira cash-out can go to Linq or Weave. Stellar naira has its own Linq form. */
export function comparesLinq(chain: CashoutChain): chain is 'sui' | 'solana' {
  return chain === 'sui' || chain === 'solana'
}

/**
 * Places a Sui or Solana naira cash-out with Linq when Linq pays more than Weave, and says why not
 * otherwise.
 *
 * Every step that can't be confirmed hands the cash-out back to Weave. An order Linq made but this
 * app doesn't keep is never shown to anyone, so nothing can be paid into it.
 */
export async function placeWithLinq(input: LinqPlacementInput): Promise<LinqPlacement> {
  const { linq, chain } = input
  if (input.currency !== 'NGN' || !comparesLinq(chain) || !linq.configured) {
    return { skipped: 'not_offered' }
  }

  const offers = await nairaOffers(chain, input.amount, {
    linqRate: async () => {
      const rate = await linq.getRate()
      return rate.ok ? rate.value.ngnPerUsd : undefined
    },
    weaveNaira: async () => input.weaveNaira,
  })
  if (bestNairaOffer(offers)?.provider !== 'linq') return { skipped: 'weave_pays_more' }

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

  // The order locks its own naira, which is what the person is shown and paid. It must still beat Weave.
  const locked: PayoutOffer[] = [{ provider: 'linq', naira: made.value.amountNGN, exact: true }]
  if (input.weaveNaira !== undefined) {
    locked.push({ provider: 'weave', naira: input.weaveNaira, exact: false })
  }
  if (made.value.amountNGN <= 0 || bestNairaOffer(locked)?.provider !== 'linq') {
    return { skipped: 'locked_lower' }
  }
  return { placed: made.value }
}
