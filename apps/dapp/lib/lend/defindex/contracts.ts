import { StrKey } from '@stellar/stellar-sdk'

/**
 * Where DeFindex's testnet vaults are looked up.
 *
 * Not hardcoded, on purpose. Testnet resets delete every contract on it (the
 * next is scheduled for 2026-12-16), and DeFindex republishes its addresses
 * in a JSON file after each one — its own documentation says the testnet
 * addresses "live only in JSON" for that reason. A constant would name a
 * vault that no longer exists, and every deposit would fail at simulation
 * with a message about nothing.
 *
 * So the file is read at runtime and cached briefly. A vault absent from it
 * is "offline": the venue quietly leaves the agents' menu until it is
 * redeployed, which is the honest reading of a reset. Only a file that
 * cannot be read at all is an error, and the callers that matter — the
 * market context, the build route — each turn that into silence or a 502.
 *
 * Verified 2026-09-23: the file carried `xlm_paltalabs_vault` at
 * `CCLV4H7W…` and `usdc_paltalabs_vault` at `CBMVK2JK…`, and both answered
 * `get_assets` on-chain.
 */

export const DEFINDEX_TESTNET_CONTRACTS_URL =
  'https://raw.githubusercontent.com/defindex-io/stellar-contracts/main/public/testnet.contracts.json'

/**
 * Ten minutes. Long enough that a competition's several reads share one
 * fetch; short enough that a redeploy after a reset is picked up without a
 * restart.
 */
export const CONTRACTS_TTL_MS = 10 * 60 * 1000

/**
 * Which entry in the file holds the vault for each asset this app trades.
 *
 * The keys are DeFindex's own naming ("paltalabs" is the team that deployed
 * them). USDC is listed so the mapping is complete, but its vault holds a
 * different USDC from the one this app trades — see `deposit.ts` — so the
 * on-chain asset check refuses it rather than this table pretending it does
 * not exist.
 */
export const VAULT_KEYS: Record<string, string> = {
  XLM: 'xlm_paltalabs_vault',
  USDC: 'usdc_paltalabs_vault',
}

export interface DefindexContracts {
  /** Contract ids by DeFindex's own key. */
  ids: Record<string, string>
  fetchedAt: number
}

export interface ContractsRegistryOptions {
  fetchImpl?: typeof fetch
  ttlMs?: number
  /** Injected in tests, so the TTL is checkable without waiting. */
  now?: () => number
  url?: string
}

export interface ContractsRegistry {
  read: () => Promise<DefindexContracts>
}

/**
 * A cached reader of the contracts file.
 *
 * A factory rather than module state, so tests can build one around an
 * injected `fetch` and clock. The module-level `contractsRegistry` below is
 * the one production code shares.
 */
export function createContractsRegistry(options: ContractsRegistryOptions = {}): ContractsRegistry {
  const fetchImpl = options.fetchImpl ?? fetch
  const ttlMs = options.ttlMs ?? CONTRACTS_TTL_MS
  const now = options.now ?? Date.now
  const url = options.url ?? DEFINDEX_TESTNET_CONTRACTS_URL

  let cached: DefindexContracts | undefined
  // Concurrent readers — a competition reads this from several places at
  // once — share one request rather than each starting their own.
  let inFlight: Promise<DefindexContracts> | undefined

  async function load(): Promise<DefindexContracts> {
    const res = await fetchImpl(url, { headers: { Accept: 'application/json' } })
    if (!res.ok) throw new Error(`DeFindex contract registry ${res.status}`)

    const body = (await res.json()) as { ids?: unknown }
    if (
      body === null ||
      typeof body !== 'object' ||
      typeof body.ids !== 'object' ||
      body.ids === null
    ) {
      throw new Error('DeFindex contract registry has no "ids" table')
    }

    const ids: Record<string, string> = {}
    for (const [key, value] of Object.entries(body.ids as Record<string, unknown>)) {
      if (typeof value === 'string') ids[key] = value
    }
    return { ids, fetchedAt: now() }
  }

  return {
    read: () => {
      if (cached !== undefined && now() - cached.fetchedAt <= ttlMs) return Promise.resolve(cached)
      if (inFlight !== undefined) return inFlight

      inFlight = load()
        .then((contracts) => {
          cached = contracts
          return contracts
        })
        .finally(() => {
          // A failure is not cached: the next read tries again.
          inFlight = undefined
        })
      return inFlight
    },
  }
}

export const contractsRegistry: ContractsRegistry = createContractsRegistry()

export interface DefindexVault {
  /** The vault contract id. */
  id: string
  /** The asset this app would deposit, by ticker. */
  symbol: string
  /** DeFindex's key for it in the contracts file. */
  key: string
}

/**
 * The vault for an asset, or nothing when the venue is offline for it.
 *
 * Nothing rather than an error for every reason short of the file being
 * unreadable: an asset this app maps to no vault, a vault missing from the
 * file after a reset, or an entry that is not a contract id at all. Each of
 * those means "not offered", and none of them should stop a competition.
 */
export async function resolveDefindexVault(
  symbol: string,
  options: { registry?: ContractsRegistry } = {}
): Promise<DefindexVault | undefined> {
  const key = VAULT_KEYS[symbol]
  if (key === undefined) return undefined

  const { ids } = await (options.registry ?? contractsRegistry).read()
  const id = ids[key]
  if (id === undefined || !StrKey.isValidContract(id)) return undefined

  return { id, symbol, key }
}
