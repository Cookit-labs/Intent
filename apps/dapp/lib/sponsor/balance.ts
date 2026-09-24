import { stellarTestnet } from '@intent/config'

/**
 * What the sponsor holds, as Horizon states it.
 *
 * Shared by the health endpoint and the low-balance alert so both agree on
 * what "funded" means: the account exists on the ledger and this is its
 * native balance. An account Horizon has never seen holds nothing, and says
 * so as a balance of zero. A Horizon that cannot answer throws — the callers
 * decide what an unknown balance means to them, and neither should mistake
 * it for an empty one.
 *
 * The public key is the caller's to supply (`sponsorAccount` derives it from
 * the configured secret); nothing here sees a secret.
 */

export interface SponsorBalance {
  /** Whether the account exists on the ledger. */
  funded: boolean
  /** The native balance as Horizon prints it, e.g. '41.5000000'. '0' when unfunded. */
  balanceXlm: string
}

export interface ReadSponsorBalanceOptions {
  horizonUrl?: string
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}

interface HorizonAccount {
  balances?: { asset_type?: string; balance?: string }[]
}

export async function readSponsorBalance(
  account: string,
  options: ReadSponsorBalanceOptions = {}
): Promise<SponsorBalance> {
  const doFetch = options.fetchImpl ?? fetch
  const horizonUrl = options.horizonUrl ?? stellarTestnet.horizonUrl

  const res = await doFetch(`${horizonUrl}/accounts/${account}`, {
    headers: { Accept: 'application/json' },
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  })
  if (res.status === 404) return { funded: false, balanceXlm: '0' }
  if (!res.ok) throw new Error(`Horizon ${res.status}`)

  const body = (await res.json()) as HorizonAccount
  const native = body.balances?.find((b) => b.asset_type === 'native')
  return { funded: true, balanceXlm: native?.balance ?? '0' }
}
