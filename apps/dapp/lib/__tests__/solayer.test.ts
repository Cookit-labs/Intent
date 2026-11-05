import { describe, expect, it } from 'vitest'

import { associatedTokenAccount, decodeSolanaTransaction } from '../chains/solana/assert-safe'
import {
  chooseValidator,
  createSolayerVenue,
  SOLAYER_LP_MINT,
  SOLAYER_RESTAKING_POOL,
  SOLAYER_RESTAKING_PROGRAM,
  SOLAYER_STAKE_POOL,
  SOLAYER_TOKENS,
  SSOL_MINT,
} from '../chains/solana/solayer'
import { solayerListing } from '../chains/solana/solayer-listing'
import {
  addressWithSeed,
  createStakeAccountWithSeed,
  decodeValidatorList,
  readU64,
  STAKE_POOL_PROGRAM,
  STAKE_PROGRAM,
} from '../chains/solana/stake-pool'
import type { PreparedAction } from '../chains/types'
import {
  addressBytes,
  encodeStakePool,
  fakeRpc,
  ME,
  payload,
  rebuilt,
  SOMEONE_ELSE,
  transferOf,
  u32Bytes,
  u64Bytes,
  UNKNOWN_PROGRAM,
  unlimitedApproval,
  withAccount,
  withExtraData,
  withOtherFunction,
  type PoolFixture,
} from './solana-stake-fixtures'

const EPOCH = 1077
const LIST = 'nk5E1Gc2rCuU2MDTRqdcQdiMfV9KnZ6JHykA1cTJQ56'
const BIG_VOTE = 'SLaYv7tCwetrFGbPCRnqpHswG5qqKino78EYpbGF7xY'
const SMALL_VOTE = 'CatzoSMUkTRidT5DwBxAC2pEtnwMBTpkCepHkFgZDiqb'
/** Hro3G6fA... is the stake account a live withdrawal used for that validator on 4 November 2026. */
const BIG_VALIDATOR_STAKE = 'Hro3G6fALTcz85Qwke3BKZEtK6UzhMYrqXMoUxPMoXz'

const BASE: PoolFixture = {
  poolMint: SOLAYER_LP_MINT,
  reserveStake: 'Brh9rB6npnjM1vDXyCXtzkXVGRnsh6KHqmBz26tVACg9',
  managerFeeAccount: 'ARs3HTD79nsaUdDKqfGhgbNMVJkXVdRs2EpHAm4LNEcq',
  validatorList: LIST,
  totalLamports: BigInt('82390512858986'),
  poolTokenSupply: BigInt('69899353088216'),
  lastUpdateEpoch: BigInt(EPOCH),
  stakeWithdrawalFee: [BigInt(8), BigInt(10000)],
}

function validatorEntry(vote: string, active: bigint, status = 0): number[] {
  return [
    ...u64Bytes(active),
    ...u64Bytes(BigInt(0)),
    ...u64Bytes(BigInt(EPOCH)),
    ...u64Bytes(BigInt(0)),
    ...u32Bytes(0),
    ...u32Bytes(0),
    status,
    ...addressBytes(vote),
  ]
}

function encodeList(entries: number[][]): Uint8Array {
  return Uint8Array.from([2, ...u32Bytes(100), ...u32Bytes(entries.length), ...entries.flat()])
}

const LIST_BYTES = encodeList([
  validatorEntry(SMALL_VOTE, BigInt('1009574703')),
  validatorEntry(BIG_VOTE, BigInt('82389651605762')),
])

function venueWith(
  overrides: Partial<PoolFixture> = {},
  options: { restakingOwner?: string; list?: Uint8Array } = {}
) {
  const rpc = fakeRpc({
    epoch: EPOCH,
    accounts: {
      [SOLAYER_STAKE_POOL]: {
        owner: STAKE_POOL_PROGRAM,
        lamports: BigInt(1),
        data: encodeStakePool({ ...BASE, ...overrides }),
      },
      [SOLAYER_RESTAKING_POOL]: {
        owner: options.restakingOwner ?? SOLAYER_RESTAKING_PROGRAM,
        lamports: BigInt(1),
        data: new Uint8Array(74),
      },
      [LIST]: { owner: STAKE_POOL_PROGRAM, lamports: BigInt(1), data: options.list ?? LIST_BYTES },
    },
  })
  return { venue: createSolayerVenue({ rpc, now: () => 1793830450018 }), rpc }
}

const stake = { kind: 'stake', amount: '1', tokenIn: 'SOL' } as const
const unstake = { kind: 'unstake', amount: '1', tokenIn: 'sSOL' } as const

const preparedStake = (): Promise<PreparedAction> => venueWith().venue.prepare(stake, ME)
const preparedUnstake = (): Promise<PreparedAction> => venueWith().venue.prepare(unstake, ME)

function refuses(action: () => unknown, pattern: RegExp): void {
  expect(action).toThrow(pattern)
}

describe('solayer stake', () => {
  it('reads the amount from the pool and shows no rate', async () => {
    const prepared = await preparedStake()
    expect(prepared.receive?.symbol).toBe('sSOL')
    expect(Number(prepared.receive?.amount)).toBeCloseTo(0.84839, 4)
    expect(prepared.apy).toBeUndefined()
    const notes = prepared.notes.join(' ')
    expect(notes).toMatch(/not showing a yearly rate/)
    expect(notes).toMatch(/3-of-5/)
    expect(notes).toMatch(/\$520\.67M/)
    expect(notes).toMatch(/about 82,390 SOL/)
    expect(notes).toMatch(/Leaving is slow/)
    expect(notes).toMatch(/at least 1 SOL worth of sSOL at once/)
  })

  it('restakes exactly the floor it asks the deposit for, with only the person signing', async () => {
    const prepared = await preparedStake()
    if (prepared.signing.family !== 'solana') throw new Error('Expected Solana.')
    const decoded = decodeSolanaTransaction(prepared.signing.transaction)
    expect(decoded.signerCount).toBe(1)
    expect(decoded.feePayer).toBe(ME)
    const [deposit, restake] = decoded.instructions.slice(-2)
    expect(decoded.staticAccounts[deposit!.programIndex]).toBe(STAKE_POOL_PROGRAM)
    expect(readU64(deposit!.data, 1)).toBe(BigInt('1000000000'))
    expect(decoded.staticAccounts[restake!.programIndex]).toBe(SOLAYER_RESTAKING_PROGRAM)
    expect(readU64(restake!.data, 8)).toBe(readU64(deposit!.data, 9))
    expect(decoded.staticAccounts[restake!.accounts[3]!]).toBe(
      associatedTokenAccount(ME, SSOL_MINT)
    )
  })

  it('passes its own check, and a quote builds nothing', async () => {
    const { venue } = venueWith()
    const prepared = await venue.prepare(stake, ME)
    expect(() => venue.assertSafe(prepared.signing, ME)).not.toThrow()
    const quoting = venueWith()
    const quoted = await quoting.venue.quote?.(stake, ME)
    expect(quoted?.receive?.symbol).toBe('sSOL')
    expect(quoted?.apyPercent).toBeUndefined()
    expect(quoting.rpc.calls).not.toContain('getLatestBlockhash')
  })

  it('refuses another token, a deposit that needs someone else, a stale pool, a wrong restaking owner', async () => {
    await expect(venueWith().venue.prepare({ ...stake, tokenIn: 'sUSD' }, ME)).rejects.toThrow(
      /takes SOL/
    )
    await expect(
      venueWith({ solDepositAuthority: SOMEONE_ELSE }).venue.prepare(stake, ME)
    ).rejects.toThrow(/another signature/)
    await expect(
      venueWith({ lastUpdateEpoch: BigInt(EPOCH - 1) }).venue.prepare(stake, ME)
    ).rejects.toThrow(/still updating/)
    await expect(
      venueWith({}, { restakingOwner: SOMEONE_ELSE }).venue.prepare(stake, ME)
    ).rejects.toThrow(/doesn’t look as expected/)
  })
})

describe('solayer unstake', () => {
  it('says plainly that this exit is delayed and how the person finishes it', async () => {
    const prepared = await preparedUnstake()
    expect(prepared.kind).toBe('unstake')
    expect(prepared.pay).toEqual({ amount: '1', symbol: 'sSOL' })
    expect(prepared.summary).toMatch(/cools down before you can withdraw/)
    const notes = prepared.notes.join(' ')
    expect(notes).toMatch(/This exit is delayed/)
    expect(notes).toMatch(/does not reach your balance now/)
    expect(notes).toMatch(/withdraw the SOL from that stake account yourself/)
    expect(notes).toMatch(/0\.08%/)
    expect(notes).toContain(addressWithSeed(ME, 'intent-1793830450018', STAKE_PROGRAM))
  })

  it('needs only the person: the stake account comes from a seed, not a new keypair', async () => {
    const prepared = await preparedUnstake()
    if (prepared.signing.family !== 'solana') throw new Error('Expected Solana.')
    const decoded = decodeSolanaTransaction(prepared.signing.transaction)
    expect(decoded.signerCount).toBe(1)
    const stakeAccount = addressWithSeed(ME, 'intent-1793830450018', STAKE_PROGRAM)
    const [unrestake, create, withdraw, deactivate] = decoded.instructions.slice(-4)
    expect(readU64(unrestake!.data, 8)).toBe(BigInt('1000000000'))
    expect(decoded.staticAccounts[create!.accounts[1]!]).toBe(stakeAccount)
    expect(readU64(withdraw!.data, 1)).toBe(BigInt('1000000000'))
    expect(decoded.staticAccounts[withdraw!.accounts[3]!]).toBe(BIG_VALIDATOR_STAKE)
    expect(decoded.staticAccounts[withdraw!.accounts[4]!]).toBe(stakeAccount)
    expect(decoded.staticAccounts[withdraw!.accounts[5]!]).toBe(ME)
    expect(decoded.staticAccounts[withdraw!.accounts[6]!]).toBe(ME)
    expect(decoded.staticAccounts[deactivate!.accounts[0]!]).toBe(stakeAccount)
    expect(decoded.staticAccounts[deactivate!.accounts[2]!]).toBe(ME)
    expect(() => venueWith().venue.assertSafe(prepared.signing, ME)).not.toThrow()
  })

  it('derives the address the chain did for a seed in a live transaction', () => {
    // 4krfXaL9... on 4 November 2026 created this account from this base and seed.
    expect(
      addressWithSeed(
        'HH2mfuVsuVpLBT7poqvSbzXXUXtMxUB5HKmUa5F7e1bG',
        'solstk1793830450018',
        STAKE_PROGRAM
      )
    ).toBe('DGTBCx2YJvGQEzFvT144ttKHoXkLAeh8FnpuZCxXDbjp')
  })

  it('picks the validator holding the most, unless the pool prefers one, and skips any not active', () => {
    const validators = decodeValidatorList(
      encodeList([
        validatorEntry(SMALL_VOTE, BigInt(5)),
        validatorEntry(BIG_VOTE, BigInt(9)),
        validatorEntry(SOMEONE_ELSE, BigInt(100), 1),
      ])
    )!
    expect(validators).toHaveLength(2)
    expect(chooseValidator({ preferredWithdrawValidator: undefined }, validators)?.vote).toBe(
      BIG_VOTE
    )
    expect(chooseValidator({ preferredWithdrawValidator: SMALL_VOTE }, validators)?.vote).toBe(
      SMALL_VOTE
    )
    expect(
      chooseValidator({ preferredWithdrawValidator: SOMEONE_ELSE }, validators)
    ).toBeUndefined()
  })

  it('refuses less than Solana lets a stake account hold, and names the market instead', async () => {
    await expect(venueWith().venue.prepare({ ...unstake, amount: '0.5' }, ME)).rejects.toThrow(
      /under the 1 SOL Solana requires.*sell sSOL on the market/
    )
  })

  it('refuses another token, more than the validator holds, and a pool with no validator', async () => {
    await expect(venueWith().venue.prepare({ ...unstake, tokenIn: 'SOL' }, ME)).rejects.toThrow(
      /takes sSOL/
    )
    await expect(venueWith().venue.prepare({ ...unstake, tokenIn: 'sUSD' }, ME)).rejects.toThrow(
      /takes sSOL/
    )
    await expect(
      venueWith({}, { list: encodeList([validatorEntry(BIG_VOTE, BigInt(10))]) }).venue.prepare(
        unstake,
        ME
      )
    ).rejects.toThrow(/can’t be withdrawn/)
    await expect(
      venueWith({}, { list: encodeList([]) }).venue.prepare(unstake, ME)
    ).rejects.toThrow(/no validator/)
  })
})

describe('solayer assertSafe', () => {
  const venue = venueWith().venue

  it('refuses the wrong signer', async () => {
    const prepared = await preparedStake()
    refuses(() => venue.assertSafe(prepared.signing, SOMEONE_ELSE), /network fee/)
    refuses(() => venue.assertSafe(payload(SOMEONE_ELSE, rebuilt(prepared, ME)), ME), /network fee/)
  })

  it('refuses an unknown program', async () => {
    const rest = rebuilt(await preparedStake(), ME)
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
  })

  it('refuses an unknown function', async () => {
    const rest = rebuilt(await preparedStake(), ME)
    refuses(
      () =>
        venue.assertSafe(payload(ME, [...rest.slice(0, -1), withOtherFunction(rest.at(-1)!)]), ME),
      /didn’t expect/
    )
  })

  it('refuses extra calldata', async () => {
    const rest = rebuilt(await preparedStake(), ME)
    refuses(
      () => venue.assertSafe(payload(ME, [...rest.slice(0, -1), withExtraData(rest.at(-1)!)]), ME),
      /didn’t expect/
    )
  })

  it('refuses sSOL or LP tokens going to someone else', async () => {
    const rest = rebuilt(await preparedStake(), ME)
    refuses(
      () =>
        venue.assertSafe(
          payload(ME, [
            ...rest.slice(0, -1),
            withAccount(rest.at(-1)!, 3, associatedTokenAccount(SOMEONE_ELSE, SSOL_MINT)),
          ]),
          ME
        ),
      /isn’t what Solayer should get/
    )
    refuses(
      () =>
        venue.assertSafe(
          payload(ME, [
            ...rest.slice(0, -2),
            withAccount(rest.at(-2)!, 4, associatedTokenAccount(SOMEONE_ELSE, SOLAYER_LP_MINT)),
            rest.at(-1)!,
          ]),
          ME
        ),
      /isn’t what Solayer should get/
    )
  })

  it('refuses a restake that does not match its deposit', async () => {
    const rest = rebuilt(await preparedStake(), ME)
    const last = rest.at(-1)!
    const data = Uint8Array.from(last.data ?? [])
    data[8] = (data[8] ?? 0) ^ 1
    refuses(
      () => venue.assertSafe(payload(ME, [...rest.slice(0, -1), { ...last, data }]), ME),
      /doesn’t match its deposit/
    )
  })

  it('refuses withdrawn stake going under someone else’s authority', async () => {
    const rest = rebuilt(await preparedUnstake(), ME)
    const withdraw = rest.at(-2)!
    refuses(
      () =>
        venue.assertSafe(
          payload(ME, [...rest.slice(0, -2), withAccount(withdraw, 5, SOMEONE_ELSE), rest.at(-1)!]),
          ME
        ),
      /isn’t what Solayer should get/
    )
  })

  it('refuses a stake account whose address the seed does not give, or that takes too much SOL', async () => {
    const rest = rebuilt(await preparedUnstake(), ME)
    const create = rest.at(-3)!
    refuses(
      () =>
        venue.assertSafe(
          payload(ME, [
            ...rest.slice(0, -3),
            withAccount(create, 1, SOMEONE_ELSE),
            ...rest.slice(-2),
          ]),
          ME
        ),
      /isn’t what Solayer should get/
    )
    const costly = createStakeAccountWithSeed(ME, 'intent-1793830450018', BigInt('5000000001'))
    refuses(
      () => venue.assertSafe(payload(ME, [...rest.slice(0, -3), costly, ...rest.slice(-2)]), ME),
      /isn’t what Solayer should get/
    )
  })

  it('refuses an exit that withdraws to a different stake account than it creates', async () => {
    const rest = rebuilt(await preparedUnstake(), ME)
    const other = addressWithSeed(ME, 'intent-2', STAKE_PROGRAM)
    refuses(
      () =>
        venue.assertSafe(
          payload(ME, [...rest.slice(0, -2), withAccount(rest.at(-2)!, 4, other), rest.at(-1)!]),
          ME
        ),
      /doesn’t fit together/
    )
  })

  it('refuses a transfer or an unlimited approval added to it', async () => {
    const rest = rebuilt(await preparedUnstake(), ME)
    refuses(
      () => venue.assertSafe(payload(ME, [...rest, transferOf(ME, SOMEONE_ELSE, BigInt(1))]), ME),
      /SOL transfer/
    )
    refuses(
      () =>
        venue.assertSafe(
          payload(ME, [
            ...rest,
            unlimitedApproval(associatedTokenAccount(ME, SOLAYER_LP_MINT), SOMEONE_ELSE, ME),
          ]),
          ME
        ),
      /moves or approves tokens/
    )
  })

  it('refuses a plain transfer where the stake account creation belongs', async () => {
    const rest = rebuilt(await preparedUnstake(), ME)
    refuses(
      () =>
        venue.assertSafe(
          payload(ME, [
            ...rest.slice(0, -3),
            transferOf(ME, SOMEONE_ELSE, BigInt(1)),
            ...rest.slice(-2),
          ]),
          ME
        ),
      /didn’t expect/
    )
  })

  it('refuses the wrong token', async () => {
    const rest = rebuilt(await preparedStake(), ME)
    const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
    refuses(
      () =>
        venue.assertSafe(
          payload(ME, [...rest.slice(0, -1), withAccount(rest.at(-1)!, 4, usdc)]),
          ME
        ),
      /isn’t what Solayer should get/
    )
  })
})

describe('solayer tokens and listing', () => {
  it('offers sSOL only', () => {
    expect(SOLAYER_TOKENS).toEqual([
      { symbol: 'sSOL', id: SSOL_MINT, decimals: 9, name: 'Solayer restaked SOL' },
    ])
  })

  it('lists as executing on Solana and says what it leaves out', () => {
    expect(solayerListing).toMatchObject({
      id: 'solayer',
      family: 'solana',
      integration: 'executes',
    })
    expect(solayerListing.capability).toMatch(/not sUSD, Pay, the card or the chain/)
  })
})
