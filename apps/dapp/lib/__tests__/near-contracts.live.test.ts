import { describe, expect, it } from 'vitest'

import { viewCall, waitForTransaction } from '../chains/near/rpc'
import { METAPOOL_STAKE_GAS, RNEAR_STAKE_GAS, STORAGE_DEPOSIT_YOCTO } from '../chains/near/safety'
import { metapoolVenue, rnearVenue } from '../chains/near/stake'
import {
  METAPOOL_CONTRACT,
  nearTokens,
  RNEAR_CONTRACT,
  USDC_NEAR,
  USDT_NEAR,
  WRAP_NEAR,
} from '../chains/near/tokens'
import type { NearFunctionCall } from '../chains/types'

/**
 * The real contracts, read-only: RPC view calls and a read of each contract's code.
 * Nothing signs or sends. Preparing a stake only reads and builds JSON, so it runs
 * here too, and what it builds is never given to a wallet.
 */

const SKIP = process.env['SKIP_LIVE'] === '1'
const ME = 'root.near'
const RPC = process.env['NEAR_RPC_URL'] ?? 'https://free.rpc.fastnear.com'

async function rpc<T>(method: string, params: unknown): Promise<T> {
  const response = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'test', method, params }),
    signal: AbortSignal.timeout(30_000),
  })
  const body = (await response.json()) as { result: T }
  return body.result
}

/** Exported function names, read from the contract's own wasm. */
async function exportedMethods(contract: string): Promise<string[]> {
  const { code_base64: code } = await rpc<{ code_base64: string }>('query', {
    request_type: 'view_code',
    finality: 'final',
    account_id: contract,
  })
  const bytes = Buffer.from(code, 'base64')
  let at = 8
  const leb = (): number => {
    let value = 0
    let shift = 0
    let byte: number
    do {
      byte = bytes[at] as number
      at += 1
      value |= (byte & 0x7f) << shift
      shift += 7
    } while (byte & 0x80)
    return value >>> 0
  }
  while (at < bytes.length) {
    const section = bytes[at] as number
    at += 1
    const length = leb()
    const end = at + length
    if (section === 7) {
      const names: string[] = []
      const count = leb()
      for (let i = 0; i < count; i += 1) {
        const size = leb()
        names.push(bytes.subarray(at, at + size).toString())
        at += size + 1
        leb()
      }
      return names
    }
    at = end
  }
  return []
}

describe.skipIf(SKIP)('the allowlisted contracts', () => {
  it('report the decimals this app assumes', async () => {
    for (const token of nearTokens) {
      const meta = await viewCall<{ decimals: number }>(token.id, 'ft_metadata')
      expect(meta.decimals, token.symbol).toBe(token.decimals)
    }
  }, 60_000)

  it('charge exactly the storage amount the safety check allows', async () => {
    for (const contract of [WRAP_NEAR, USDC_NEAR, USDT_NEAR, RNEAR_CONTRACT]) {
      const bounds = await viewCall<{ min: string }>(contract, 'storage_balance_bounds')
      expect(bounds.min, contract).toBe(STORAGE_DEPOSIT_YOCTO)
    }
  }, 60_000)

  it('export every method the safety check allows', async () => {
    const expected: Record<string, string[]> = {
      [WRAP_NEAR]: ['near_deposit', 'ft_transfer', 'storage_deposit', 'storage_balance_of'],
      [USDC_NEAR]: ['ft_transfer', 'storage_deposit', 'storage_balance_of'],
      [USDT_NEAR]: ['ft_transfer', 'storage_deposit', 'storage_balance_of'],
      [RNEAR_CONTRACT]: ['deposit_and_stake', 'storage_deposit', 'ft_price', 'is_paused'],
      [METAPOOL_CONTRACT]: ['deposit_and_stake', 'get_st_near_price', 'get_contract_params'],
    }
    for (const [contract, methods] of Object.entries(expected)) {
      const exported = await exportedMethods(contract)
      for (const method of methods) expect(exported, `${contract} ${method}`).toContain(method)
    }
  }, 120_000)
})

describe.skipIf(SKIP)('stake venues against the live contracts', () => {
  it('prepares rNEAR, and the payload passes its own check', async () => {
    const prepared = await rnearVenue.prepare({ kind: 'stake', amount: '2', tokenIn: 'NEAR' }, ME)
    expect(() => rnearVenue.assertSafe(prepared.signing, ME)).not.toThrow()
    if (prepared.signing.family !== 'near') throw new Error('wrong family')
    const [tx] = prepared.signing.transactions
    expect(tx?.receiverId).toBe('lst.rhealab.near')
    expect((tx?.actions.at(-1) as NearFunctionCall | undefined)?.params.gas).toBe(
      RNEAR_STAKE_GAS.toString()
    )
    expect(Number(prepared.receive?.amount)).toBeGreaterThan(1)
    expect(Number(prepared.receive?.amount)).toBeLessThan(2)
    expect(prepared.apy?.basePercent).toBeGreaterThan(0)
  }, 60_000)

  it('prepares Meta Pool, and the payload passes its own check', async () => {
    const prepared = await metapoolVenue.prepare(
      { kind: 'stake', amount: '2', tokenIn: 'NEAR' },
      ME
    )
    expect(() => metapoolVenue.assertSafe(prepared.signing, ME)).not.toThrow()
    if (prepared.signing.family !== 'near') throw new Error('wrong family')
    const [tx] = prepared.signing.transactions
    expect(tx?.receiverId).toBe('meta-pool.near')
    expect(tx?.actions).toHaveLength(1)
    expect((tx?.actions[0] as NearFunctionCall | undefined)?.params.gas).toBe(
      METAPOOL_STAKE_GAS.toString()
    )
    expect(Number(prepared.receive?.amount)).toBeGreaterThan(1)
    expect(Number(prepared.receive?.amount)).toBeLessThan(2)
  }, 60_000)

  it("matches the figures in Meta Pool's notes and minimum", async () => {
    const params = await viewCall<{
      min_deposit_amount: string
      nslp_min_discount_basis_points: number
      nslp_max_discount_basis_points: number
    }>(METAPOOL_CONTRACT, 'get_contract_params')
    expect(params.min_deposit_amount).toBe('1000000000000000000000000')
    expect(params.nslp_min_discount_basis_points).toBe(30)
    expect(params.nslp_max_discount_basis_points).toBe(500)
    await expect(
      metapoolVenue.prepare({ kind: 'stake', amount: '0.5', tokenIn: 'NEAR' }, ME)
    ).rejects.toThrow(/at least 1 NEAR/)
  }, 60_000)
})

describe.skipIf(SKIP)('reading a transaction', () => {
  it('reads a real recent transaction from the tx method', async () => {
    const block = await rpc<{ chunks: { chunk_hash: string }[] }>('block', { finality: 'final' })
    let found: { hash: string; signer_id: string } | undefined
    for (const chunk of block.chunks) {
      const body = await rpc<{ transactions: { hash: string; signer_id: string }[] }>('chunk', {
        chunk_id: chunk.chunk_hash,
      })
      found = body.transactions[0]
      if (found !== undefined) break
    }
    if (found === undefined) throw new Error('no transaction in the latest block')

    const outcome = await waitForTransaction(found.hash, found.signer_id, 20_000)
    expect(['success', 'failed']).toContain(outcome.state)
  }, 90_000)

  it('gives up within its bound on a hash nobody sent', async () => {
    const startedAt = Date.now()
    const outcome = await waitForTransaction('11111111111111111111111111111111', ME, 3_000)
    expect(outcome.state).toBe('unknown')
    expect(Date.now() - startedAt).toBeLessThan(15_000)
  }, 30_000)
})
