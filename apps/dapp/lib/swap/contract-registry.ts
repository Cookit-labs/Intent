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

/** Soroswap's testnet router. Mirrors the id in [build-soroban.ts]. */
export const SOROSWAP_ROUTER = 'CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD'

/** Blend's testnet lending pool, verified against `get_reserve_list`. */
export const BLEND_POOL = 'CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF'

/**
 * Aquarius's testnet router. Mirrors the id in `sources/aquarius-quoter.ts`.
 *
 * Confirmed live by reading its contract instance on 2026-09-17. Testnet
 * resets remove contracts — three officially documented oracle addresses
 * were found already gone that way — so a live test asserts this one still
 * exists rather than trusting the constant.
 */
export const AQUARIUS_ROUTER = 'CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD'

/**
 * Noether's testnet market and router, as its gateway listed them on
 * 2026-09-23 (`/v1/health`, 624k invocations on the market, 0 errors).
 *
 * These constants decide only how a call is *worded* in review. The perp
 * flow validates an envelope against the ids it resolves from the gateway at
 * request time (`perps/assert-order.ts`), never against these — a testnet
 * reset or a redeploy would otherwise leave this app narrating a call to a
 * contract that no longer exists as a Noether order.
 */
export const NOETHER_MARKET = 'CBHHWFAYLB3SXJCE232DC6WNSK74IBEOROAGCI2AFBA2H5NQOH2KYKNN'
export const NOETHER_ROUTER = 'CBDVQKYEN6QMRGQZC77DFYEQXQHDMCVJ3TPBJKNERJVMIESA6GQT44LG'

/**
 * Where to see a Blend position, as opposed to the transaction that made it.
 *
 * A block explorer proves the supply happened; it does not show the position,
 * the balance, or the rate it is earning. Those live in Blend's own interface,
 * and someone who has just lent wants to see the position rather than the
 * receipt.
 */
export function blendPositionUrl(poolId: string = BLEND_POOL): string {
  return `https://testnet.blend.capital/dashboard/?poolId=${poolId}`
}

const ENTRIES: ContractEntry[] = [
  {
    id: SOROSWAP_ROUTER,
    label: 'Swap via Soroswap',
    functions: {
      swap_exact_tokens_for_tokens: 'Swap via Soroswap',
      swap_tokens_for_exact_tokens: 'Swap via Soroswap',
    },
  },
  {
    id: AQUARIUS_ROUTER,
    label: 'Swap via Aquarius',
    functions: {
      swap: 'Swap via Aquarius',
      // Listed so a multi-hop route reads honestly if one is ever built. The
      // builder does not produce it today and its assertion refuses it.
      swap_chained: 'Swap via Aquarius',
    },
  },
  {
    id: BLEND_POOL,
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
    label: 'Noether router',
    functions: {
      // The venue's own web app opens through the router with a signed oracle
      // price attached. Listed so such an envelope reads honestly if one is
      // ever presented; `assertPerpOrder` checks its arguments either way.
      open_with_price: 'Open a perp position on Noether',
    },
  },
]

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
