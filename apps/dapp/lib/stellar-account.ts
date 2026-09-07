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

  return {
    xlm: native?.balance ?? '0',
    usdc: usdc?.balance,
    hasUsdcTrustline: usdc !== undefined,
    exists: true,
  }
}

/** Testnet-only faucet. Funds a new account so it exists on-chain. */
export async function fundWithFriendbot(address: string): Promise<void> {
  const res = await fetch(`${stellarTestnet.friendbotUrl}/?addr=${encodeURIComponent(address)}`)
  if (!res.ok) throw new Error(`Friendbot failed (${res.status})`)
}
