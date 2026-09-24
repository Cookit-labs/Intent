import { stellarNetwork } from '@intent/config'

/**
 * Stellar's built-in liquidity pools.
 *
 * A yield primitive that needs no protocol integration at all: deposit both
 * sides of a pair, earn a share of the 30bp fee on every trade the network
 * routes through it, withdraw whenever. There is no contract to trust, no
 * team that can shut it down, and no governance token — the network runs it.
 *
 * The reading is less trivial than it looks. A share balance means nothing on
 * its own: owning 50 of 500 shares is a claim on a tenth of *whatever the pool
 * holds right now*, and that changes with every trade against it. So a
 * position is computed against live reserves rather than recorded at deposit
 * time, and the same shares are worth different amounts of each asset from one
 * hour to the next.
 */

/** A pool as Horizon returns it. */
export interface HorizonPool {
  id: string
  /** Basis points. Every pool is 30 today, but it is returned rather than assumed. */
  fee_bp: number
  total_shares: string
  total_trustlines: string
  reserves: { asset: string; amount: string }[]
}

export interface PoolAsset {
  code: string
  /** Absent for native XLM. Kept because a ticker alone does not identify an asset. */
  issuer?: string
  amount: string
}

export interface Pool {
  id: string
  assets: PoolAsset[]
  feePct: number
  totalShares: string
  /**
   * Second asset per first, from the reserves.
   *
   * Undefined when either side is empty: a pool holding 9 XLM and no USDC
   * exists on testnet today, and dividing by it would produce Infinity and
   * render as a price.
   */
  impliedPrice?: number
  /** True when either side has nothing in it, so the pool cannot trade. */
  isEmpty: boolean
}

/** Horizon writes the native asset as the string "native". */
function parseAsset(asset: string, amount: string): PoolAsset {
  if (asset === 'native') return { code: 'XLM', amount }
  const [code = '', issuer = ''] = asset.split(':')
  return { code, issuer, amount }
}

export function parsePool(raw: HorizonPool): Pool {
  const assets = raw.reserves.map((r) => parseAsset(r.asset, r.amount))

  const first = Number(assets[0]?.amount ?? '0')
  const second = Number(assets[1]?.amount ?? '0')
  const isEmpty = first <= 0 || second <= 0

  return {
    id: raw.id,
    assets,
    // Basis points to a percentage, because "30bp" means nothing to most
    // people and "0.3%" means something to everyone.
    feePct: raw.fee_bp / 100,
    totalShares: raw.total_shares,
    ...(isEmpty ? {} : { impliedPrice: second / first }),
    isEmpty,
  }
}

export interface PoolPosition {
  /** What the shares are worth in each asset, right now. */
  amounts: { code: string; amount: string }[]
  /** Portion of the pool owned, as a percentage. */
  sharePct: number
}

/**
 * What a share balance is currently worth.
 *
 * Computed rather than stored, because the answer changes with every trade
 * against the pool. A position recorded at deposit time would drift from the
 * truth immediately and silently — which is the same class of mistake as
 * remembering a swap instead of reading it from the ledger.
 */
export function poolShare(pool: Pool, shares: string): PoolPosition {
  const held = Number(shares)
  const total = Number(pool.totalShares)

  // A pool can exist with no shares outstanding once everyone has withdrawn.
  if (!Number.isFinite(held) || !Number.isFinite(total) || total <= 0 || held <= 0) {
    return {
      amounts: pool.assets.map((a) => ({ code: a.code, amount: '0' })),
      sharePct: 0,
    }
  }

  const fraction = held / total
  return {
    amounts: pool.assets.map((a) => ({
      code: a.code,
      amount: (Number(a.amount) * fraction).toFixed(7),
    })),
    sharePct: fraction * 100,
  }
}

export interface PoolOptions {
  horizonUrl?: string
  fetchImpl?: typeof fetch
  limit?: number
}

/**
 * Pools with real depth on both sides.
 *
 * Filtered because most of what Horizon returns is unusable: pools holding a
 * fraction of a unit, or one side at zero. Offering those would mean showing a
 * user a market they cannot trade into, and an agent a route that cannot fill.
 */
export async function fetchPools(options: PoolOptions = {}): Promise<Pool[]> {
  const horizonUrl = options.horizonUrl ?? stellarNetwork.horizonUrl
  const doFetch = options.fetchImpl ?? fetch
  const limit = options.limit ?? 200

  const res = await doFetch(`${horizonUrl}/liquidity_pools?limit=${limit}`, {
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`Horizon ${res.status}`)

  const body = (await res.json()) as { _embedded?: { records?: HorizonPool[] } }
  return (body._embedded?.records ?? [])
    .filter((r) => r.reserves.length === 2)
    .map(parsePool)
    .filter((p) => !p.isEmpty)
}

/**
 * The pools an account has a position in.
 *
 * Read from the account's own balances: a pool share is a balance like any
 * other, with `asset_type: 'liquidity_pool_shares'`. Nothing is stored here —
 * the ledger already knows, and asking it is cheaper than keeping a copy
 * honest.
 */
export async function fetchPoolPositions(
  account: string,
  options: PoolOptions = {}
): Promise<{ poolId: string; shares: string }[]> {
  const horizonUrl = options.horizonUrl ?? stellarNetwork.horizonUrl
  const doFetch = options.fetchImpl ?? fetch

  const res = await doFetch(`${horizonUrl}/accounts/${account}`, {
    headers: { Accept: 'application/json' },
  })
  // An unfunded account holds nothing, which is an answer rather than a fault.
  if (res.status === 404) return []
  if (!res.ok) throw new Error(`Horizon ${res.status}`)

  const body = (await res.json()) as {
    balances?: { asset_type: string; balance: string; liquidity_pool_id?: string }[]
  }

  return (body.balances ?? [])
    .filter((b) => b.asset_type === 'liquidity_pool_shares' && b.liquidity_pool_id !== undefined)
    .map((b) => ({ poolId: b.liquidity_pool_id as string, shares: b.balance }))
}
