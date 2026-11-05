import { describe, expect, it } from 'vitest'

import { associatedTokenAccount } from '../chains/solana/assert-safe'
import { createJitoVenue, JITO_STAKE_POOL, JITOSOL_MINT } from '../chains/solana/jito'
import { jitoListing } from '../chains/solana/jito-listing'
import {
  computeBudget,
  decodeStakePool,
  readU64,
  STAKE_POOL_PROGRAM,
} from '../chains/solana/stake-pool'
import { decodeSolanaTransaction } from '../chains/solana/assert-safe'
import type { PreparedAction } from '../chains/types'
import {
  budget,
  encodeStakePool,
  fakeRpc,
  ME,
  payload,
  rebuilt,
  SOMEONE_ELSE,
  transferOf,
  UNKNOWN_PROGRAM,
  unlimitedApproval,
  withAccount,
  withExtraData,
  withOtherFunction,
  type PoolFixture,
} from './solana-stake-fixtures'

const RESERVE = 'BgKUXdS29YcHCFrPm5M8oLHiTzZaMDjsebggjoaQ6KFL'
const EPOCH = 1077

const BASE: PoolFixture = {
  poolMint: JITOSOL_MINT,
  reserveStake: RESERVE,
  managerFeeAccount: '8yoigZfzZ1nNaadumY9uPVD118225UYHTDpmjpr2nrSa',
  validatorList: '3R3nGZpQs2aZo5FDQvd2MUQ6R7KhAPainds6uT6uE2mn',
  totalLamports: BigInt('10351794116510279'),
  poolTokenSupply: BigInt('7903028498840376'),
  lastUpdateEpoch: BigInt(EPOCH),
  solWithdrawalFee: [BigInt(1), BigInt(1000)],
}

function venueWith(
  overrides: Partial<PoolFixture> = {},
  reserveLamports = BigInt('40298249972443')
) {
  const rpc = fakeRpc({
    epoch: EPOCH,
    accounts: {
      [JITO_STAKE_POOL]: {
        owner: STAKE_POOL_PROGRAM,
        lamports: BigInt(1),
        data: encodeStakePool({ ...BASE, ...overrides }),
      },
      [RESERVE]: {
        owner: 'Stake11111111111111111111111111111111111111',
        lamports: reserveLamports,
        data: new Uint8Array(0),
      },
    },
  })
  return { venue: createJitoVenue({ rpc }), rpc }
}

const stake = { kind: 'stake', amount: '1', tokenIn: 'SOL' } as const
const unstake = { kind: 'unstake', amount: '1', tokenIn: 'JitoSOL' } as const

async function preparedStake(): Promise<PreparedAction> {
  return venueWith().venue.prepare(stake, ME)
}

async function preparedUnstake(): Promise<PreparedAction> {
  return venueWith().venue.prepare(unstake, ME)
}

function refuses(action: () => unknown, pattern: RegExp): void {
  expect(action).toThrow(pattern)
}

describe('jito stake', () => {
  it('reads the amount out from the pool, with no rate invented', async () => {
    const prepared = await preparedStake()
    // 1 SOL * supply / total, at the figures above.
    expect(prepared.receive).toEqual({
      amount: '0.763445293',
      symbol: 'JitoSOL',
      approximate: true,
    })
    expect(prepared.apy).toBeUndefined()
    expect(prepared.pay).toEqual({ amount: '1', symbol: 'SOL' })
    expect(prepared.notes.join(' ')).toMatch(/not showing a yearly rate/)
  })

  it('binds the deposit to the amount, a floor within 1%, and the person', async () => {
    const prepared = await preparedStake()
    if (prepared.signing.family !== 'solana') throw new Error('Expected Solana.')
    const decoded = decodeSolanaTransaction(prepared.signing.transaction)
    expect(decoded.feePayer).toBe(ME)
    expect(decoded.signerCount).toBe(1)
    expect(decoded.feePayerSignature).toBeNull()
    const deposit = decoded.instructions.at(-1)!
    expect(decoded.staticAccounts[deposit.programIndex]).toBe(STAKE_POOL_PROGRAM)
    expect(deposit.data[0]).toBe(25)
    expect(readU64(deposit.data, 1)).toBe(BigInt('1000000000'))
    const floor = readU64(deposit.data, 9)
    expect(floor).toBeGreaterThanOrEqual((BigInt('763445293') * BigInt(99)) / BigInt(100))
    expect(floor).toBeLessThan(BigInt('763445293'))
    const own = associatedTokenAccount(ME, JITOSOL_MINT)
    expect(decoded.staticAccounts[deposit.accounts[3]!]).toBe(ME)
    expect(decoded.staticAccounts[deposit.accounts[4]!]).toBe(own)
    expect(decoded.staticAccounts[deposit.accounts[6]!]).toBe(own)
  })

  it('passes its own check, and a quote builds nothing', async () => {
    const { venue, rpc } = venueWith()
    const prepared = await venue.prepare(stake, ME)
    expect(() => venue.assertSafe(prepared.signing, ME)).not.toThrow()

    const quoting = venueWith()
    await expect(quoting.venue.quote?.(stake, ME)).resolves.toEqual({
      receive: { amount: '0.763445293', symbol: 'JitoSOL' },
    })
    expect(quoting.rpc.calls).not.toContain('getLatestBlockhash')
    expect(rpc.calls).toContain('getLatestBlockhash')
  })

  it('refuses another token, an account that is no address, and a request it does not do', async () => {
    const { venue } = venueWith()
    await expect(venue.prepare({ ...stake, tokenIn: 'USDC' }, ME)).rejects.toThrow(/takes SOL/)
    await expect(venue.prepare(stake, 'not-an-address')).rejects.toThrow(/not a Solana wallet/)
    await expect(venue.prepare({ ...stake, kind: 'supply' }, ME)).rejects.toThrow(
      /stake and unstake/
    )
    await expect(venue.prepare({ ...stake, amount: '0' }, ME)).rejects.toThrow(/more than zero/)
  })

  it('refuses a pool that wants another signature, is behind the epoch, or has another mint', async () => {
    await expect(
      venueWith({ solDepositAuthority: SOMEONE_ELSE }).venue.prepare(stake, ME)
    ).rejects.toThrow(/another signature/)
    await expect(
      venueWith({ lastUpdateEpoch: BigInt(EPOCH - 1) }).venue.prepare(stake, ME)
    ).rejects.toThrow(/still updating/)
    await expect(
      venueWith({ poolMint: 'So11111111111111111111111111111111111111112' }).venue.prepare(
        stake,
        ME
      )
    ).rejects.toThrow(/doesn’t look as expected/)
  })

  it('takes only SOL after a swap', async () => {
    const { venue } = venueWith()
    await expect(
      venue.assertCanFollow?.({ kind: 'stake', tokenIn: 'SOL' }, ME)
    ).resolves.toBeUndefined()
    await expect(venue.assertCanFollow?.({ kind: 'stake', tokenIn: 'USDC' }, ME)).rejects.toThrow()
  })
})

describe('jito unstake', () => {
  it('pays the person from the reserve, after the fee read on chain', async () => {
    const prepared = await preparedUnstake()
    // 0.999 JitoSOL burned at total / supply: the fee rounds up, in the pool's favour.
    expect(prepared.receive).toEqual({ amount: '1.308541696', symbol: 'SOL', approximate: true })
    expect(prepared.pay).toEqual({ amount: '1', symbol: 'JitoSOL' })
    expect(prepared.notes.join(' ')).toMatch(/0\.1%/)
    if (prepared.signing.family !== 'solana') throw new Error('Expected Solana.')
    const decoded = decodeSolanaTransaction(prepared.signing.transaction)
    const withdraw = decoded.instructions.at(-1)!
    expect(withdraw.data[0]).toBe(26)
    expect(readU64(withdraw.data, 1)).toBe(BigInt('1000000000'))
    expect(decoded.staticAccounts[withdraw.accounts[5]!]).toBe(ME)
  })

  it('refuses when the reserve is too thin, and says what else can be done', async () => {
    await expect(venueWith({}, BigInt(1_000_000_000)).venue.prepare(unstake, ME)).rejects.toThrow(
      /swap JitoSOL for SOL on Jupiter/
    )
  })

  it('refuses an unstake named in SOL rather than JitoSOL', async () => {
    await expect(venueWith().venue.prepare({ ...unstake, tokenIn: 'SOL' }, ME)).rejects.toThrow(
      /takes JitoSOL/
    )
  })

  it('refuses a pool that wants another signature to withdraw', async () => {
    await expect(
      venueWith({ solWithdrawAuthority: SOMEONE_ELSE }).venue.prepare(unstake, ME)
    ).rejects.toThrow(/another signature/)
  })
})

describe('jito unstake of everything', () => {
  it('burns exactly the balance read, so nothing is left behind, and pays only the person', async () => {
    const prepared = await venueWith().venue.prepare(
      { ...unstake, amount: '151.268371658', wholePosition: true },
      ME
    )
    if (prepared.signing.family !== 'solana') throw new Error('Expected Solana.')
    const decoded = decodeSolanaTransaction(prepared.signing.transaction)
    const burn = decoded.instructions.at(-1)!
    expect(readU64(burn.data, 1)).toBe(BigInt('151268371658'))
    expect(decoded.staticAccounts[burn.accounts[5]!]).toBe(ME)
    expect(() => venueWith().venue.assertSafe(prepared.signing, ME)).not.toThrow()
  })
})

describe('jito assertSafe', () => {
  const venue = venueWith().venue

  it('refuses the wrong signer', async () => {
    const prepared = await preparedStake()
    refuses(() => venue.assertSafe(prepared.signing, SOMEONE_ELSE), /network fee/)
    refuses(() => venue.assertSafe({ family: 'sui', transaction: 'AA==' }, ME), /not a Solana/)
  })

  it('refuses a transaction someone else pays for or must also sign', async () => {
    const prepared = await preparedStake()
    const rest = rebuilt(prepared, ME)
    refuses(() => venue.assertSafe(payload(SOMEONE_ELSE, rest), ME), /network fee/)
  })

  it('refuses an unknown program', async () => {
    const prepared = await preparedStake()
    const rest = rebuilt(prepared, ME)
    const last = rest.at(-1)!
    refuses(
      () =>
        venue.assertSafe(
          payload(ME, [
            ...rest.slice(0, -1),
            { ...last, programAddress: UNKNOWN_PROGRAM as never },
          ]),
          ME
        ),
      /should not need/
    )
    refuses(
      () =>
        venue.assertSafe(
          payload(ME, [...rest, { ...last, programAddress: UNKNOWN_PROGRAM as never }]),
          ME
        ),
      /should not need/
    )
  })

  it('refuses an unknown function of a known program', async () => {
    const prepared = await preparedStake()
    const rest = rebuilt(prepared, ME)
    refuses(
      () =>
        venue.assertSafe(payload(ME, [...rest.slice(0, -1), withOtherFunction(rest.at(-1)!)]), ME),
      /didn’t expect/
    )
  })

  it('refuses extra calldata', async () => {
    const prepared = await preparedStake()
    const rest = rebuilt(prepared, ME)
    refuses(
      () => venue.assertSafe(payload(ME, [...rest.slice(0, -1), withExtraData(rest.at(-1)!)]), ME),
      /didn’t expect/
    )
  })

  it('refuses minted tokens going to someone else, on either token account', async () => {
    const prepared = await preparedStake()
    const rest = rebuilt(prepared, ME)
    const theirs = associatedTokenAccount(SOMEONE_ELSE, JITOSOL_MINT)
    for (const position of [4, 6]) {
      refuses(
        () =>
          venue.assertSafe(
            payload(ME, [...rest.slice(0, -1), withAccount(rest.at(-1)!, position, theirs)]),
            ME
          ),
        /isn’t what Jito should get/
      )
    }
  })

  it('refuses unstaked SOL going to someone else', async () => {
    const prepared = await preparedUnstake()
    const rest = rebuilt(prepared, ME)
    refuses(
      () =>
        venue.assertSafe(
          payload(ME, [...rest.slice(0, -1), withAccount(rest.at(-1)!, 5, SOMEONE_ELSE)]),
          ME
        ),
      /isn’t what Jito should get/
    )
  })

  it('refuses a SOL transfer added to the transaction', async () => {
    const prepared = await preparedStake()
    refuses(
      () =>
        venue.assertSafe(
          payload(ME, [...rebuilt(prepared, ME), transferOf(ME, SOMEONE_ELSE, BigInt(1))]),
          ME
        ),
      /SOL transfer/
    )
  })

  it('refuses an approval, even of the person’s own token', async () => {
    const prepared = await preparedUnstake()
    refuses(
      () =>
        venue.assertSafe(
          payload(ME, [
            ...rebuilt(prepared, ME),
            unlimitedApproval(associatedTokenAccount(ME, JITOSOL_MINT), SOMEONE_ELSE, ME),
          ]),
          ME
        ),
      /moves or approves tokens/
    )
  })

  it('refuses the wrong token and the wrong pool', async () => {
    const prepared = await preparedStake()
    const rest = rebuilt(prepared, ME)
    const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
    refuses(
      () =>
        venue.assertSafe(
          payload(ME, [...rest.slice(0, -1), withAccount(rest.at(-1)!, 7, usdc)]),
          ME
        ),
      /isn’t what Jito should get/
    )
    refuses(
      () =>
        venue.assertSafe(
          payload(ME, [
            ...rest.slice(0, -1),
            withAccount(rest.at(-1)!, 0, 'po1osKDWYF9oiVEGmzKA4eTs8eMveFRMox3bUKazGN2'),
          ]),
          ME
        ),
      /isn’t what Jito should get/
    )
  })

  it('refuses a floor of zero, which would leave no price protection', async () => {
    const prepared = await preparedStake()
    const rest = rebuilt(prepared, ME)
    const last = rest.at(-1)!
    const data = Uint8Array.from(last.data ?? [])
    data.fill(0, 9)
    refuses(
      () => venue.assertSafe(payload(ME, [...rest.slice(0, -1), { ...last, data }]), ME),
      /isn’t what Jito should get/
    )
  })

  it('refuses a huge priority fee and a missing budget', async () => {
    const prepared = await preparedStake()
    const rest = rebuilt(prepared, ME).slice(2)
    refuses(() => venue.assertSafe(payload(ME, rest), ME), /compute budget/)
    const price = new Uint8Array(9)
    price[0] = 3
    price.fill(255, 1)
    refuses(
      () =>
        venue.assertSafe(
          payload(ME, [
            computeBudget(200_000)[0]!,
            { programAddress: budget[1]!.programAddress, data: price },
            ...rest,
          ]),
          ME
        ),
      /priority fee/
    )
  })

  it('refuses unreadable bytes', () => {
    refuses(
      () => venue.assertSafe({ family: 'solana', transaction: '%%%' }, ME),
      /could not be read/
    )
  })
})

describe('jito pins and listing', () => {
  it('decodes the pool layout it encodes, reading fees apart', () => {
    const state = decodeStakePool(encodeStakePool(BASE))
    expect(state?.poolMint).toBe(JITOSOL_MINT)
    expect(state?.solWithdrawalFee).toEqual({ numerator: BigInt(1), denominator: BigInt(1000) })
    expect(state?.epochFee).toEqual({ numerator: BigInt(4), denominator: BigInt(100) })
    expect(decodeStakePool(Uint8Array.of(2))).toBeUndefined()
  })

  it('lists as executing on Solana', () => {
    expect(jitoListing).toMatchObject({ id: 'jito', family: 'solana', integration: 'executes' })
    expect(jitoListing.capability).toMatch(/No yearly rate/)
  })
})
