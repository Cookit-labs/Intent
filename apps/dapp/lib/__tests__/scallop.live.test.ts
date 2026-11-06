import { describe, expect, it } from 'vitest'

import { suiClient } from '../chains/sui/client'
import { dryRunChange } from '../chains/sui/lending-calls'
import {
  chainObligations,
  scallopBorrowTransaction,
  scallopPriceTargets,
  SCALLOP_BALANCE_SHEETS,
  SCALLOP_BORROW_DYNAMICS,
  SCALLOP_DECIMALS_REGISTRY,
  SCALLOP_INTEREST_MODELS,
  SCALLOP_MARKET,
  SCALLOP_ORIGINAL_PACKAGE,
  SCALLOP_PACKAGE,
  SCALLOP_PYTH_REGISTRY,
  SCALLOP_PYTH_RULE,
  SCALLOP_RECEIPT_TYPE,
  SCALLOP_RISK_MODELS,
  SCALLOP_UPGRADE_CAP,
  SCALLOP_VERSION,
  SCALLOP_X_ORACLE,
  scallopVenue,
} from '../chains/sui/scallop'
import { SUI_TOKENS } from '../chains/sui/tokens'

/**
 * Real transactions built and dry-run against mainnet, for public addresses whose keys
 * nobody here has. Nothing signs or sends. If a holder moves its funds these fail on
 * balance, so swap it for another that holds USDC receipts.
 */
const SKIP = process.env['SKIP_LIVE'] === '1'
const USDC_HOLDER = '0xc6fa48a7455bff49124318d5297320441cfac33f83ceea890c485372de917df4'
const RECEIPT_HOLDER = '0xbe3fd04e98d2a2603122a3d2f7459e5ecef01768f1dc40cded8203995305203f'
const USDC = SUI_TOKENS.find((t) => t.symbol === 'USDC')?.id ?? ''
/** WAL against a USDC loan, in a position not staked for rewards. */
const BORROWER = '0x7f4d16a5041815049a30265be7b5afa7909166cb15df97c18b97f31f7f116f39'
/** SUI against USDT and USDY, in a position not staked for rewards. */
const ROOMY = '0xcc31ad38af0687632c71b61ccf4277d370d8077ac6aa64ba6e02d40a4c7b98c6'
/** A loan staked for Scallop's borrow rewards, as nearly all are. */
const STAKED_BORROWER = '0xf181e1bfde0068006af48b6b564fa169f482476288a141c71fefbd49ba0c0b54'
const NEVER_USED = '0x0000000000000000000000000000000000000000000000000000000000001234'

describe.skipIf(SKIP)('Scallop against mainnet', () => {
  it('still has the pinned package as its latest, or the allowlist needs a fresh look', async () => {
    const { object } = await suiClient().core.getObject({
      objectId: SCALLOP_UPGRADE_CAP,
      include: { json: true },
    })
    expect((object.json as { package?: string }).package).toBe(SCALLOP_PACKAGE)
  }, 30_000)

  it('still has the pinned market and version objects', async () => {
    const { objects } = await suiClient().core.getObjects({
      objectIds: [SCALLOP_MARKET, SCALLOP_VERSION],
    })
    const [market, version] = objects as unknown as [{ type?: string }, { type?: string }]
    expect(market.type).toBe(`${SCALLOP_ORIGINAL_PACKAGE}::market::Market`)
    expect(version.type).toBe(`${SCALLOP_ORIGINAL_PACKAGE}::version::Version`)
  }, 30_000)

  it('builds a supply with a rate, passes its check and dry-runs clean', async () => {
    const prepared = await scallopVenue.prepare(
      { kind: 'supply', amount: '1', tokenIn: 'USDC' },
      USDC_HOLDER
    )
    expect(prepared.apy?.basePercent).toBeGreaterThan(0)
    expect(Number(prepared.receive?.amount)).toBeGreaterThan(0)
    expect(prepared.notes.join(' ')).toMatch(/\$142K/)
    expect(() => scallopVenue.assertSafe(prepared.signing, USDC_HOLDER)).not.toThrow()
    if (prepared.signing.family !== 'sui') throw new Error('wrong family')
    const minted = await dryRunChange(
      prepared.signing.transaction,
      SCALLOP_RECEIPT_TYPE,
      USDC_HOLDER,
      'Dry run'
    )
    expect(Number(minted)).toBeGreaterThan(0)
  }, 60_000)

  it('builds a withdrawal and pays what was asked', async () => {
    const prepared = await scallopVenue.prepare(
      { kind: 'withdraw', amount: '1', tokenIn: 'USDC' },
      RECEIPT_HOLDER
    )
    expect(() => scallopVenue.assertSafe(prepared.signing, RECEIPT_HOLDER)).not.toThrow()
    if (prepared.signing.family !== 'sui') throw new Error('wrong family')
    const received = await dryRunChange(
      prepared.signing.transaction,
      USDC,
      RECEIPT_HOLDER,
      'Dry run'
    )
    expect(Number(received)).toBeGreaterThanOrEqual(999_900)
  }, 60_000)

  it('refuses a wallet with no receipts', async () => {
    await expect(
      scallopVenue.prepare({ kind: 'withdraw', amount: '1', tokenIn: 'USDC' }, USDC_HOLDER)
    ).rejects.toThrow(/no Scallop USDC receipts/)
  }, 30_000)

  it('still has the pinned oracle objects, and the rule the market fills prices with', async () => {
    const { objects } = await suiClient().core.getObjects({
      objectIds: [SCALLOP_X_ORACLE, SCALLOP_PYTH_REGISTRY, SCALLOP_DECIMALS_REGISTRY],
    })
    const [oracle, registry, decimals] = objects as unknown as [
      { type?: string },
      { type?: string },
      { type?: string },
    ]
    expect(oracle.type).toContain('::x_oracle::XOracle')
    expect(registry.type).toBe(`${SCALLOP_PYTH_RULE}::pyth_registry::PythRegistry`)
    expect(decimals.type).toContain('::coin_decimals_registry::CoinDecimalsRegistry')
  }, 30_000)

  it('still has its table ids on the market object', async () => {
    const { object } = await suiClient().core.getObject({
      objectId: SCALLOP_MARKET,
      include: { json: true },
    })
    const json = object.json as {
      risk_models: { table: { id: string } }
      interest_models: { table: { id: string } }
      borrow_dynamics: { table: { id: string } }
      vault: { balance_sheets: { table: { id: string } } }
    }
    expect(json.risk_models.table.id).toBe(SCALLOP_RISK_MODELS)
    expect(json.interest_models.table.id).toBe(SCALLOP_INTEREST_MODELS)
    expect(json.borrow_dynamics.table.id).toBe(SCALLOP_BORROW_DYNAMICS)
    expect(json.vault.balance_sheets.table.id).toBe(SCALLOP_BALANCE_SHEETS)
  }, 30_000)

  it('reads a position with its loan and its receipts, and none for a wallet with none', async () => {
    const held = (await scallopVenue.positions?.(BORROWER)) ?? []
    expect(held.find((p) => p.slot === 'supplied' && p.symbol === 'WAL')).toBeDefined()
    expect(
      Number(held.find((p) => p.slot === 'borrowed' && p.symbol === 'USDC')?.amount)
    ).toBeGreaterThan(0)

    const receipts = (await scallopVenue.positions?.(RECEIPT_HOLDER)) ?? []
    expect(receipts.find((p) => p.slot === 'supplied' && p.symbol === 'USDC')).toBeDefined()

    expect(await scallopVenue.positions?.(NEVER_USED)).toEqual([])
  }, 30_000)

  it('reads a staked loan too, though it can only be repaid on Scallop', async () => {
    const held = (await scallopVenue.positions?.(STAKED_BORROWER)) ?? []
    expect(held.find((p) => p.slot === 'borrowed')).toBeDefined()
    const owed = held.find((p) => p.slot === 'borrowed')
    await expect(
      scallopVenue.prepare(
        { kind: 'repay', amount: '1', tokenIn: owed?.symbol ?? 'USDC' },
        STAKED_BORROWER
      )
    ).rejects.toThrow(/Repay at scallop\.io/)
  }, 30_000)

  it('prices a position and reaches the borrow check with no key and no price service', async () => {
    // Built directly: this is the only unstaked loan found, and the app stops it for its health.
    // It sits at its limit, so the contract either pays or aborts on that limit (0x501) as the
    // price of WAL moves. Either way the prices were accepted, which is what this is here to show.
    const [position] = await chainObligations(BORROWER)
    if (position === undefined) throw new Error('this wallet no longer has a position')
    const tx = scallopBorrowTransaction(
      BORROWER,
      USDC,
      BigInt(50_000),
      position,
      await scallopPriceTargets(position, [USDC])
    )
    const simulated = await suiClient().core.simulateTransaction({
      transaction: tx,
      checksEnabled: false,
      include: { effects: true, balanceChanges: true },
    })
    if (simulated.$kind === 'Transaction') {
      const paid = simulated.Transaction.balanceChanges.find((c) => c.coinType.endsWith('::USDC'))
      expect(Number(paid?.amount)).toBeGreaterThan(49_000)
      expect(Number(paid?.amount)).toBeLessThanOrEqual(50_000)
    } else {
      const error = simulated.FailedTransaction.effects.status.error
      expect(error?.message).toContain('borrow_internal')
      expect(error?.message).toContain('abort code: 1281')
    }
  }, 60_000)

  it('repays part of a loan, proving the key, and takes exactly what was asked', async () => {
    const prepared = await scallopVenue.prepare(
      { kind: 'repay', amount: '0.5', tokenIn: 'USDC' },
      BORROWER
    )
    expect(() => scallopVenue.assertSafe(prepared.signing, BORROWER)).not.toThrow()
    if (prepared.signing.family !== 'sui') throw new Error('wrong family')
    expect(await dryRunChange(prepared.signing.transaction, USDC, BORROWER, 'Dry run')).toBe(
      BigInt(-500_000)
    )
  }, 60_000)

  it('refuses a whole repay the wallet cannot cover', async () => {
    const owed = ((await scallopVenue.positions?.(BORROWER)) ?? []).find(
      (p) => p.slot === 'borrowed' && p.symbol === 'USDC'
    )
    if (owed === undefined) throw new Error('this wallet no longer owes USDC')
    await expect(
      scallopVenue.prepare(
        { kind: 'repay', amount: owed.amount, tokenIn: 'USDC', wholePosition: true },
        BORROWER
      )
    ).rejects.toThrow(/which is less than the .* you owe/)
  }, 60_000)

  it('stops that same borrow for the room it leaves before liquidation', async () => {
    await expect(
      scallopVenue.prepare({ kind: 'borrow', amount: '0.2', tokenIn: 'USDC' }, BORROWER)
    ).rejects.toThrow(/health factor at|can back about|can't back any more/)
  }, 60_000)

  it('refuses a borrow past what the collateral can back', async () => {
    await expect(
      scallopVenue.prepare({ kind: 'borrow', amount: '100000', tokenIn: 'USDC' }, BORROWER)
    ).rejects.toThrow(/can back about|can't back any more/)
  }, 60_000)

  it('says so when a position holds a coin whose price others do not keep current', async () => {
    await expect(
      scallopVenue.prepare({ kind: 'borrow', amount: '0.01', tokenIn: 'USDT' }, ROOMY)
    ).rejects.toThrow(/prices from the last 30 seconds|health factor at|can back about/)
  }, 60_000)

  it('refuses taking out what a loan depends on, and says so', async () => {
    const held = ((await scallopVenue.positions?.(BORROWER)) ?? []).find(
      (p) => p.slot === 'supplied' && p.symbol === 'WAL'
    )
    if (held === undefined) throw new Error('this wallet no longer supplies WAL')
    await expect(
      scallopVenue.prepare(
        { kind: 'withdraw', amount: held.amount, tokenIn: 'WAL', wholePosition: true },
        BORROWER
      )
    ).rejects.toThrow(/Your loan on Scallop depends on this WAL/)
  }, 60_000)

  it('empties a holding of receipts on a whole withdraw', async () => {
    const held = ((await scallopVenue.positions?.(RECEIPT_HOLDER)) ?? []).find(
      (p) => p.slot === 'supplied' && p.symbol === 'USDC'
    )
    if (held === undefined) throw new Error('this wallet no longer holds receipts')
    const prepared = await scallopVenue.prepare(
      { kind: 'withdraw', amount: held.amount, tokenIn: 'USDC', wholePosition: true },
      RECEIPT_HOLDER
    )
    if (prepared.signing.family !== 'sui') throw new Error('wrong family')
    const receipts = await dryRunChange(
      prepared.signing.transaction,
      SCALLOP_RECEIPT_TYPE,
      RECEIPT_HOLDER,
      'Dry run'
    )
    const { balance } = await suiClient().core.getBalance({
      owner: RECEIPT_HOLDER,
      coinType: SCALLOP_RECEIPT_TYPE,
    })
    expect(receipts).toBe(-BigInt(balance.balance))
  }, 60_000)
})
