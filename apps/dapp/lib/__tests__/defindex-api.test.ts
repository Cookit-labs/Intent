import { describe, expect, it } from 'vitest'

import { DEFINDEX_API_URL, readVault, requestDeposit, sendSigned } from '../lend/defindex/api'

/**
 * The three calls this app makes to DeFindex's API, captured rather than sent.
 *
 * Shapes are taken from the API's own OpenAPI document (`/api-json`, read
 * 2026-09-23) and the `@defindex/sdk` 0.3.0 types, since no key was available
 * to exercise them live: `GET /vault/{address}` carries the vault's 7-day APY
 * as a percentage beside the assets it holds; `POST /vault/{address}/deposit`
 * takes `{ amounts, caller, invest, slippageBps }` and answers with an
 * unsigned envelope in `xdr`; `POST /send` takes the signed envelope and
 * answers `{ txHash, success, ledger, result }`. Every call carries the key as
 * a bearer token and `?network=testnet`.
 */

const VAULT = 'CCLV4H7WTLJQ7ATLHBBQV2WW3OINF3FOY5XZ7VPHZO7NH3D2ZS4GFSF6'
const ME = 'GCYQ3NXJHGD7P36OVKII6GKVLAENQ6ZETYOBAPZTI4R6ZWUU6QLHVVUX'
const XLM_SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'
const KEY = { apiKey: 'sk_test' }

interface Captured {
  url: string
  method: string
  headers: Record<string, string>
  body?: unknown
}

/** Records the request and answers with `reply`. */
function capture(into: Captured[], reply: unknown, status = 200): typeof fetch {
  return ((url: string, init: RequestInit = {}) => {
    into.push({
      url,
      method: init.method ?? 'GET',
      headers: (init.headers as Record<string, string>) ?? {},
      ...(typeof init.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}),
    })
    return Promise.resolve(
      new Response(JSON.stringify(reply), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    )
  }) as unknown as typeof fetch
}

const VAULT_INFO = {
  name: 'DeFindex-Vault-Defindex Vault',
  symbol: 'DFXV',
  assets: [{ address: XLM_SAC, name: 'XLM', symbol: 'XLM', strategies: [] }],
  apy: 19.4,
}

describe('reading a vault', () => {
  it('asks the API for the vault on testnet, with the key as a bearer token', async () => {
    const seen: Captured[] = []
    await readVault(VAULT, { ...KEY, fetchImpl: capture(seen, VAULT_INFO) })

    expect(seen[0]?.url).toBe(`${DEFINDEX_API_URL}/vault/${VAULT}?network=testnet`)
    expect(seen[0]?.method).toBe('GET')
    expect(seen[0]?.headers['Authorization']).toBe('Bearer sk_test')
  })

  it('returns the 7-day APY as a percentage and the assets the vault holds', async () => {
    const info = await readVault(VAULT, { ...KEY, fetchImpl: capture([], VAULT_INFO) })

    expect(info.apy).toBe(19.4)
    expect(info.assets.map((a) => a.address)).toEqual([XLM_SAC])
  })

  it('reports no APY rather than a fake one when the API omits it', async () => {
    // The SDK's own README warns the figure "may be undefined for new vaults".
    // Absent means "not known", which the market context already treats as
    // "do not offer this rate".
    const { apy: _omitted, ...withoutApy } = VAULT_INFO
    const info = await readVault(VAULT, { ...KEY, fetchImpl: capture([], withoutApy) })
    expect(info.apy).toBeUndefined()

    const nonsense = await readVault(VAULT, {
      ...KEY,
      fetchImpl: capture([], { ...VAULT_INFO, apy: 'soon' }),
    })
    expect(nonsense.apy).toBeUndefined()
  })

  it('refuses to call without a key', async () => {
    const seen: Captured[] = []
    await expect(
      readVault(VAULT, { env: {}, fetchImpl: capture(seen, VAULT_INFO) })
    ).rejects.toThrow(/DEFINDEX_API_KEY/)
    expect(seen).toHaveLength(0)
  })

  it('says when the key is refused', async () => {
    // Measured 2026-09-23: every vault route answers 403 without a key.
    await expect(
      readVault(VAULT, {
        ...KEY,
        fetchImpl: capture([], { message: 'Forbidden resource', statusCode: 403 }, 403),
      })
    ).rejects.toThrow(/403/)
  })
})

describe('requesting a deposit', () => {
  it('posts the deposit in the documented shape and returns the envelope', async () => {
    const seen: Captured[] = []
    const xdr = await requestDeposit(
      { vault: VAULT, account: ME, amount: '10000000' },
      { ...KEY, fetchImpl: capture(seen, { xdr: 'AAAA-unsigned', simulationResponse: {} }) }
    )

    expect(xdr).toBe('AAAA-unsigned')
    expect(seen[0]?.url).toBe(`${DEFINDEX_API_URL}/vault/${VAULT}/deposit?network=testnet`)
    expect(seen[0]?.method).toBe('POST')
    expect(seen[0]?.headers['Authorization']).toBe('Bearer sk_test')
    // Amounts are the asset's smallest unit, as JSON numbers; one per asset
    // the vault holds. `invest: true` hands the deposit to the strategy at
    // once rather than leaving it idle. Zero slippage: a single-asset vault
    // takes exactly what is offered, so a lower minimum buys nothing.
    expect(seen[0]?.body).toEqual({
      amounts: [10000000],
      caller: ME,
      invest: true,
      slippageBps: 0,
    })
  })

  it('refuses an amount JSON cannot carry exactly', async () => {
    // The API takes amounts as JSON numbers. Above 2^53 a stroop count is
    // rounded in transit, and a deposit of "about" the balance is not the
    // deposit that was planned.
    const seen: Captured[] = []
    await expect(
      requestDeposit(
        { vault: VAULT, account: ME, amount: '9007199254740993' },
        { ...KEY, fetchImpl: capture(seen, { xdr: 'x' }) }
      )
    ).rejects.toThrow(/exact/)
    expect(seen).toHaveLength(0)
  })

  it('refuses a deposit of nothing', async () => {
    await expect(
      requestDeposit(
        { vault: VAULT, account: ME, amount: '0' },
        { ...KEY, fetchImpl: capture([], { xdr: 'x' }) }
      )
    ).rejects.toThrow(/positive/)
  })

  it('refuses a reply with no transaction in it', async () => {
    // The SDK types `xdr` as `string | null`. Null is the API declining to
    // build, and there is nothing to sign.
    await expect(
      requestDeposit(
        { vault: VAULT, account: ME, amount: '10000000' },
        { ...KEY, fetchImpl: capture([], { xdr: null }) }
      )
    ).rejects.toThrow(/no transaction/)
  })
})

describe('submitting a signed deposit through the relay', () => {
  const SENT = {
    txHash: 'abc123',
    success: true,
    ledger: 42,
    result: { type: 'vault_deposit', sharesMinted: '5996' },
  }

  it('posts the signed envelope to /send', async () => {
    const seen: Captured[] = []
    await sendSigned('SIGNED-XDR', { ...KEY, fetchImpl: capture(seen, SENT) })

    expect(seen[0]?.url).toBe(`${DEFINDEX_API_URL}/send?network=testnet`)
    expect(seen[0]?.method).toBe('POST')
    expect(seen[0]?.body).toEqual({ xdr: 'SIGNED-XDR' })
  })

  it("maps a success to the app's result shape", async () => {
    const result = await sendSigned('SIGNED-XDR', { ...KEY, fetchImpl: capture([], SENT) })

    expect(result).toEqual({ ok: true, hash: 'abc123', ledger: 42, shares: '5996' })
  })

  it('reports a transaction that reached a ledger and failed there', async () => {
    const result = await sendSigned('SIGNED-XDR', {
      ...KEY,
      fetchImpl: capture([], { ...SENT, success: false, result: null }),
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('rejected')
    expect(result.hash).toBe('abc123')
  })

  it('reports a refused submission with the relay’s own reason', async () => {
    const result = await sendSigned('SIGNED-XDR', {
      ...KEY,
      fetchImpl: capture([], { message: 'invalid transaction XDR', statusCode: 400 }, 400),
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('rejected')
    expect(result.detail).toMatch(/invalid transaction XDR/)
    expect(result.hash).toBeUndefined()
  })

  it('reports an unreachable relay as a network error', async () => {
    const down = (() => Promise.reject(new Error('ECONNRESET'))) as unknown as typeof fetch
    const result = await sendSigned('SIGNED-XDR', { ...KEY, fetchImpl: down })

    expect(result).toEqual({ ok: false, reason: 'network_error', detail: 'ECONNRESET' })
  })
})
