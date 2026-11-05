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
const TIMEOUT = 60_000

async function dryRunSucceeds(transaction: string): Promise<boolean> {
  const result = await suiClient().core.simulateTransaction({
    transaction: fromBase64(transaction),
    include: { effects: true },
  })
  return result.Transaction?.effects?.status.success === true
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
