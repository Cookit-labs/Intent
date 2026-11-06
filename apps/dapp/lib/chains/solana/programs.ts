import type { ExitInstructionRule, SolanaExitPolicy, SolanaVenuePolicy } from './assert-safe'

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

/**
 * Kamino Limo, the limit order program, and the global config its own app's orders sit under. No
 * Kamino page names either. Read from `@kamino-finance/limo-sdk` 4.0.0 and on chain on 5 November
 * 2026: see docs/research/2026-11-05-limit-orders/solana.md. The config is pinned because another
 * one has another admin and another set of fillers.
 */
export const LIMO_PROGRAM = 'LiMoM9rMhrdYrfzUCxQppvxCSG1FcrUK9G8uLq4A1GF'
export const LIMO_GLOBAL_CONFIG = 'prod7Mog8r56sn5dPwze8nVdf94veEawdxNNqd5v7A1'
export const LIMO_CREATE_ORDER = '8d3625cfedd2fad7'
export const LIMO_CLOSE_ORDER = 'f41b0ce22df7e62b'
export const LIMO_ORDER_BYTES = 424
/** The rent-exempt minimum for 424 bytes, which the SDK pins too. */
export const LIMO_ORDER_RENT = 3_841_920

/** Anchor's discriminator for `deposit`, which Jupiter Lend Earn and Kamino kVaults share. */
export const DEPOSIT_DISCRIMINATOR = 'f223c68952e1f2b6'

/** Anchor's discriminator for `withdraw`, which Jupiter Lend Earn and Kamino kVaults share. */
export const WITHDRAW_DISCRIMINATOR = 'b712469c946da122'

const LULO_DEPOSIT_PROTECTED = 'b7d84be2fe90d407'
const KFARMS_INIT_USER = '6f11b9fa3c7a26fe'
const KFARMS_STAKE = 'ceb0ca12c8d1b36c'

const KVAULT_WITHDRAW_FROM_AVAILABLE = '1383709baadc2239'
export const KFARMS_UNSTAKE = '5a5f6b2acd7c32e1'
const KFARMS_WITHDRAW_UNSTAKED = '2466bb31dc248443'
/** Seen as `WithdrawProtectedPool` in Lulo's logs on chain. Its interface isn't published. */
const LULO_WITHDRAW_PROTECTED = '6df71466fe3d766c'

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'

/** https://developers.jup.ag/docs/lend/architecture.md, the layer Earn lends through. */
export const JUPITER_LIQUIDITY_PROGRAM = 'jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC'
/**
 * Addresses from the seeds in https://github.com/jup-ag/jupiter-lend `docs/earn/cpi.md`, which a
 * test derives again. On chain on 5 November 2026, each pool was owned by the Earn program and named
 * these mints, and Jupiter's own API built withdrawals with these same accounts.
 */
export const JUPITER_LEND_ADMIN = '5nmGjA4s7ATzpBQXC5RNceRpaJ7pYw2wKsNBWyuSAZV6'
export const JUPITER_LIQUIDITY = '7s1da8DduuBFqGra5bJBjpnvL5E9mGzCuMk1Qkh4or2Z'
export const JUPITER_LEND_MARKETS = [
  {
    symbol: 'USDC',
    mint: USDC_MINT,
    receipt: '9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D',
    pool: '2vVYHYM8VYnvZqQWpTJSj8o8DBf1wM8pVs3bsTgYZiqJ',
  },
  {
    symbol: 'USDT',
    mint: USDT_MINT,
    receipt: 'Cmn4v2wipYV41dkakDvCgFJpxhtaaKt11NyWV8pjSE8A',
    pool: 'F7tLdeF2YZZex9MR8HgGggyFiz7UU2UgUube2tmfwNPE',
  },
] as const

/**
 * Seen as the account of `Withdraw` on chain, owned by the kVault program and holding the charge
 * https://github.com/Kamino-Finance/klend-sdk `src/@codegen/kvault/accounts/GlobalConfig.ts` lays out.
 */
export const KVAULT_GLOBAL_CONFIG = 'BKyTcUe6daNG8HbgBix2ugdRHbykG2dK9hPBBqhUyoEX'

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

/**
 * Account positions from https://github.com/Kamino-Finance/klend-sdk `src/idl/kvault.json`, in which
 * a `withdraw` opens with the same accounts as a `withdrawFromAvailable`. Both, and the two farm
 * steps, were seen in transactions Kamino's API built on 5 November 2026 and simulated on chain.
 */
const KAMINO_EXIT_RULES: readonly ExitInstructionRule[] = [
  {
    program: KVAULT_PROGRAM,
    discriminator: WITHDRAW_DISCRIMINATOR,
    signers: [0],
    recipient: 5,
    shares: 7,
  },
  {
    program: KVAULT_PROGRAM,
    discriminator: KVAULT_WITHDRAW_FROM_AVAILABLE,
    signers: [0],
    recipient: 5,
    shares: 7,
  },
  { program: KFARMS_PROGRAM, discriminator: KFARMS_UNSTAKE, signers: [0] },
  { program: KFARMS_PROGRAM, discriminator: KFARMS_WITHDRAW_UNSTAKED, signers: [0], shares: 3 },
]

export const KAMINO_EXIT_POLICY: SolanaExitPolicy = {
  venueName: 'Kamino',
  programs: {
    [KVAULT_PROGRAM]: {
      discriminators: [WITHDRAW_DISCRIMINATOR, KVAULT_WITHDRAW_FROM_AVAILABLE],
    },
    [KFARMS_PROGRAM]: { discriminators: [KFARMS_UNSTAKE, KFARMS_WITHDRAW_UNSTAKED] },
  },
  mayWrapSol: false,
  mayCloseOwnAccounts: true,
  mint: USDC_MINT,
  rules: KAMINO_EXIT_RULES,
}

/**
 * Lulo publishes no interface for this program. Positions come from what its API built and what
 * landed on chain: the owner twice, the mint, then the owner's token account for that mint.
 */
export const LULO_EXIT_POLICY: SolanaExitPolicy = {
  venueName: 'Lulo',
  programs: { [LULO_PROGRAM]: { discriminators: [LULO_WITHDRAW_PROTECTED] } },
  mayWrapSol: false,
  mint: USDC_MINT,
  rules: [
    {
      program: LULO_PROGRAM,
      discriminator: LULO_WITHDRAW_PROTECTED,
      signers: [0, 1],
      recipient: 3,
    },
  ],
}

/** `update_order` and `initialize_vault` are left out on purpose. See limo-rules.ts for the rest. */
export const LIMO_POLICY: SolanaVenuePolicy = {
  venueName: 'Kamino Limit Orders',
  programs: { [LIMO_PROGRAM]: { discriminators: [LIMO_CREATE_ORDER, LIMO_CLOSE_ORDER] } },
  mayWrapSol: true,
  createsSigner: {
    owner: LIMO_PROGRAM,
    space: BigInt(LIMO_ORDER_BYTES),
    lamports: BigInt(LIMO_ORDER_RENT),
  },
}
