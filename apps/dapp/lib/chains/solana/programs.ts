import type { SolanaVenuePolicy } from './assert-safe'

/**
 * Program ids each venue may invoke at the top level of a transaction.
 *
 * Confirmed against the venue's own docs and then seen in a live, unsigned
 * transaction on 3 November 2026. An id that only appears in what a venue's API
 * returned is not confirmed by that alone, since the API is what is being checked.
 * That is why DFlow and OKX, which Jupiter also routes through, are not here.
 */

/** https://developers.jup.ag/docs/llms-full.txt names it as the Jupiter v6 aggregator. */
export const JUPITER_AGGREGATOR_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'

/** https://developers.jup.ag/docs/lend/architecture.md, "Lending (Earn)". */
export const JUPITER_LEND_PROGRAM = 'jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9'

/** https://kamino.com/docs/build/resources/program-addresses.md, "Kvault" on mainnet. */
export const KVAULT_PROGRAM = 'KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd'

/** https://kamino.com/docs/build/resources/program-addresses.md, "Kfarms" on mainnet. */
export const KFARMS_PROGRAM = 'FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr'

/** https://lulo.fi/docs/integration-guide, "Program ID". */
export const LULO_PROGRAM = 'FL3X2pRsQ9zHENpZSKDRREtccwJuei8yg9fwDu9UN69Q'

/** Anchor's discriminator for `deposit`, which Jupiter Lend Earn and Kamino kVaults share. */
export const DEPOSIT_DISCRIMINATOR = 'f223c68952e1f2b6'

const LULO_DEPOSIT_PROTECTED = 'b7d84be2fe90d407'
const KFARMS_INIT_USER = '6f11b9fa3c7a26fe'
const KFARMS_STAKE = 'ceb0ca12c8d1b36c'

/**
 * A swap route's instructions vary with the route, so Jupiter's are not narrowed
 * to one discriminator. Only this venue may wrap SOL.
 */
export const JUPITER_SWAP_POLICY: SolanaVenuePolicy = {
  venueName: 'Jupiter',
  programs: { [JUPITER_AGGREGATOR_PROGRAM]: {} },
  mayWrapSol: true,
}

export const JUPITER_LEND_POLICY: SolanaVenuePolicy = {
  venueName: 'Jupiter Lend',
  programs: { [JUPITER_LEND_PROGRAM]: { discriminators: [DEPOSIT_DISCRIMINATOR] } },
  mayWrapSol: false,
}

export const KAMINO_POLICY: SolanaVenuePolicy = {
  venueName: 'Kamino',
  programs: {
    [KVAULT_PROGRAM]: { discriminators: [DEPOSIT_DISCRIMINATOR] },
    [KFARMS_PROGRAM]: { discriminators: [KFARMS_INIT_USER, KFARMS_STAKE] },
  },
  mayWrapSol: false,
}

export const LULO_POLICY: SolanaVenuePolicy = {
  venueName: 'Lulo',
  programs: { [LULO_PROGRAM]: { discriminators: [LULO_DEPOSIT_PROTECTED] } },
  mayWrapSol: false,
}
