import { Transaction } from '@mysten/sui/transactions'
import { normalizeStructTag } from '@mysten/sui/utils'
import { describe, expect, it } from 'vitest'

import { suiClient } from '../chains/sui/client'
import { dryRunChange } from '../chains/sui/lending-calls'
import {
  SUILEND_MARKET,
  SUILEND_ORIGINAL_PACKAGE,
  SUILEND_PACKAGE,
  SUILEND_RESERVES,
  SUILEND_UPGRADE_CAP,
  SUILEND_USDC_RESERVE,
  suilendVenue,
} from '../chains/sui/suilend'
import { SUI_TOKENS } from '../chains/sui/tokens'

/**
 * Real transactions built and dry-run against mainnet, for public addresses whose keys
 * nobody here has. Nothing signs or sends. If a holder moves its funds these fail on
 * balance, so swap it for another with a loan-free USDC position.
 */
const SKIP = process.env['SKIP_LIVE'] === '1'
const USDC_HOLDER = '0xc6fa48a7455bff49124318d5297320441cfac33f83ceea890c485372de917df4'
const SUPPLIER = '0xd22978af0d4d404067dc611d1f63af9883b5a1786e24813290ccb2d8407b1b66'
/** Owes a little USDT against USDC. */
const USDT_BORROWER = '0xc258e9fa7acc5a9b76d5dfe8d5ea545741e974e6e3903a283abea66b00baffe4'
/** Owes USDC against plenty of SUI and WAL, with room to borrow more. */
const SUI_COLLATERAL = '0xec949c3c3a681242803edbdf42e421c4d9313adb619f357ab45e14c0749087d3'
/** Owes USDC, and holds about 30 USDC in the wallet. */
const USDC_BORROWER = '0x221f431046771ee0fc7be2ddbfe963f023578f27fa0d61168e5162de42d676ea'
/** Owes SUI against other assets, and holds a little SUI. */
const SUI_BORROWER = '0x525a570bdd47d407d70a070dd915d550ae1a9069d84de08e718f5495e86715c8'
/** Owes about 567 USDC, and holds enough USDC to clear it. */
const USDC_CLEARABLE = '0x9d8627f5dfcea21129b182f04b9cfb3fa474572f6cd09b7534755952af6454c2'
const USDC = SUI_TOKENS.find((t) => t.symbol === 'USDC')?.id ?? ''
const SUI = '0x2::sui::SUI'

describe.skipIf(SKIP)('Suilend against mainnet', () => {
  it('still has the pinned package as its latest, or the allowlist needs a fresh look', async () => {
    const { object } = await suiClient().core.getObject({
      objectId: SUILEND_UPGRADE_CAP,
      include: { json: true },
    })
    expect((object.json as { package?: string }).package).toBe(SUILEND_PACKAGE)
  }, 30_000)

  it('still has USDC at the pinned reserve of the pinned market, at version 7', async () => {
    const { object } = await suiClient().core.getObject({
      objectId: SUILEND_MARKET,
      include: { json: true },
    })
    expect(object.type).toContain(`${SUILEND_ORIGINAL_PACKAGE}::lending_market::LendingMarket<`)
    const json = object.json as { version: string; reserves: { coin_type: string }[] }
    expect(json.version).toBe('7')
    expect(USDC).toContain(json.reserves[SUILEND_USDC_RESERVE]?.coin_type)
  }, 30_000)

  it('builds a first supply with a rate, passes its check and dry-runs clean', async () => {
    const prepared = await suilendVenue.prepare(
      { kind: 'supply', amount: '1', tokenIn: 'USDC' },
      USDC_HOLDER
    )
    expect(prepared.apy?.basePercent).toBeGreaterThan(0)
    expect(prepared.apy?.rewardPercent).toBeUndefined()
    expect(() => suilendVenue.assertSafe(prepared.signing, USDC_HOLDER)).not.toThrow()
    if (prepared.signing.family !== 'sui') throw new Error('wrong family')
    expect(Transaction.from(prepared.signing.transaction).getData().sender).toBe(USDC_HOLDER)
    expect(await dryRunChange(prepared.signing.transaction, USDC, USDC_HOLDER, 'Dry run')).toBe(
      BigInt(-1_000_000)
    )
  }, 60_000)

  it('builds a withdrawal with no price update and no server, and pays what was asked', async () => {
    const prepared = await suilendVenue.prepare(
      { kind: 'withdraw', amount: '1', tokenIn: 'USDC' },
      SUPPLIER
    )
    expect(() => suilendVenue.assertSafe(prepared.signing, SUPPLIER)).not.toThrow()
    if (prepared.signing.family !== 'sui') throw new Error('wrong family')
    const received = await dryRunChange(prepared.signing.transaction, USDC, SUPPLIER, 'Dry run')
    expect(Number(received)).toBeGreaterThanOrEqual(999_900)
  }, 60_000)

  it('refuses a wallet with no position', async () => {
    await expect(
      suilendVenue.prepare({ kind: 'withdraw', amount: '1', tokenIn: 'USDC' }, USDC_HOLDER)
    ).rejects.toThrow(/no USDC in Suilend/)
  }, 30_000)

  it('has every listed token at its pinned reserve', async () => {
    const { object } = await suiClient().core.getObject({
      objectId: SUILEND_MARKET,
      include: { json: true },
    })
    const { reserves } = object.json as { reserves: { coin_type: string }[] }
    for (const [symbol, index] of Object.entries(SUILEND_RESERVES)) {
      const type = SUI_TOKENS.find((t) => t.symbol === symbol)?.id ?? ''
      expect(normalizeStructTag(`0x${reserves[index]?.coin_type ?? ''}`)).toBe(
        normalizeStructTag(type)
      )
    }
  }, 30_000)

  it('reads positions from the chain, and none for a wallet that has none', async () => {
    const held = (await suilendVenue.positions?.(USDT_BORROWER)) ?? []
    expect(held.find((p) => p.slot === 'supplied' && p.symbol === 'USDC')).toBeDefined()
    expect(held.find((p) => p.slot === 'borrowed' && p.symbol === 'USDT')).toBeDefined()
    expect(await suilendVenue.positions?.(USDC_HOLDER)).toEqual([])
  }, 30_000)

  it('builds a borrow with no key and no price service, and pays what was asked', async () => {
    const prepared = await suilendVenue.prepare(
      { kind: 'borrow', amount: '0.5', tokenIn: 'USDC' },
      SUI_COLLATERAL
    )
    expect(() => suilendVenue.assertSafe(prepared.signing, SUI_COLLATERAL)).not.toThrow()
    if (prepared.signing.family !== 'sui') throw new Error('wrong family')
    expect(await dryRunChange(prepared.signing.transaction, USDC, SUI_COLLATERAL, 'Dry run')).toBe(
      BigInt(500_000)
    )
    expect(prepared.notes.join(' ')).toMatch(/can be liquidated/)
  }, 60_000)

  it('refuses a borrow past what the collateral can back', async () => {
    await expect(
      suilendVenue.prepare({ kind: 'borrow', amount: '100000000', tokenIn: 'USDC' }, SUI_COLLATERAL)
    ).rejects.toThrow(/can back about|can't back any more|free to borrow/)
  }, 60_000)

  it('refuses a borrow of what the position holds as collateral', async () => {
    await expect(
      suilendVenue.prepare({ kind: 'borrow', amount: '1', tokenIn: 'SUI' }, SUI_COLLATERAL)
    ).rejects.toThrow(/won't lend SUI against a position that holds SUI/)
  }, 60_000)

  it('repays part of a loan, taking exactly what was asked', async () => {
    const prepared = await suilendVenue.prepare(
      { kind: 'repay', amount: '0.01', tokenIn: 'USDC' },
      USDC_BORROWER
    )
    expect(() => suilendVenue.assertSafe(prepared.signing, USDC_BORROWER)).not.toThrow()
    if (prepared.signing.family !== 'sui') throw new Error('wrong family')
    expect(await dryRunChange(prepared.signing.transaction, USDC, USDC_BORROWER, 'Dry run')).toBe(
      BigInt(-10_000)
    )
  }, 60_000)

  it('clears a whole loan, interest included, and keeps the extra it offered', async () => {
    const owed = ((await suilendVenue.positions?.(USDC_CLEARABLE)) ?? []).find(
      (p) => p.slot === 'borrowed' && p.symbol === 'USDC'
    )
    if (owed === undefined) throw new Error('this wallet no longer owes USDC')
    const prepared = await suilendVenue.prepare(
      { kind: 'repay', amount: owed.amount, tokenIn: 'USDC', wholePosition: true },
      USDC_CLEARABLE
    )
    if (prepared.signing.family !== 'sui') throw new Error('wrong family')
    const paid = await dryRunChange(prepared.signing.transaction, USDC, USDC_CLEARABLE, 'Dry run')
    expect(Math.abs(Number(paid) + Math.round(Number(owed.amount) * 1e6))).toBeLessThanOrEqual(3)
  }, 60_000)

  it('takes out collateral a loan can spare, with fresh prices', async () => {
    const prepared = await suilendVenue.prepare(
      { kind: 'withdraw', amount: '0.01', tokenIn: 'SUI' },
      SUI_COLLATERAL
    )
    expect(() => suilendVenue.assertSafe(prepared.signing, SUI_COLLATERAL)).not.toThrow()
    expect(prepared.notes.join(' ')).toMatch(/backs your loan/)
  }, 60_000)

  it('brings SUI back from staking to pay it out, and takes a SUI repay', async () => {
    const out = await suilendVenue.prepare(
      { kind: 'withdraw', amount: '0.01', tokenIn: 'SUI' },
      SUI_COLLATERAL
    )
    if (out.signing.family !== 'sui') throw new Error('wrong family')
    expect(await dryRunChange(out.signing.transaction, SUI, SUI_COLLATERAL, 'Dry run')).toBe(
      BigInt(10_000_000)
    )
    const repay = await suilendVenue.prepare(
      { kind: 'repay', amount: '0.01', tokenIn: 'SUI' },
      SUI_BORROWER
    )
    expect(() => suilendVenue.assertSafe(repay.signing, SUI_BORROWER)).not.toThrow()
    if (repay.signing.family !== 'sui') throw new Error('wrong family')
    expect(await dryRunChange(repay.signing.transaction, SUI, SUI_BORROWER, 'Dry run')).toBe(
      BigInt(-10_000_000)
    )
  }, 60_000)

  it('refuses taking out what a loan depends on, and says so', async () => {
    const held = ((await suilendVenue.positions?.(SUI_COLLATERAL)) ?? []).find(
      (p) => p.slot === 'supplied' && p.symbol === 'SUI'
    )
    if (held === undefined) throw new Error('this wallet no longer supplies SUI')
    await expect(
      suilendVenue.prepare(
        { kind: 'withdraw', amount: held.amount, tokenIn: 'SUI', wholePosition: true },
        SUI_COLLATERAL
      )
    ).rejects.toThrow(/Your loan on Suilend depends on this SUI/)
  }, 60_000)

  it('empties a position on a whole withdraw', async () => {
    const held = ((await suilendVenue.positions?.(SUPPLIER)) ?? []).find(
      (p) => p.slot === 'supplied' && p.symbol === 'USDC'
    )
    if (held === undefined) throw new Error('this wallet no longer supplies USDC')
    const prepared = await suilendVenue.prepare(
      { kind: 'withdraw', amount: held.amount, tokenIn: 'USDC', wholePosition: true },
      SUPPLIER
    )
    if (prepared.signing.family !== 'sui') throw new Error('wrong family')
    const received = await dryRunChange(prepared.signing.transaction, USDC, SUPPLIER, 'Dry run')
    expect(Number(received)).toBeGreaterThanOrEqual(Number(held.amount) * 1e6 * 0.9999)
  }, 60_000)
})
