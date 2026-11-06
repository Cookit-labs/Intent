import { bcs } from '@mysten/sui/bcs'
import { deriveDynamicFieldID, fromBase64, normalizeSuiAddress } from '@mysten/sui/utils'
import { describe, expect, it } from 'vitest'

import {
  AFSUI_TYPE,
  AFTERMATH_PACKAGE,
  AFTERMATH_REFERRAL_VAULT,
  AFTERMATH_SAFE,
  AFTERMATH_VALIDATOR,
  AFTERMATH_VAULT,
  AFTERMATH_VAULT_STATE,
  aftermathVenue,
} from '../chains/sui/aftermath'
import { suiClient } from '../chains/sui/client'
import { readU64 } from '../chains/sui/haedal'
import { toBaseUnits } from '../chains/types'

/**
 * Pinned ids, and real unsigned transactions against mainnet, read-only. Nothing here signs or
 * sends: each transaction is only built and dry-run, for public addresses whose keys nobody here
 * has. When an address empties these fail on balance, so swap it for another funded one.
 */

const SKIP = process.env['SKIP_LIVE'] === '1'
const SUI_HOLDER = '0xc6fa48a7455bff49124318d5297320441cfac33f83ceea890c485372de917df4'
const AFSUI_HOLDER = '0xd491566f3add78e8fbc3328590c4d967a91f55dcdd4f84e58f76e08f8bd458eb'

async function simulateOk(transaction: string): Promise<boolean> {
  const result = await suiClient().core.simulateTransaction({
    transaction: fromBase64(transaction),
    include: { effects: true },
  })
  return result.Transaction?.effects?.status.success === true
}

describe.skipIf(SKIP)('Aftermath against mainnet', () => {
  it('stakes to a validator that takes no fee: what it mints is what the rate gives', async () => {
    const prepared = await aftermathVenue.prepare(
      { kind: 'stake', amount: '1', tokenIn: 'SUI' },
      SUI_HOLDER
    )
    if (prepared.signing.family !== 'sui') throw new Error('wrong family')
    expect(() => aftermathVenue.assertSafe(prepared.signing, SUI_HOLDER)).not.toThrow()
    expect(await simulateOk(prepared.signing.transaction)).toBe(true)

    const byRate = await readU64(
      SUI_HOLDER,
      `${AFTERMATH_PACKAGE}::staked_sui_vault::sui_to_afsui`,
      (tx) => [
        tx.object(AFTERMATH_VAULT),
        tx.object(AFTERMATH_SAFE),
        tx.pure.u64(BigInt(1_000_000_000)),
      ]
    )
    expect(prepared.receive?.symbol).toBe('afSUI')
    expect(Math.abs(Number(prepared.receive?.amount) - Number(byRate) / 1e9)).toBeLessThan(0.00001)
  }, 60_000)

  it('builds a delayed unstake that passes its check and dry-runs clean', async () => {
    const prepared = await aftermathVenue.prepare(
      { kind: 'unstake', amount: '2', tokenIn: 'afSUI' },
      AFSUI_HOLDER
    )
    if (prepared.signing.family !== 'sui') throw new Error('wrong family')
    expect(() => aftermathVenue.assertSafe(prepared.signing, AFSUI_HOLDER)).not.toThrow()
    expect(await simulateOk(prepared.signing.transaction)).toBe(true)
    expect(prepared.receive?.symbol).toBe('SUI')
    expect(Number(prepared.receive?.amount)).toBeGreaterThan(2)
    expect(prepared.notes.join(' ')).toMatch(/in about \d+ hours?/)
  }, 60_000)

  it('reads afSUI in the wallet to the last unit, and "all" of it dry-runs clean', async () => {
    const positions = await aftermathVenue.positions?.(AFSUI_HOLDER)
    console.log(JSON.stringify(positions))
    const staked = positions?.find((p) => p.slot === 'staked')
    expect(staked?.symbol).toBe('afSUI')

    const { balance } = await suiClient().core.getBalance({
      owner: AFSUI_HOLDER,
      coinType: AFSUI_TYPE,
    })
    expect(toBaseUnits(staked?.amount as string, 9)).toBe(balance.balance)

    const prepared = await aftermathVenue.prepare(
      {
        kind: 'unstake',
        amount: staked?.amount as string,
        wholePosition: true,
        tokenIn: 'afSUI',
      },
      AFSUI_HOLDER
    )
    if (prepared.signing.family !== 'sui') throw new Error('wrong family')
    expect(() => aftermathVenue.assertSafe(prepared.signing, AFSUI_HOLDER)).not.toThrow()
    expect(await simulateOk(prepared.signing.transaction)).toBe(true)
  }, 60_000)

  it('finds nothing for an empty wallet, and reads the real waiting list without error', async () => {
    expect(await aftermathVenue.positions?.(normalizeSuiAddress('0x1234'))).toEqual([])
  }, 30_000)

  /**
   * The evidence that the wait ends by itself: this delayed unstake was requested by 0x131b16cb on
   * 28 Oct 2026, and its payout landed in a transaction sent by someone else, Aftermath's crank.
   */
  it('a real delayed payout was sent by someone other than the person paid', async () => {
    const requester = '0x131b16cb8064cdc58665f7821aeee17d018011c0c176b669b93eb39496967d7c'
    const { Transaction: payout } = await suiClient().core.getTransaction({
      digest: 'FBktHVRjJWKKZfNGAYaqyg7d9AnU23vZ3Y6o6a38fao3',
      include: { balanceChanges: true, transaction: true },
    })
    expect(payout?.transaction?.sender).not.toBe(requester)
    const paid = payout?.balanceChanges?.find(
      (c) => c.address === requester && c.coinType.endsWith('::sui::SUI')
    )
    expect(BigInt(paid?.amount ?? '0') > BigInt(0)).toBe(true)
  }, 30_000)

  it('the waiting list sits where the contract put a real request', () => {
    // Created at key 0 by the request in transaction 8Fc1GZa4EVASV9uEgTpWKKkQ62RRKLn2p3BVYbSJsDPw.
    expect(
      deriveDynamicFieldID(
        '0xac7ab1a584cf8e19b633d1c868b914080275ea87853eb716a949c778b75f00d9',
        'u64',
        bcs.u64().serialize(0).toBytes()
      )
    ).toBe('0x421de7c0d9405782fe95ff04911ffd1678ca82f84d75c54fc8bdc5eda19d10da')
  })

  it("still matches Aftermath's published addresses, or the ids need a fresh look", async () => {
    const response = await fetch('https://aftermath.finance/api/addresses')
    const { staking } = (await response.json()) as {
      staking: { packages: Record<string, string>; objects: Record<string, string> }
    }
    expect(staking.packages['lsd']).toBe(AFTERMATH_PACKAGE)
    expect(staking.objects['stakedSuiVault']).toBe(AFTERMATH_VAULT)
    expect(staking.objects['safe']).toBe(AFTERMATH_SAFE)
    expect(staking.objects['referralVault']).toBe(AFTERMATH_REFERRAL_VAULT)
    expect(staking.objects['stakedSuiVaultState']).toBe(AFTERMATH_VAULT_STATE)
    expect(staking.objects['aftermathValidator']).toBe(AFTERMATH_VALIDATOR)
    expect(AFSUI_TYPE.startsWith(`${staking.packages['afsui']}::`)).toBe(true)
    const { coinMetadata } = await suiClient().core.getCoinMetadata({ coinType: AFSUI_TYPE })
    expect(coinMetadata?.decimals).toBe(9)
    const { objects } = await suiClient().core.getObjects({ objectIds: [AFTERMATH_SAFE] })
    const safe = objects[0]
    if (safe === undefined || safe instanceof Error) throw new Error('no safe')
    expect(safe.type).toContain(AFSUI_TYPE)
  }, 30_000)
})
