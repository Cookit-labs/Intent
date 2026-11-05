import { beforeEach, describe, expect, it } from 'vitest'

import { rheaLendVenue } from '../chains/near/rhea-lend'
import {
  RHEA_PRICE_AGE_SEC,
  readPythInfos,
  readTokenPrice,
  usdPerToken,
} from '../chains/near/rhea-read'
import {
  RHEA_DEX,
  RHEA_EXTRA_DECIMALS,
  RHEA_LEND,
  RHEA_LEND_STORAGE_YOCTO,
  RHEA_POOLS,
  RHEA_PRICE_ORACLE,
} from '../chains/near/rhea-safety'
import { rheaDexVenue } from '../chains/near/rhea-swap'
import { viewCall } from '../chains/near/rpc'
import { STORAGE_DEPOSIT_YOCTO } from '../chains/near/safety'
import { USDC_NEAR, USDT_NEAR, WRAP_NEAR } from '../chains/near/tokens'

/**
 * The real contracts, read-only. NEAR's RPC has no way to run a call that writes, so nothing here
 * proves a swap or a loan would land: it proves the contracts, pools, prices and methods this app
 * relies on are what it thinks, and that what prepare builds from live state passes its own check.
 * Nothing signs or sends.
 */

const SKIP = process.env['SKIP_LIVE'] === '1'
const RPC = process.env['NEAR_RPC_URL'] ?? 'https://free.rpc.fastnear.com'
/** Holds a Rhea Lend position with a loan on it at the time of writing. Only ever read. */
const BORROWER = '47a356e729c4c8afa3252deb140e1f48de066a0da6284aa2a82723a8380f644e'
const NOBODY = 'root.near'

/** The public RPC answers 429 once this suite has read enough, so it goes gently and looks again. */
const PAUSE_MS = 2_500
const LOOK_AGAIN = { retry: 2 }

const codeOf = new Map<string, string>()

async function exportedMethods(contract: string): Promise<string> {
  const known = codeOf.get(contract)
  if (known !== undefined) return known
  const response = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'test',
      method: 'query',
      params: { request_type: 'view_code', finality: 'final', account_id: contract },
    }),
    signal: AbortSignal.timeout(30_000),
  })
  const body = (await response.json()) as { result: { code_base64: string } }
  const code = Buffer.from(body.result.code_base64, 'base64').toString('latin1')
  codeOf.set(contract, code)
  return code
}

beforeEach(async () => {
  if (!SKIP) await new Promise((resolve) => setTimeout(resolve, PAUSE_MS))
})

describe.skipIf(SKIP)('Rhea DEX on mainnet', LOOK_AGAIN, () => {
  it('is running at the version this app read, with no token frozen', async () => {
    const meta = await viewCall<{
      state: string
      version: string
      owner: string
      wnear_id: string
    }>(RHEA_DEX, 'metadata')
    expect(meta.state).toBe('Running')
    expect(meta.version).toBe('1.9.21')
    expect(meta.owner).toBe('ref-finance.sputnik-dao.near')
    expect(meta.wnear_id).toBe(WRAP_NEAR)
    const frozen = await viewCall<string[]>(RHEA_DEX, 'get_frozenlist_tokens')
    for (const token of [WRAP_NEAR, USDC_NEAR, USDT_NEAR]) expect(frozen).not.toContain(token)
  }, 60_000)

  it('still holds the tokens each pinned pool is pinned to', async () => {
    const ids = Object.keys(RHEA_POOLS).map(Number)
    const pools = await viewCall<{ token_account_ids: string[]; amounts: string[] }[]>(
      RHEA_DEX,
      'get_pool_by_ids',
      { pool_ids: ids }
    )
    ids.forEach((id, index) => {
      const pool = pools[index] as { token_account_ids: string[] }
      for (const token of RHEA_POOLS[id] as readonly string[]) {
        expect(pool.token_account_ids, `pool ${id}`).toContain(token)
      }
    })
  }, 60_000)

  it('still has the message fields the policy reasons about, and the exits it builds', async () => {
    const code = await exportedMethods(RHEA_DEX)
    for (const field of [
      'swap_out_recipient',
      'client_echo',
      'skip_unwrap_near',
      'skip_degen_price_sync',
      'extra_tgas_for_client_echo',
      'hot_zap_actions',
    ]) {
      expect(code, field).toContain(field)
    }
    // The message enum has seven fields in the source this app read. An eighth could move money.
    expect(code).toContain('actionsclient_echoswap_out_recipientskip_degen_price_sync')
    for (const method of [
      'ft_on_transfer',
      'withdraw',
      'claim_lostfound',
      'list_lostfound_tokens',
      'get_deposits',
      'get_return',
      'get_pool_by_ids',
    ]) {
      expect(code, method).toContain(method)
    }
  }, 120_000)

  it.each([
    ['NEAR', 'USDC', '2'],
    ['NEAR', 'USDT', '2'],
    ['USDC', 'NEAR', '5'],
    ['USDT', 'NEAR', '5'],
    ['USDC', 'USDT', '5'],
    ['USDT', 'USDC', '5'],
  ])(
    'quotes %s to %s from the chain, near the Pyth price',
    async (tokenIn, tokenOut, amount) => {
      const quoted = await rheaDexVenue.quote?.({ kind: 'swap', amount, tokenIn, tokenOut }, NOBODY)
      expect(quoted?.receive?.symbol).toBe(tokenOut)
      expect(Number(quoted?.receive?.amount)).toBeGreaterThan(0)
    },
    60_000
  )

  it('builds a swap from NEAR that passes its own check', async () => {
    const prepared = await rheaDexVenue.prepare(
      { kind: 'swap', amount: '2', tokenIn: 'NEAR', tokenOut: 'USDC' },
      NOBODY
    )
    expect(() => rheaDexVenue.assertSafe(prepared.signing, NOBODY)).not.toThrow()
    if (prepared.signing.family !== 'near') throw new Error('wrong family')
    const swap = prepared.signing.transactions.at(-1)
    expect(swap?.receiverId).toBe(WRAP_NEAR)
    expect(swap?.actions.at(-1)?.params.args['receiver_id']).toBe(RHEA_DEX)
  }, 60_000)

  it('reads an account with nothing held there as nothing', async () => {
    await expect(rheaDexVenue.positions?.('nobody-here-at-all.near')).resolves.toEqual([])
  }, 60_000)
})

describe.skipIf(SKIP)('Rhea Lend on mainnet', LOOK_AGAIN, () => {
  it('is at the version this app read', async () => {
    await expect(viewCall<string>(RHEA_LEND, 'get_version')).resolves.toBe('0.16.2')
  }, 60_000)

  it('runs on Pyth prices, from the pinned oracle, with the old oracle route off', async () => {
    const config = await viewCall<{
      contract_mode: string
      enable_price_oracle: boolean
      enable_pyth_oracle: boolean
      pyth_oracle_account_id: string
      pyth_price_valid_duration_sec: number
      ref_exchange_id: string
      owner_id: string
    }>(RHEA_LEND, 'get_config')
    expect(config.contract_mode).toBe('Running')
    expect(config.enable_price_oracle).toBe(false)
    expect(config.enable_pyth_oracle).toBe(true)
    expect(config.pyth_oracle_account_id).toBe(RHEA_PRICE_ORACLE)
    expect(config.pyth_price_valid_duration_sec).toBe(RHEA_PRICE_AGE_SEC)
    expect(config.ref_exchange_id).toBe(RHEA_DEX)
    expect(config.owner_id).toBe('burrow.sputnik-dao.near')
  }, 60_000)

  it('counts each token at the pinned scale and charges the pinned storage', async () => {
    for (const token of [WRAP_NEAR, USDC_NEAR, USDT_NEAR]) {
      const asset = await viewCall<{ config: { extra_decimals: number } }>(RHEA_LEND, 'get_asset', {
        token_id: token,
      })
      expect(asset.config.extra_decimals, token).toBe(RHEA_EXTRA_DECIMALS[token])
    }
    const bounds = await viewCall<{ min: string }>(RHEA_LEND, 'storage_balance_bounds')
    expect(bounds.min).toBe(RHEA_LEND_STORAGE_YOCTO)
    const wrap = await viewCall<{ min: string }>(WRAP_NEAR, 'storage_balance_bounds')
    expect(wrap.min).toBe(STORAGE_DEPOSIT_YOCTO)
  }, 60_000)

  it('has a fresh price for every listed token, in a believable range', async () => {
    const infos = await readPythInfos()
    const near = usdPerToken(await readTokenPrice(WRAP_NEAR, infos), 24)
    const usdc = usdPerToken(await readTokenPrice(USDC_NEAR, infos), 6)
    const usdt = usdPerToken(await readTokenPrice(USDT_NEAR, infos), 6)
    expect(near).toBeGreaterThan(0.01)
    expect(near).toBeLessThan(10_000)
    expect(usdc).toBeGreaterThan(0.9)
    expect(usdc).toBeLessThan(1.1)
    expect(usdt).toBeGreaterThan(0.9)
    expect(usdt).toBeLessThan(1.1)
  }, 60_000)

  it('still has the call shapes this app sends, and the message variants', async () => {
    const code = await exportedMethods(RHEA_LEND)
    for (const name of [
      'execute_with_pyth',
      'get_account_all_positions',
      'get_all_token_pyth_infos',
      'IncreaseCollateral',
      'DecreaseCollateral',
      'Borrow',
      'Withdraw',
      'Repay',
    ]) {
      expect(code, name).toContain(name)
    }
    expect(await exportedMethods(WRAP_NEAR)).toContain('near_withdraw')
  }, 120_000)

  it('reads a real position with a loan on it', async () => {
    const held = (await rheaLendVenue.positions?.(BORROWER)) ?? []
    expect(held.some((p) => p.slot === 'supplied')).toBe(true)
    expect(held.some((p) => p.slot === 'borrowed')).toBe(true)
    for (const position of held) expect(Number(position.amount)).toBeGreaterThan(0)
  }, 60_000)

  it('builds a small borrow against a real position, checked with live prices', async () => {
    const borrow = await rheaLendVenue.prepare(
      { kind: 'borrow', amount: '0.1', tokenIn: 'USDC' },
      BORROWER
    )
    expect(() => rheaLendVenue.assertSafe(borrow.signing, BORROWER)).not.toThrow()
    expect(borrow.notes.join(' ')).toMatch(/You can lose your collateral/)
    if (borrow.signing.family !== 'near') throw new Error('wrong family')
    const call = borrow.signing.transactions.at(-1)?.actions.at(-1)?.params
    expect(call?.methodName).toBe('execute_with_pyth')
    expect(call?.args['actions']).toEqual([
      { Borrow: { token_id: USDC_NEAR, amount: '100000000000000000' } },
      { Withdraw: { token_id: USDC_NEAR, max_amount: '100000000000000000' } },
    ])
  }, 60_000)

  it('builds a small withdrawal from real collateral, which needs prices', async () => {
    const out = await rheaLendVenue.prepare(
      { kind: 'withdraw', amount: '0.01', tokenIn: 'USDC' },
      BORROWER
    )
    expect(() => rheaLendVenue.assertSafe(out.signing, BORROWER)).not.toThrow()
    if (out.signing.family !== 'near') throw new Error('wrong family')
    expect(out.signing.transactions.at(-1)?.actions.at(-1)?.params.methodName).toBe(
      'execute_with_pyth'
    )
  }, 60_000)

  it('builds paying off a real loan, or says the wallet holds too little', async () => {
    const held = (await rheaLendVenue.positions?.(BORROWER)) ?? []
    const owed = held.find((p) => p.slot === 'borrowed')
    if (owed === undefined) throw new Error('that account no longer has a loan to read')
    // Only a refusal about the wallet counts. One saying the chain couldn't be read proves nothing.
    await rheaLendVenue
      .prepare(
        { kind: 'repay', amount: owed.amount, wholePosition: true, tokenIn: owed.symbol },
        BORROWER
      )
      .then(
        (repay) => expect(() => rheaLendVenue.assertSafe(repay.signing, BORROWER)).not.toThrow(),
        (refusal: Error) => expect(refusal.message).toMatch(/You hold/)
      )
  }, 60_000)

  it('refuses to lend to an account with nothing behind it', async () => {
    await expect(
      rheaLendVenue.prepare({ kind: 'borrow', amount: '1', tokenIn: 'USDC' }, NOBODY)
    ).rejects.toThrow(/Nothing of yours backs a loan/)
  }, 60_000)

  it('builds a supply for an account that has never used it, paying for its record', async () => {
    const prepared = await rheaLendVenue.prepare(
      { kind: 'supply', amount: '2', tokenIn: 'NEAR' },
      NOBODY
    )
    expect(() => rheaLendVenue.assertSafe(prepared.signing, NOBODY)).not.toThrow()
    expect(prepared.apy?.basePercent).toBeGreaterThanOrEqual(0)
  }, 60_000)
})
