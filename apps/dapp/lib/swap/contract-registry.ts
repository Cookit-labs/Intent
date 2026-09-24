import { activeNetwork } from '@intent/config'

import { venueIdOn } from '../venues'

/**
 * Which Soroban contracts a plan may call, and what each one is named on the
 * confirmation screen.
 *
 * The gap this closes: `assertSelfPlan` allowed `invokeHostFunction` by
 * operation type and labelled every one of them "Swap via router". A call to
 * *any* contract on the network passed validation and was described to the user
 * as a swap. The numbered review list is the entire reason one signature over
 * several operations is acceptable, so a list that names the wrong action is
 * worse than no list.
 *
 * Two properties follow from an allowlist keyed by contract id:
 *
 * - An unrecognised contract fails the envelope rather than being narrated as
 *   something familiar.
 * - The label comes from the contract, so "Supply to Blend" and "Swap via
 *   Soroswap" are distinguishable in review even though both are the same
 *   operation type.
 *
 * Function names are part of the entry, not decoration. A pool contract that
 * supplies also withdraws and borrows, and "Supply to Blend" over a `borrow`
 * call would be a lie told by the safety mechanism itself.
 */

export interface ContractEntry {
  /** Contract id, as a strkey. */
  id: string
  /** Shown on the confirmation screen when no function-specific label applies. */
  label: string
  /**
   * Functions this app calls on the contract, and how each reads in review.
   *
   * A call to a function absent from this map is refused. The alternative —
   * allowing the contract and labelling unknown functions generically — is the
   * same mistake one level down: `borrow` narrated as "Supply to Blend" would
   * be signed by someone who read the screen carefully and still got it wrong.
   */
  functions: Record<string, string>
}

/**
 * Which network's ids this module hands out, decided once at import like the
 * config it reads. Every constant below is a `{ testnet, mainnet }` pair, and
 * `mainnet` is `undefined` wherever no id could be verified from the venue's
 * own documentation or deployment repository — an unverified venue is absent
 * from the allowlist there rather than guessed at. A testnet id is never on
 * the mainnet allowlist, nor the reverse: a signature is only handed to a
 * contract this app has reviewed on the network it is about to be broadcast to.
 */
const NETWORK = activeNetwork()

function onActiveNetwork<M extends string | undefined>(ids: {
  testnet: string
  mainnet: M
}): string | M {
  return NETWORK === 'mainnet' ? ids.mainnet : ids.testnet
}

/**
 * Soroswap's router. The builder and the quoter read this rather than
 * carrying their own copy.
 *
 * Mainnet from `public/mainnet.contracts.json` in Soroswap's core repository,
 * https://github.com/soroswap/core/blob/main/public/mainnet.contracts.json
 * (`ids.router`, read 2026-09-24); the same file's testnet entry is the id
 * below. Its instance was read on the public network the same day.
 */
export const SOROSWAP_ROUTER = onActiveNetwork({
  testnet: 'CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD',
  mainnet: 'CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH',
})

/**
 * Blend's lending pool, verified against `get_reserve_list` on each network.
 *
 * Testnet is the v2 pool Blend's own deployment file names `TestnetV2`.
 * Mainnet is its v2 `Fixed` pool — XLM and USDC, the main USDC pool — from
 * https://github.com/blend-capital/blend-utils/blob/main/mainnet.contracts.json
 * (`ids.FixedV2`, read 2026-09-24). Its reserve list on the public network
 * answered XLM and USDC that day.
 */
export const BLEND_POOL = onActiveNetwork({
  testnet: 'CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF',
  mainnet: 'CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD',
})

/**
 * Aquarius's router. The quoter and the builder read this rather than
 * carrying their own copy.
 *
 * Testnet confirmed live by reading its contract instance on 2026-09-17.
 * Testnet resets remove contracts — three officially documented oracle
 * addresses were found already gone that way — so a live test asserts this
 * one still exists rather than trusting the constant.
 *
 * Mainnet from Aquarius's own developer documentation, "Soroban Contract
 * Addresses" at
 * https://docs.aqua.network/developers/code-examples/prerequisites-and-basics
 * (read 2026-09-24), whose testnet entry is the id below. Its instance was
 * read on the public network the same day.
 */
export const AQUARIUS_ROUTER = onActiveNetwork({
  testnet: 'CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD',
  mainnet: 'CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK',
})

/**
 * Soroswap's testnet aggregator: a different contract from the router above,
 * which splits one swap across several venues' adapters.
 *
 * Returned by `GET /api/testnet/aggregator` on 2026-09-23, and its
 * `get_adapters()` simulated the same day. The quoter resolves the live id at
 * runtime rather than reading this constant; this is the *allowlist* — the id
 * a signature may be given to. If the API ever hands back a different one,
 * the builder refuses rather than following it, because a contract this app
 * has not reviewed is not one it should narrate as "Swap".
 *
 * Mainnet from `public/mainnet.contracts.json` in Soroswap's aggregator
 * repository,
 * https://github.com/soroswap/aggregator/blob/main/public/mainnet.contracts.json
 * (`ids.aggregator`, read 2026-09-24). Its `get_adapters()` on the public
 * network that day listed the Soroswap and Aquarius routers above.
 */
export const SOROSWAP_AGGREGATOR = onActiveNetwork({
  testnet: 'CC74XDT7UVLUZCELKBIYXFYIX6A6LGPWURJVUXGRPQO745RWX7WEURMA',
  mainnet: 'CAYP3UWLJM7ZPTUKL6R6BFGTRWLZ46LRKOXTERI2K6BIJAWGYY62TXTO',
})

/**
 * Noether's testnet market and router, as its gateway listed them on
 * 2026-09-23 (`/v1/health`, 624k invocations on the market, 0 errors).
 *
 * These constants decide only how a call is *worded* in review. The perp
 * flow validates an envelope against the ids it resolves from the gateway at
 * request time (`perps/assert-order.ts`), never against these — a testnet
 * reset or a redeploy would otherwise leave this app narrating a call to a
 * contract that no longer exists as a Noether order.
 *
 * No mainnet ids: Noether has not launched there (see `noether-client.ts`),
 * so on mainnet both are `undefined` and the venue is off the allowlist.
 */
export const NOETHER_MARKET = onActiveNetwork({
  testnet: 'CBHHWFAYLB3SXJCE232DC6WNSK74IBEOROAGCI2AFBA2H5NQOH2KYKNN',
  mainnet: undefined,
})
export const NOETHER_ROUTER = onActiveNetwork({
  testnet: 'CBDVQKYEN6QMRGQZC77DFYEQXQHDMCVJ3TPBJKNERJVMIESA6GQT44LG',
  mainnet: undefined,
})

/**
 * Where to see a Blend position, as opposed to the transaction that made it.
 *
 * A block explorer proves the supply happened; it does not show the position,
 * the balance, or the rate it is earning. Those live in Blend's own interface,
 * and someone who has just lent wants to see the position rather than the
 * receipt.
 */
export function blendPositionUrl(poolId: string = BLEND_POOL): string {
  const host = NETWORK === 'mainnet' ? 'mainnet' : 'testnet'
  return `https://${host}.blend.capital/dashboard/?poolId=${poolId}`
}

/** Every contract the app knows, on this network or not; see `ENTRIES`. */
const CANDIDATES: (Omit<ContractEntry, 'id'> & { id: string | undefined; venue: string })[] = [
  {
    id: SOROSWAP_ROUTER,
    venue: 'soroswap',
    label: 'Swap via Soroswap',
    functions: {
      swap_exact_tokens_for_tokens: 'Swap via Soroswap',
      swap_tokens_for_exact_tokens: 'Swap via Soroswap',
    },
  },
  {
    id: AQUARIUS_ROUTER,
    venue: 'aquarius',
    label: 'Swap via Aquarius',
    functions: {
      swap: 'Swap via Aquarius',
      // The router's two multi-hop entry points, read from its live interface
      // on 2026-09-23. Listed so a chained route reads honestly if a plan ever
      // builds one; the swap builder does not produce either today and its
      // assertion refuses both.
      swap_chained: 'Swap via Aquarius',
      swap_chained_strict_receive: 'Swap via Aquarius',
    },
  },
  {
    id: SOROSWAP_AGGREGATOR,
    venue: 'soroswap-aggregator',
    label: 'Swap via Soroswap aggregator',
    // The two trade entrypoints from the contract's `SoroswapAggregatorTrait`,
    // and nothing else. It also exposes `update_adapters`, `set_pause`,
    // `set_admin` and `upgrade`; none is something a swap does, and a review
    // line reading "Swap" over any of them would be the registry lying.
    functions: {
      swap_exact_tokens_for_tokens: 'Swap via Soroswap aggregator',
      swap_tokens_for_exact_tokens: 'Swap via Soroswap aggregator',
    },
  },
  {
    id: BLEND_POOL,
    venue: 'blend',
    label: 'Blend lending pool',
    functions: {
      // `submit` carries a request vector whose type decides whether this is
      // a supply, a withdrawal, collateral, a borrow or a repayment, and this
      // registry labels by function name alone. The label is accurate here
      // because the only path that reaches this table is a *plan* step, and
      // `build-plan` builds supplies only. The direct lend routes never
      // consult it — each asserts its own shape and names its own noun in a
      // refusal (see `assertSelfPoolCall` in lend/blend-client.ts). If a
      // plan step ever carries another request type, this label must learn
      // to read the vector rather than stay a constant.
      submit: 'Supply to Blend',
    },
  },
  {
    id: NOETHER_MARKET,
    venue: 'noether',
    label: 'Noether perps market',
    functions: {
      // The isolated open the gateway's `/v1/orders/prepare` builds. Closing,
      // cross margin and orders are deliberately absent: nothing here builds
      // them, and a label for a call no builder produces would only ever
      // narrate a substituted envelope.
      open_position: 'Open a perp position on Noether',
    },
  },
  {
    id: NOETHER_ROUTER,
    venue: 'noether',
    label: 'Noether router',
    functions: {
      // The venue's own web app opens through the router with a signed oracle
      // price attached. Listed so such an envelope reads honestly if one is
      // ever presented; `assertPerpOrder` checks its arguments either way.
      open_with_price: 'Open a perp position on Noether',
    },
  },
]

/**
 * The candidates that exist on this network. One whose id is `undefined`
 * has no verified contract here, and one whose venue is not on this network
 * is not allowlisted either, however real its contract: a verified id is a
 * fact about the chain, and whether the app executes there is a separate
 * decision (`networks` in `lib/venues.ts`).
 */
const ENTRIES: ContractEntry[] = CANDIDATES.filter(
  (e): e is ContractEntry & { venue: string } => e.id !== undefined && venueIdOn(e.venue)
)

const BY_ID = new Map(ENTRIES.map((e) => [e.id, e]))

export function lookupContract(id: string): ContractEntry | undefined {
  return BY_ID.get(id)
}

/**
 * What a contract call should read as in review, or a reason to refuse it.
 *
 * Returns a discriminated result rather than throwing, so the validator owns
 * the message and its step numbering — this file knows nothing about which step
 * it is describing.
 */
export function labelForCall(
  contractId: string | undefined,
  functionName: string | undefined
): { ok: true; label: string } | { ok: false; reason: string } {
  if (contractId === undefined) {
    return {
      ok: false,
      reason: 'the contract being called could not be read from the transaction',
    }
  }

  const entry = BY_ID.get(contractId)
  if (entry === undefined) {
    return {
      ok: false,
      reason: `${contractId} is not a contract this app calls`,
    }
  }

  if (functionName === undefined) {
    return {
      ok: false,
      reason: `the function being called on ${entry.label} could not be read`,
    }
  }

  const label = entry.functions[functionName]
  if (label === undefined) {
    return {
      ok: false,
      reason: `${entry.label} does not accept ${functionName} from this app`,
    }
  }

  return { ok: true, label }
}
