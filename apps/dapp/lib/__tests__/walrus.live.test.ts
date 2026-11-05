import { Transaction } from '@mysten/sui/transactions'
import { fromBase64, normalizeSuiAddress } from '@mysten/sui/utils'
import { describe, expect, it } from 'vitest'

import { suiClient } from '../chains/sui/client'
import {
  STAKED_WAL_TYPE,
  WAL_TYPE,
  WALRUS_ORIGINAL_PACKAGE,
  WALRUS_PACKAGE,
  WALRUS_STAKING,
  WALRUS_VERSION,
  walrusVenue,
} from '../chains/sui/walrus'
import { ChainActionRefused } from '../chains/types'

/**
 * Read-only against mainnet: pinned ids, the exact Move signatures, and a real build and dry run of
 * each step for public addresses whose keys nobody here has. Nothing signs or sends. When one of
 * those addresses moves its funds, swap it for another holder.
 */

const SKIP = process.env['SKIP_LIVE'] === '1'
const WAL_HOLDER = '0x61e95e5ebdcee91c1b8aa176fbd88e174428c3473015614972df20840f975947'
const STAKE_HOLDER = '0x054e676c2df14006de28868484740dfa2ac1b04e23f6ce97bc9f04c6a7144ce9'
/** 488 StakedWal objects when checked, 472 live and 16 ready: the most found. */
const MANY_STAKES_HOLDER = '0x9349c99a5431cc9543459a631d841fec8703ddec90cb5b6b8bdcd93dddba7517'
/** 371 finished withdrawals and 101 live stakes when checked. */
const MIXED_HOLDER = '0x1f7ceb9a7b1bfae9b395330b9a826e0372d537257b6779c8fbfc361f486a69e0'
/** 56 finished withdrawals and 1 live stake when checked, with SUI for the fee. */
const CLAIM_HOLDER = '0xd7b39ec3da4c0fdab0a8b800320229f08c8bf69f8305b0eab7bd6128c160a131'
/** 90 withdrawals still running, 13 live stakes and none ready when checked. */
const COOLING_HOLDER = '0xa25245b7c862f0de2baeb0e3dbfade2cca621bfe77b4df91ee6a02b62f34407a'
const TIMEOUT = 60_000

async function dryRunSucceeds(transaction: string): Promise<boolean> {
  const result = await suiClient().core.simulateTransaction({
    transaction: fromBase64(transaction),
    include: { effects: true },
  })
  return result.Transaction?.effects?.status.success === true
}

async function gasOf(transaction: string): Promise<unknown> {
  const result = await suiClient().core.simulateTransaction({
    transaction: fromBase64(transaction),
    include: { effects: true },
  })
  return result.Transaction?.effects?.gasUsed
}

function commandCount(transaction: string): number {
  return Transaction.from(fromBase64(transaction)).getData().commands.length
}

describe.skipIf(SKIP)('Walrus against mainnet', () => {
  const client = suiClient()

  it(
    'the staking object is shared and names the pinned package',
    async () => {
      const { object } = await client.core.getObject({
        objectId: WALRUS_STAKING,
        include: { json: true },
      })
      expect(object.type).toBe(`${WALRUS_ORIGINAL_PACKAGE}::staking::Staking`)
      expect(object.owner.$kind).toBe('Shared')
      expect(object.json).toMatchObject({
        package_id: WALRUS_PACKAGE,
        version: WALRUS_VERSION,
        new_package_id: null,
      })
    },
    TIMEOUT
  )

  it(
    'WAL has the pinned coin type and decimals',
    async () => {
      const { coinMetadata } = await client.core.getCoinMetadata({ coinType: WAL_TYPE })
      expect(coinMetadata).toMatchObject({ symbol: 'WAL', decimals: 9 })
    },
    TIMEOUT
  )

  it.each([
    ['staking', 'stake_with_pool', 4],
    ['staking', 'request_withdraw_stake', 3],
    ['staking', 'withdraw_stake', 3],
    ['staked_wal', 'split', 3],
  ])(
    '%s::%s is public with the parameters it had when checked',
    async (moduleName, name, parameters) => {
      const { function: fn } = await client.core.getMoveFunction({
        packageId: WALRUS_PACKAGE,
        moduleName,
        name,
      })
      expect(fn.visibility).toBe('public')
      expect(fn.parameters).toHaveLength(parameters)
      expect(fn.typeParameters).toHaveLength(0)
    },
    TIMEOUT
  )

  it(
    'a stake builds, dry-runs and passes its own check',
    async () => {
      const prepared = await walrusVenue.prepare(
        { kind: 'stake', amount: '1', tokenIn: 'WAL' },
        WAL_HOLDER
      )
      expect(() => walrusVenue.assertSafe(prepared.signing, WAL_HOLDER)).not.toThrow()
      expect(prepared.signing.family).toBe('sui')
      if (prepared.signing.family !== 'sui') return
      expect(await dryRunSucceeds(prepared.signing.transaction)).toBe(true)
      console.log(prepared.summary, prepared.notes[1])
    },
    TIMEOUT
  )

  it(
    'a started withdrawal builds, dry-runs and passes its own check',
    async () => {
      const prepared = await walrusVenue.prepare(
        { kind: 'unstake', amount: '1', tokenIn: 'WAL' },
        STAKE_HOLDER
      )
      expect(() => walrusVenue.assertSafe(prepared.signing, STAKE_HOLDER)).not.toThrow()
      expect(prepared.signing.family).toBe('sui')
      if (prepared.signing.family !== 'sui') return
      expect(await dryRunSucceeds(prepared.signing.transaction)).toBe(true)
      console.log(prepared.summary)
    },
    TIMEOUT
  )

  it(
    "another account's money is not the holder's to unstake",
    async () => {
      const empty = normalizeSuiAddress('0x1234')
      await expect(
        walrusVenue.prepare({ kind: 'unstake', amount: '1', tokenIn: 'WAL' }, empty)
      ).rejects.toBeInstanceOf(ChainActionRefused)
    },
    TIMEOUT
  )

  it(
    'positions tell staked, ready and waiting apart, from the chain',
    async () => {
      const started = Date.now()
      const mixed = await walrusVenue.positions?.(MIXED_HOLDER)
      console.log('positions took', Date.now() - started, 'ms', JSON.stringify(mixed))
      expect(mixed?.some((p) => p.slot === 'staked' && p.symbol === 'WAL')).toBe(true)
      expect(mixed?.some((p) => p.slot === 'claimable' && p.symbol === 'WAL')).toBe(true)

      const cooling = await walrusVenue.positions?.(COOLING_HOLDER)
      console.log(JSON.stringify(cooling))
      expect(cooling?.some((p) => p.slot === 'cooling' && (p.readyInHours ?? 0) >= 1)).toBe(true)
      expect(await walrusVenue.positions?.(normalizeSuiAddress('0x1234'))).toEqual([])
    },
    TIMEOUT
  )

  it(
    '"claim my WAL" collects several finished withdrawals in one dry run, paying the holder',
    async () => {
      const prepared = await walrusVenue.prepare(
        { kind: 'claim', amount: 'all', tokenIn: 'WAL' },
        CLAIM_HOLDER
      )
      expect(prepared.kind).toBe('claim')
      expect(() => walrusVenue.assertSafe(prepared.signing, CLAIM_HOLDER)).not.toThrow()
      if (prepared.signing.family !== 'sui') throw new Error('wrong family')
      expect(await dryRunSucceeds(prepared.signing.transaction)).toBe(true)
      expect(Number(prepared.receive?.amount)).toBeGreaterThanOrEqual(Number(prepared.pay.amount))
      console.log(prepared.summary, prepared.receive, await gasOf(prepared.signing.transaction))
    },
    TIMEOUT
  )

  it(
    'a claim with nothing ready refuses, saying how long',
    async () => {
      await expect(
        walrusVenue.prepare({ kind: 'claim', amount: 'all', tokenIn: 'WAL' }, COOLING_HOLDER)
      ).rejects.toThrow(/in about \d+ (hours?|days).*Nothing was signed or sent/)
    },
    TIMEOUT
  )

  it(
    '"unstake all" starts every stake of the largest holder found, in one dry run',
    async () => {
      const positions = await walrusVenue.positions?.(MANY_STAKES_HOLDER)
      const staked = positions?.find((p) => p.slot === 'staked')?.amount as string
      const prepared = await walrusVenue.prepare(
        { kind: 'unstake', amount: staked, wholePosition: true, tokenIn: 'WAL' },
        MANY_STAKES_HOLDER
      )
      expect(() => walrusVenue.assertSafe(prepared.signing, MANY_STAKES_HOLDER)).not.toThrow()
      if (prepared.signing.family !== 'sui') throw new Error('wrong family')
      expect(await dryRunSucceeds(prepared.signing.transaction)).toBe(true)
      console.log(
        prepared.summary,
        commandCount(prepared.signing.transaction),
        'commands',
        await gasOf(prepared.signing.transaction),
        Buffer.from(prepared.signing.transaction, 'base64').length,
        'bytes'
      )
    },
    TIMEOUT
  )

  it(
    '"unstake all" collects what is ready and starts the rest, in one dry run',
    async () => {
      const positions = await walrusVenue.positions?.(MIXED_HOLDER)
      const staked = positions?.find((p) => p.slot === 'staked')?.amount as string
      const prepared = await walrusVenue.prepare(
        { kind: 'unstake', amount: staked, wholePosition: true, tokenIn: 'WAL' },
        MIXED_HOLDER
      )
      expect(() => walrusVenue.assertSafe(prepared.signing, MIXED_HOLDER)).not.toThrow()
      if (prepared.signing.family !== 'sui') throw new Error('wrong family')
      expect(await dryRunSucceeds(prepared.signing.transaction)).toBe(true)
      console.log(
        prepared.summary,
        prepared.receive,
        commandCount(prepared.signing.transaction),
        'commands',
        await gasOf(prepared.signing.transaction)
      )
    },
    TIMEOUT
  )

  it(
    "a holder's positions are found by type",
    async () => {
      const { objects } = await client.core.listOwnedObjects({
        owner: STAKE_HOLDER,
        type: STAKED_WAL_TYPE,
        limit: 1,
      })
      expect(objects.length).toBeGreaterThan(0)
    },
    TIMEOUT
  )
})
