import { describe, expect, it } from 'vitest'

import {
  DEFINDEX_TESTNET_CONTRACTS_URL,
  createContractsRegistry,
  resolveDefindexVault,
} from '../lend/defindex/contracts'

/**
 * Where DeFindex's testnet vaults are looked up.
 *
 * Not hardcoded, on purpose. Testnet resets delete every contract on it (the
 * next is scheduled for 2026-12-16), and DeFindex republishes its addresses
 * in a JSON file after each one. A constant would name a vault that no longer
 * exists and every deposit would fail at simulation with a message about
 * nothing. So the file is read at runtime, cached briefly, and a vault absent
 * from it means "offline" — a quiet absence from the agents' menu, never a
 * crash.
 */

const XLM_VAULT = 'CCLV4H7WTLJQ7ATLHBBQV2WW3OINF3FOY5XZ7VPHZO7NH3D2ZS4GFSF6'
const USDC_VAULT = 'CBMVK2JK6NTOT2O4HNQAIQFJY232BHKGLIMXDVQVHIIZKDACXDFZDWHN'

function contractsJson(ids: Record<string, string>): string {
  return JSON.stringify({ ids, hashes: {} })
}

function serving(body: string, status = 200): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = []
  const fetchImpl = ((url: string) => {
    calls.push(url)
    return Promise.resolve(
      new Response(body, { status, headers: { 'Content-Type': 'application/json' } })
    )
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

describe('resolving a vault from the published registry', () => {
  it('reads the XLM vault from the testnet contracts file', async () => {
    const { fetchImpl, calls } = serving(
      contractsJson({ xlm_paltalabs_vault: XLM_VAULT, usdc_paltalabs_vault: USDC_VAULT })
    )
    const registry = createContractsRegistry({ fetchImpl })

    const vault = await resolveDefindexVault('XLM', { registry })

    expect(vault?.id).toBe(XLM_VAULT)
    expect(vault?.symbol).toBe('XLM')
    expect(calls[0]).toBe(DEFINDEX_TESTNET_CONTRACTS_URL)
  })

  it('is offline, not an error, when the file lists no vault for the asset', async () => {
    // What a testnet reset looks like from here: the file comes back without
    // the entry, and the venue is simply not offered until it is redeployed.
    const { fetchImpl } = serving(contractsJson({ usdc_paltalabs_vault: USDC_VAULT }))

    expect(
      await resolveDefindexVault('XLM', { registry: createContractsRegistry({ fetchImpl }) })
    ).toBeUndefined()
  })

  it('is offline for an asset this app has no vault mapping for', async () => {
    const { fetchImpl } = serving(contractsJson({ xlm_paltalabs_vault: XLM_VAULT }))

    expect(
      await resolveDefindexVault('CETES', { registry: createContractsRegistry({ fetchImpl }) })
    ).toBeUndefined()
  })

  it('refuses an id that is not a contract address', async () => {
    // An account key where a contract id belongs would fail inside the SDK
    // with a message about nothing; refused here, by name.
    const { fetchImpl } = serving(
      contractsJson({
        xlm_paltalabs_vault: 'GCYQ3NXJHGD7P36OVKII6GKVLAENQ6ZETYOBAPZTI4R6ZWUU6QLHVVUX',
      })
    )

    expect(
      await resolveDefindexVault('XLM', { registry: createContractsRegistry({ fetchImpl }) })
    ).toBeUndefined()
  })

  it('throws when the registry cannot be read', async () => {
    const { fetchImpl } = serving('', 502)

    await expect(
      resolveDefindexVault('XLM', { registry: createContractsRegistry({ fetchImpl }) })
    ).rejects.toThrow(/502/)
  })

  it('throws on a file that is not the expected shape', async () => {
    const { fetchImpl } = serving('{"nope":true}')

    await expect(
      resolveDefindexVault('XLM', { registry: createContractsRegistry({ fetchImpl }) })
    ).rejects.toThrow(/ids/)
  })
})

describe('the registry is cached', () => {
  it('fetches once within the TTL', async () => {
    let now = 1_000_000
    const { fetchImpl, calls } = serving(contractsJson({ xlm_paltalabs_vault: XLM_VAULT }))
    const registry = createContractsRegistry({ fetchImpl, now: () => now, ttlMs: 60_000 })

    await registry.read()
    now += 30_000
    await registry.read()

    expect(calls).toHaveLength(1)
  })

  it('fetches again once the TTL has passed', async () => {
    let now = 1_000_000
    const { fetchImpl, calls } = serving(contractsJson({ xlm_paltalabs_vault: XLM_VAULT }))
    const registry = createContractsRegistry({ fetchImpl, now: () => now, ttlMs: 60_000 })

    await registry.read()
    now += 60_001
    await registry.read()

    expect(calls).toHaveLength(2)
  })

  it('does not cache a failure', async () => {
    let status = 500
    const calls: string[] = []
    const fetchImpl = ((url: string) => {
      calls.push(url)
      return Promise.resolve(
        new Response(status === 200 ? contractsJson({ xlm_paltalabs_vault: XLM_VAULT }) : '', {
          status,
        })
      )
    }) as unknown as typeof fetch
    const registry = createContractsRegistry({ fetchImpl })

    await expect(registry.read()).rejects.toThrow()
    status = 200
    await expect(registry.read()).resolves.toBeDefined()
    expect(calls).toHaveLength(2)
  })
})
