import type { Instruction } from '@solana/kit'
import { describe, expect, it } from 'vitest'

import { decodeSolanaTransaction } from '../chains/solana/assert-safe'
import {
  addressWithSeed,
  createStakeAccountWithSeed,
  readU64,
  STAKE_EXIT_SLOTS,
  stakeExitAddress,
  STAKE_PROGRAM,
} from '../chains/solana/stake-pool'
import {
  decodeStakeAccount,
  decodeStakeHistory,
  MAX_CLAIMS_AT_ONCE,
  stakeStillCooling,
} from '../chains/solana/stake-claim'
import {
  createSolayerVenue,
  SOLAYER_LP_MINT,
  SOLAYER_RESTAKING_POOL,
  SOLAYER_RESTAKING_PROGRAM,
  SOLAYER_STAKE_POOL,
} from '../chains/solana/solayer'
import type { ChainActionRequest, PreparedAction } from '../chains/types'
import {
  addressBytes,
  encodeStakeAccount,
  encodeStakeHistory,
  encodeStakePool,
  fakeRpc,
  ME,
  NEVER_DEACTIVATED,
  payload,
  rebuilt,
  SOMEONE_ELSE,
  transferOf,
  u32Bytes,
  u64Bytes,
  UNKNOWN_PROGRAM,
  withAccount,
  withExtraData,
  type FakeAccount,
  type StakeAccountFixture,
} from './solana-stake-fixtures'

const EPOCH = 1078
const HISTORY_SYSVAR = 'SysvarStakeHistory1111111111111111111111111'
const CLOCK_SYSVAR = 'SysvarC1ock11111111111111111111111111111111'
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111'
const VOTE = 'SLaYv7tCwetrFGbPCRnqpHswG5qqKino78EYpbGF7xY'
const LIST = 'nk5E1Gc2rCuU2MDTRqdcQdiMfV9KnZ6JHykA1cTJQ56'

const DELEGATED = BigInt('2000000000')
const RENT = BigInt('1666240')
const HELD = DELEGATED + RENT

/** The cluster's own figures for epoch 1076, read from mainnet on 5 November 2026. */
const QUIET = {
  effective: BigInt('434700524078108143'),
  activating: BigInt('1279206833842960'),
  deactivating: BigInt('3005599698567390'),
}

const HISTORY = encodeStakeHistory([
  { epoch: BigInt(1077), ...QUIET },
  { epoch: BigInt(1076), ...QUIET },
])

function chainAccounts(
  exits: Record<number, Partial<StakeAccountFixture> & { lamports?: bigint; owner?: string }>
): Record<string, FakeAccount> {
  const accounts: Record<string, FakeAccount> = {
    [HISTORY_SYSVAR]: {
      owner: 'Sysvar1111111111111111111111111111111111111',
      lamports: BigInt(1),
      data: HISTORY,
    },
  }
  for (const [slot, exit] of Object.entries(exits)) {
    const { lamports, owner, ...stake } = exit
    accounts[stakeExitAddress(ME, Number(slot))] = {
      owner: owner ?? STAKE_PROGRAM,
      lamports: lamports ?? HELD,
      data: encodeStakeAccount({
        withdrawer: ME,
        voter: VOTE,
        delegated: DELEGATED,
        deactivationEpoch: BigInt(EPOCH - 1),
        ...stake,
      }),
    }
  }
  return accounts
}

function venueOver(
  exits: Parameters<typeof chainAccounts>[0],
  options: {
    epoch?: number
    slotIndex?: number
    simulationError?: unknown
    unreadable?: string[]
  } = {}
) {
  const rpc = fakeRpc({ epoch: options.epoch ?? EPOCH, accounts: chainAccounts(exits), ...options })
  return { venue: createSolayerVenue({ rpc }), rpc }
}

const CLAIM: ChainActionRequest = { kind: 'claim', amount: 'all', tokenIn: 'SOL' }

function callsOf(prepared: PreparedAction) {
  if (prepared.signing.family !== 'solana') throw new Error('Expected Solana.')
  const decoded = decodeSolanaTransaction(prepared.signing.transaction)
  return {
    decoded,
    calls: decoded.instructions
      .map((instruction) => ({
        program: decoded.staticAccounts[instruction.programIndex],
        accounts: instruction.accounts.map((index) => decoded.staticAccounts[index]),
        data: instruction.data,
      }))
      .filter(({ program }) => program !== COMPUTE_BUDGET),
  }
}

function refuses(action: () => unknown, pattern: RegExp): void {
  expect(action).toThrow(pattern)
}

describe('reading a stake account', () => {
  it('finds the fields at the offsets the stake program uses', () => {
    const decoded = decodeStakeAccount(
      encodeStakeAccount({
        withdrawer: ME,
        staker: SOMEONE_ELSE,
        delegated: DELEGATED,
        deactivationEpoch: BigInt(1077),
      })
    )
    expect(decoded).toEqual({
      delegated: true,
      withdrawer: ME,
      lockedUp: false,
      stake: DELEGATED,
      deactivationEpoch: BigInt(1077),
    })
  })

  it('sees any lockup, by time, by epoch or by custodian', () => {
    const locked = (change: Partial<StakeAccountFixture>): boolean | undefined =>
      decodeStakeAccount(encodeStakeAccount({ withdrawer: ME, ...change }))?.lockedUp
    expect(locked({ lockupTimestamp: BigInt(1) })).toBe(true)
    expect(locked({ lockupEpoch: BigInt(1) })).toBe(true)
    expect(locked({ custodian: SOMEONE_ELSE })).toBe(true)
    expect(locked({})).toBe(false)
  })

  it('takes no account of the wrong size or an uninitialized one', () => {
    expect(decodeStakeAccount(new Uint8Array(199))).toBeUndefined()
    expect(decodeStakeAccount(encodeStakeAccount({ withdrawer: ME, tag: 0 }))).toBeUndefined()
    expect(decodeStakeAccount(encodeStakeAccount({ withdrawer: ME, tag: 3 }))).toBeUndefined()
  })
})

describe('how much stake is still cooling', () => {
  const history = decodeStakeHistory(HISTORY)!

  it('cools in full the epoch after it stopped, when the network is quiet', () => {
    expect(stakeStillCooling(DELEGATED, BigInt(1077), BigInt(1078), history)).toBe(BigInt(0))
  })

  it('has not cooled at all in the epoch it stopped', () => {
    expect(stakeStillCooling(DELEGATED, BigInt(1078), BigInt(1078), history)).toBe(DELEGATED)
  })

  it('cools only in part when the whole network is leaving at once', () => {
    const crowded = decodeStakeHistory(
      encodeStakeHistory([
        {
          epoch: BigInt(1077),
          effective: BigInt(1000),
          activating: BigInt(0),
          deactivating: BigInt(1000),
        },
      ])
    )!
    // 9% of the effective stake leaves per epoch, shared by what is leaving: 90 of 1000 here.
    expect(stakeStillCooling(BigInt(1000), BigInt(1077), BigInt(1078), crowded)).toBe(BigInt(910))
  })

  it('counts as cooled once it is older than the history keeps', () => {
    expect(stakeStillCooling(DELEGATED, BigInt(100), BigInt(1078), history)).toBe(BigInt(0))
  })

  it('reads the history as the sysvar lays it out, and refuses a short one', () => {
    expect(history.get(BigInt(1077))).toEqual({
      effective: QUIET.effective,
      deactivating: QUIET.deactivating,
    })
    expect(decodeStakeHistory(new Uint8Array(4))).toBeUndefined()
    expect(decodeStakeHistory(HISTORY.subarray(0, 40))).toBeUndefined()
  })
})

describe('solayer positions', () => {
  it('shows nothing for a wallet that has unstaked nothing', async () => {
    await expect(venueOver({}).venue.positions?.(ME)).resolves.toEqual([])
  })

  it('reports a cooled account as claimable, with its whole balance', async () => {
    await expect(venueOver({ 0: {} }).venue.positions?.(ME)).resolves.toEqual([
      { slot: 'claimable', symbol: 'SOL', amount: '2.00166624' },
    ])
  })

  it('reports one still cooling, with the hours until the epoch ends', async () => {
    const { venue } = venueOver({ 3: { deactivationEpoch: BigInt(EPOCH) } }, { slotIndex: 216_000 })
    await expect(venue.positions?.(ME)).resolves.toEqual([
      { slot: 'cooling', symbol: 'SOL', amount: '2.00166624', readyInHours: 24 },
    ])
  })

  it('finds an account in the last slot', async () => {
    const { venue, rpc } = venueOver({ [STAKE_EXIT_SLOTS - 1]: {} })
    await expect(venue.positions?.(ME)).resolves.toHaveLength(1)
    expect(rpc.calls).not.toContain('getProgramAccounts')
  })

  it.each<[string, Partial<StakeAccountFixture> & { owner?: string }]>([
    ['someone else can withdraw', { withdrawer: SOMEONE_ELSE }],
    ['a lockup holds', { lockupEpoch: BigInt(9999) }],
    ['the stake program does not own', { owner: 'BPFLoaderUpgradeab1e11111111111111111111111' }],
    ['is still delegated', { deactivationEpoch: NEVER_DEACTIVATED }],
    ['never initialized', { tag: 0 }],
  ])('leaves out an account that %s', async (_name, exit) => {
    await expect(venueOver({ 0: exit }).venue.positions?.(ME)).resolves.toEqual([])
  })

  it.each([['getMultipleAccounts'], ['getEpochInfo']])(
    'throws rather than showing nothing when %s fails',
    async (method) => {
      await expect(
        venueOver({ 0: {} }, { unreadable: [method] }).venue.positions?.(ME)
      ).rejects.toThrow()
    }
  )

  it.each<[string, unknown]>([
    ['nonsense', { value: 'nothing' }],
    ['too few accounts', { value: [null] }],
    ['no reply', undefined],
  ])('throws rather than showing nothing when a node answers with %s', async (_name, answer) => {
    const inner = fakeRpc({ epoch: EPOCH, accounts: chainAccounts({ 0: {} }) })
    const rpc = async (method: string, params: unknown[]): Promise<unknown> =>
      method === 'getMultipleAccounts' ? answer : inner(method, params)
    await expect(createSolayerVenue({ rpc }).positions?.(ME)).rejects.toThrow(/could not be read/)
  })

  it('throws when the history can not be read', async () => {
    const rpc = fakeRpc({
      epoch: EPOCH,
      accounts: {
        ...chainAccounts({ 0: {} }),
        [HISTORY_SYSVAR]: { owner: 'x', lamports: BigInt(1), data: new Uint8Array(1) },
      },
    })
    await expect(createSolayerVenue({ rpc }).positions?.(ME)).rejects.toThrow()
  })
})

describe('solayer claim', () => {
  it('withdraws the whole balance of a cooled account to the person, who alone signs', async () => {
    const { venue } = venueOver({ 2: {} })
    const prepared = await venue.prepare(CLAIM, ME)
    expect(prepared.kind).toBe('claim')
    expect(prepared.receive).toEqual({ amount: '2.00166624', symbol: 'SOL', approximate: false })
    const { decoded, calls } = callsOf(prepared)
    expect(decoded.feePayer).toBe(ME)
    expect(decoded.signerCount).toBe(1)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.program).toBe(STAKE_PROGRAM)
    expect(calls[0]?.accounts).toEqual([
      stakeExitAddress(ME, 2),
      ME,
      CLOCK_SYSVAR,
      HISTORY_SYSVAR,
      ME,
    ])
    expect([...(calls[0]?.data.subarray(0, 4) ?? [])]).toEqual([4, 0, 0, 0])
    expect(calls[0]?.data).toHaveLength(12)
    expect(readU64(calls[0]!.data, 4)).toBe(HELD)
    expect(() => venue.assertSafe(prepared.signing, ME)).not.toThrow()
  })

  it('takes every ready account at once, and leaves the cooling one', async () => {
    const { venue } = venueOver(
      { 0: {}, 1: { deactivationEpoch: BigInt(EPOCH) }, 4: { lamports: BigInt('5000000000') } },
      { slotIndex: 216_000 }
    )
    const prepared = await venue.prepare(CLAIM, ME)
    const { calls } = callsOf(prepared)
    expect(calls.map((call) => call.accounts[0])).toEqual([
      stakeExitAddress(ME, 0),
      stakeExitAddress(ME, 4),
    ])
    expect(prepared.receive?.amount).toBe('7.00166624')
    expect(prepared.notes.join(' ')).toMatch(/2\.00166624 SOL is still cooling, about 24 hours/)
  })

  it('takes as many as fit, says so, and fits a transaction', async () => {
    const exits = Object.fromEntries(
      Array.from({ length: MAX_CLAIMS_AT_ONCE + 2 }, (_, slot) => [slot, {}])
    )
    const { venue } = venueOver(exits)
    const prepared = await venue.prepare(CLAIM, ME)
    expect(callsOf(prepared).calls).toHaveLength(MAX_CLAIMS_AT_ONCE)
    expect(prepared.notes.join(' ')).toMatch(/2 more .*claim again/)
    if (prepared.signing.family !== 'solana') throw new Error('Expected Solana.')
    expect(Buffer.from(prepared.signing.transaction, 'base64').length).toBeLessThanOrEqual(1232)
    expect(() => venue.assertSafe(prepared.signing, ME)).not.toThrow()
  })

  it('accepts sSOL as the token asked about, since that is what was unstaked', async () => {
    await expect(
      venueOver({ 0: {} }).venue.prepare({ ...CLAIM, tokenIn: 'sSOL' }, ME)
    ).resolves.toMatchObject({ kind: 'claim' })
  })

  it('refuses when nothing has been unstaked', async () => {
    await expect(venueOver({}).venue.prepare(CLAIM, ME)).rejects.toThrow(
      /no Solayer unstake waiting.*Nothing was signed or sent/
    )
  })

  it('refuses while it cools, saying how long is left', async () => {
    const { venue } = venueOver({ 0: { deactivationEpoch: BigInt(EPOCH) } }, { slotIndex: 216_000 })
    await expect(venue.prepare(CLAIM, ME)).rejects.toThrow(
      /2\.00166624 SOL is still cooling, about 24 hours.*Nothing was signed or sent/
    )
  })

  it('refuses an account only someone else can withdraw from', async () => {
    const { venue } = venueOver({ 0: { withdrawer: SOMEONE_ELSE } })
    await expect(venue.prepare(CLAIM, ME)).rejects.toThrow(
      /another wallet.*Nothing was signed or sent/
    )
  })

  it('refuses an account under a lockup', async () => {
    await expect(
      venueOver({ 0: { lockupEpoch: BigInt(9999) } }).venue.prepare(CLAIM, ME)
    ).rejects.toThrow(/locked.*Nothing was signed or sent/)
  })

  it('refuses one put back to work, rather than call it ready', async () => {
    await expect(
      venueOver({ 0: { deactivationEpoch: NEVER_DEACTIVATED } }).venue.prepare(CLAIM, ME)
    ).rejects.toThrow(/delegated again.*Nothing was signed or sent/)
  })

  it('refuses a set amount, since a claim takes what is ready', async () => {
    await expect(venueOver({ 0: {} }).venue.prepare({ ...CLAIM, amount: '1' }, ME)).rejects.toThrow(
      /everything that is ready/
    )
  })

  it('refuses another token', async () => {
    await expect(
      venueOver({ 0: {} }).venue.prepare({ ...CLAIM, tokenIn: 'USDC' }, ME)
    ).rejects.toThrow(/USDC/)
  })

  it('refuses what would fail on the chain, in plain words', async () => {
    const { venue } = venueOver({ 0: {} }, { simulationError: { InstructionError: [2, 'x'] } })
    await expect(venue.prepare(CLAIM, ME)).rejects.toThrow(
      /would fail on the chain.*network fee.*Nothing was signed or sent/
    )
  })

  it('refuses when the chain can not be read', async () => {
    await expect(
      venueOver({ 0: {} }, { unreadable: ['getMultipleAccounts'] }).venue.prepare(CLAIM, ME)
    ).rejects.toThrow()
  })
})

describe('the claim assertSafe', () => {
  const { venue } = venueOver({})
  const prepared = (): Promise<PreparedAction> => venueOver({ 0: {} }).venue.prepare(CLAIM, ME)

  it('refuses SOL going to anyone but the signer', async () => {
    const rest = rebuilt(await prepared(), ME)
    refuses(
      () =>
        venue.assertSafe(
          payload(ME, [...rest.slice(0, -1), withAccount(rest.at(-1)!, 1, SOMEONE_ELSE)]),
          ME
        ),
      /isn’t what Solayer should get/
    )
  })

  it('refuses another withdraw authority', async () => {
    const rest = rebuilt(await prepared(), ME)
    refuses(
      () =>
        venue.assertSafe(
          payload(ME, [...rest.slice(0, -1), withAccount(rest.at(-1)!, 4, SOMEONE_ELSE)]),
          ME
        ),
      /isn’t what Solayer should get/
    )
  })

  it('refuses a stake account these unstakes could not have made', async () => {
    const rest = rebuilt(await prepared(), ME)
    refuses(
      () =>
        venue.assertSafe(
          payload(ME, [...rest.slice(0, -1), withAccount(rest.at(-1)!, 0, SOMEONE_ELSE)]),
          ME
        ),
      /isn’t what Solayer should get/
    )
  })

  it('refuses the same account twice', async () => {
    const rest = rebuilt(await prepared(), ME)
    refuses(() => venue.assertSafe(payload(ME, [...rest, rest.at(-1)!]), ME), /more than once/)
  })

  it('refuses a withdrawal of nothing, and extra bytes', async () => {
    const rest = rebuilt(await prepared(), ME)
    const last = rest.at(-1)!
    const data = Uint8Array.from(last.data ?? [])
    data.fill(0, 4)
    refuses(
      () => venue.assertSafe(payload(ME, [...rest.slice(0, -1), { ...last, data }]), ME),
      /isn’t what Solayer should get/
    )
    refuses(
      () => venue.assertSafe(payload(ME, [...rest.slice(0, -1), withExtraData(last)]), ME),
      /didn’t expect/
    )
  })

  it('refuses a transfer added to it, or another program', async () => {
    const rest = rebuilt(await prepared(), ME)
    refuses(
      () => venue.assertSafe(payload(ME, [...rest, transferOf(ME, SOMEONE_ELSE, BigInt(1))]), ME),
      /SOL transfer/
    )
    refuses(
      () =>
        venue.assertSafe(
          payload(ME, [
            ...rest.slice(0, -1),
            { ...rest.at(-1)!, programAddress: UNKNOWN_PROGRAM as never },
          ]),
          ME
        ),
      /should not need/
    )
  })

  it('refuses another wallet paying', async () => {
    const built = await prepared()
    refuses(() => venue.assertSafe(built.signing, SOMEONE_ELSE), /network fee/)
    refuses(() => venue.assertSafe(payload(SOMEONE_ELSE, rebuilt(built, ME)), ME), /network fee/)
  })
})

describe('the unstake that claim has to find later', () => {
  const unstake: ChainActionRequest = { kind: 'unstake', amount: '1', tokenIn: 'sSOL' }
  const EPOCH_NOW = 1077
  const BASE = {
    poolMint: SOLAYER_LP_MINT,
    reserveStake: 'Brh9rB6npnjM1vDXyCXtzkXVGRnsh6KHqmBz26tVACg9',
    managerFeeAccount: 'ARs3HTD79nsaUdDKqfGhgbNMVJkXVdRs2EpHAm4LNEcq',
    validatorList: LIST,
    totalLamports: BigInt('82390512858986'),
    poolTokenSupply: BigInt('69899353088216'),
    lastUpdateEpoch: BigInt(EPOCH_NOW),
  }
  const list = (): Uint8Array =>
    Uint8Array.from([
      2,
      ...u32Bytes(100),
      ...u32Bytes(1),
      ...u64Bytes(BigInt('82389651605762')),
      ...u64Bytes(BigInt(0)),
      ...u64Bytes(BigInt(EPOCH_NOW)),
      ...u64Bytes(BigInt(0)),
      ...u32Bytes(0),
      ...u32Bytes(0),
      0,
      ...addressBytes(VOTE),
    ])

  function venueWithExits(taken: readonly number[]) {
    const accounts: Record<string, FakeAccount> = {
      [SOLAYER_STAKE_POOL]: {
        owner: 'SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy',
        lamports: BigInt(1),
        data: encodeStakePool(BASE),
      },
      [SOLAYER_RESTAKING_POOL]: {
        owner: SOLAYER_RESTAKING_PROGRAM,
        lamports: BigInt(1),
        data: new Uint8Array(74),
      },
      [LIST]: { owner: 'x', lamports: BigInt(1), data: list() },
    }
    for (const slot of taken) {
      accounts[stakeExitAddress(ME, slot)] = {
        owner: STAKE_PROGRAM,
        lamports: HELD,
        data: encodeStakeAccount({ withdrawer: ME, delegated: DELEGATED }),
      }
    }
    return createSolayerVenue({ rpc: fakeRpc({ epoch: EPOCH_NOW, accounts }) })
  }

  it('makes the account in the first free slot', async () => {
    const prepared = await venueWithExits([]).prepare(unstake, ME)
    expect(prepared.notes[0]).toContain(stakeExitAddress(ME, 0))
    const next = await venueWithExits([0, 1, 3]).prepare(unstake, ME)
    expect(next.notes[0]).toContain(stakeExitAddress(ME, 2))
  })

  it('refuses a new exit when every slot is waiting, so none can fall out of sight', async () => {
    const all = Array.from({ length: STAKE_EXIT_SLOTS }, (_, slot) => slot)
    await expect(venueWithExits(all).prepare(unstake, ME)).rejects.toThrow(
      /claim.*Nothing was signed or sent/
    )
  })

  it('says the person can claim, and no longer sends them elsewhere', async () => {
    const notes = (await venueWithExits([]).prepare(unstake, ME)).notes.join(' ')
    expect(notes).toMatch(/"claim SOL from Solayer"/)
    expect(notes).not.toMatch(/isn’t wired/)
    expect(notes).not.toMatch(/command line/)
  })

  it.each([
    ['a timestamp, which nothing could find later', 'intent-1793830450018'],
    ['a slot past the last', `intent-stake-${STAKE_EXIT_SLOTS}`],
    ['a slot written with a leading zero', 'intent-stake-05'],
    ['a seed of its own', 'hidden'],
  ])('refuses a stake account seeded with %s', async (_name, seed) => {
    const venue = venueWithExits([])
    const rest = rebuilt(await venue.prepare(unstake, ME), ME)
    const swapped = createStakeAccountWithSeed(ME, seed, RENT)
    const stakeAccount = addressWithSeed(ME, seed, STAKE_PROGRAM)
    const fit = (instruction: Instruction, position: number): Instruction =>
      withAccount(instruction, position, stakeAccount)
    refuses(
      () =>
        venue.assertSafe(
          payload(ME, [...rest.slice(0, -3), swapped, fit(rest.at(-2)!, 4), fit(rest.at(-1)!, 0)]),
          ME
        ),
      /isn’t what Solayer should get/
    )
  })
})
