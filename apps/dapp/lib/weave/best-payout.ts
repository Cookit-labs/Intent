import type { CashoutChain } from './types'

export type PayoutProvider = 'linq' | 'weave'

/** One provider's offer for a naira cash-out, in the naira that reaches the account. */
export interface PayoutOffer {
  provider: PayoutProvider
  /** Naira after the provider's own fees, as it says before paying. */
  naira: number
  /**
   * Linq states the naira and locks its rate when the order is made. Weave's figure is a quote,
   * and its first real payout landed about 3% below it, so only Linq's is exact.
   */
  exact: boolean
}

/**
 * Where each provider can take a deposit and pay naira today, as seen on its own orders.
 *
 * Linq's docs list Sui (USDC, USDSUI) and Solana (USDC) besides Stellar. They are left out until an
 * order on each has been seen, since no public reference shows what such an order returns.
 *
 * Weave's Stellar orders route through LI.FI and come back with no deposit address, which nothing
 * here can pay (Weave's own order history, 4 November 2026). NEAR is closed in `types.ts`.
 */
export const PAYS_NAIRA: Readonly<Record<PayoutProvider, readonly CashoutChain[]>> = {
  linq: ['stellar'],
  weave: ['solana', 'avalanche', 'sui'],
}

export interface OfferSources {
  /** Linq's naira per dollar, or nothing when it can't be read. */
  linqRate: () => Promise<number | undefined>
  /** Weave's naira for this much USDC from this chain, after its fees, or nothing. */
  weaveNaira: (chain: CashoutChain, usdc: string) => Promise<number | undefined>
}

const usable = (naira: number | undefined): naira is number =>
  naira !== undefined && Number.isFinite(naira) && naira > 0

/**
 * Every offer for cashing out this much USDC from this chain into naira, from each provider that
 * can pay from it. A provider that can't be read gives no offer rather than a guess.
 */
export async function nairaOffers(
  chain: CashoutChain,
  usdc: string,
  sources: OfferSources
): Promise<PayoutOffer[]> {
  const amount = Number(usdc)
  if (!Number.isFinite(amount) || amount <= 0) return []
  const offers: PayoutOffer[] = []
  const reads: Promise<void>[] = []
  if (PAYS_NAIRA.linq.includes(chain)) {
    reads.push(
      sources
        .linqRate()
        .catch(() => undefined)
        .then((rate) => {
          const naira = rate === undefined ? undefined : rate * amount
          if (usable(naira)) offers.push({ provider: 'linq', naira, exact: true })
        })
    )
  }
  if (PAYS_NAIRA.weave.includes(chain)) {
    reads.push(
      sources
        .weaveNaira(chain, usdc)
        .catch(() => undefined)
        .then((naira) => {
          if (usable(naira)) offers.push({ provider: 'weave', naira, exact: false })
        })
    )
  }
  await Promise.all(reads)
  return offers.sort((a, b) => b.naira - a.naira)
}

/**
 * The offer that pays the most naira. Within half a percent, the one whose amount is exact wins,
 * since a quote that can land lower is worth less than a figure that is locked.
 */
export function bestNairaOffer(offers: readonly PayoutOffer[]): PayoutOffer | undefined {
  return [...offers].sort((a, b) => {
    const close = Math.abs(a.naira - b.naira) <= Math.max(a.naira, b.naira) * 0.005
    if (close && a.exact !== b.exact) return a.exact ? -1 : 1
    return b.naira - a.naira
  })[0]
}
