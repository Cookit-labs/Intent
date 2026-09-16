import { STELLAR_USDC, stellarTestnet } from '@intent/config'

/**
 * Horizon account reads over plain REST.
 *
 * Deliberately not using `@stellar/stellar-sdk`: reading a balance is one GET,
 * while the SDK is a multi-megabyte dependency that exists for building and
 * signing transactions. When contract calls land, the SDK earns its place —
 * until then this keeps the Stellar bundle near zero.
 */

export interface StellarBalances {
  /** Native XLM, formatted. */
  xlm: string
  /** USDC balance if a trustline exists, otherwise undefined. */
  usdc: string | undefined
  /** Stellar requires an explicit trustline before an account can hold USDC. */
  hasUsdcTrustline: boolean
  /** An account that has never been funded does not exist on-chain at all. */
  exists: boolean
  /**
   * Every asset the account can hold, by code.
   *
   * The two fields above cover USDC because that was the only issued asset the
   * app traded. Tokenized treasuries need the same question answered for each
   * of them, and hardcoding a field per asset does not scale past the second
   * one.
   */
  trustlines: Record<string, { balance: string; issuer: string }>
}

interface HorizonBalance {
  balance: string
  asset_type: string
  asset_code?: string
  asset_issuer?: string
}

export const UNFUNDED_ACCOUNT: StellarBalances = {
  xlm: '0',
  usdc: undefined,
  hasUsdcTrustline: false,
  exists: false,
  trustlines: {},
}

export async function fetchStellarBalances(address: string): Promise<StellarBalances> {
  const res = await fetch(`${stellarTestnet.horizonUrl}/accounts/${address}`, {
    headers: { Accept: 'application/json' },
  })

  // A 404 is the normal state for a brand-new keypair, not a failure: Stellar
  // accounts only exist once funded. Surfacing it as an error would show a
  // scary message where "fund me" is the correct prompt.
  if (res.status === 404) return UNFUNDED_ACCOUNT
  if (!res.ok) throw new Error(`Horizon ${res.status}`)

  const data = (await res.json()) as { balances?: HorizonBalance[] }
  const balances = data.balances ?? []

  const native = balances.find((b) => b.asset_type === 'native')
  const usdc = balances.find(
    (b) => b.asset_code === STELLAR_USDC.code && b.asset_issuer === STELLAR_USDC.issuer
  )

  // Every issued asset the account holds, keyed by code. An entry existing is
  // itself the trustline: Stellar has no balance without one.
  const trustlines: Record<string, { balance: string; issuer: string }> = {}
  for (const b of balances) {
    if (b.asset_type === 'native') continue
    if (b.asset_code === undefined || b.asset_issuer === undefined) continue
    // Keyed by code alone, but the issuer is kept so a caller can tell a real
    // asset from one that merely shares its ticker.
    trustlines[b.asset_code] = { balance: b.balance, issuer: b.asset_issuer }
  }

  return {
    xlm: native?.balance ?? '0',
    usdc: usdc?.balance,
    hasUsdcTrustline: usdc !== undefined,
    exists: true,
    trustlines,
  }
}

/** Testnet-only faucet. Funds a new account so it exists on-chain. */
export async function fundWithFriendbot(address: string): Promise<void> {
  const res = await fetch(`${stellarTestnet.friendbotUrl}/?addr=${encodeURIComponent(address)}`)
  if (!res.ok) throw new Error(`Friendbot failed (${res.status})`)
}

/**
 * Whether an account can hold a given asset.
 *
 * Checks the issuer, not just the code. An account holding a token called
 * CETES from an unrelated issuer cannot receive Etherfuse CETES, and treating
 * the two as interchangeable is exactly the confusion the asset registry
 * exists to prevent.
 */
export function hasTrustline(
  balances: StellarBalances | undefined,
  code: string,
  issuer: string | undefined
): boolean {
  // Native XLM needs no trustline; every funded account holds it.
  if (issuer === undefined) return balances?.exists === true
  const line = balances?.trustlines[code]
  return line !== undefined && line.issuer === issuer
}
