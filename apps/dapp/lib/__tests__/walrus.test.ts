import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { bcs } from '@mysten/sui/bcs'
import { Transaction } from '@mysten/sui/transactions'
import { normalizeSuiAddress, toBase64 } from '@mysten/sui/utils'
import { describe, expect, it, vi } from 'vitest'

import { parseChainAction } from '../chains/parse-action'
import { prepareChainAction } from '../chains/prepare'
import {
  assertWalrusSafe,
  createWalrusVenue,
  MAX_POSITIONS_PER_TRANSACTION,
  phaseOf,
  pickNode,
  planClaim,
  planUnstake,
  planWholeUnstake,
  STAKED_WAL_TYPE,
  stakingStateFrom,
  venuePositionsFrom,
  WAL_TYPE,
  WALRUS_ORIGINAL_PACKAGE,
  WALRUS_PACKAGE,
  WALRUS_STAKING,
  WALRUS_TOKENS,
  WALRUS_VERSION,
  walPaid,
  type Position,
  type StakingState,
  type WalrusDeps,
} from '../chains/sui/walrus'
import { walrusListing } from '../chains/sui/walrus-listing'
import {
  ChainActionRefused,
  type ChainActionRequest,
  type ChainModule,
  type ChainVenue,
} from '../chains/types'

const ID_A = normalizeSuiAddress('0x51')
const ME = '0x00000000000000000000000000000000000000000000000000000000000000a1'
const THIEF = '0x000000000000000000000000000000000000000000000000000000000000dead'
const FOREIGN = '0x00000000000000000000000000000000000000000000000000000000000bad01'
const NODE_A = '0x00000000000000000000000000000000000000000000000000000000000000aa'
const NODE_B = '0x00000000000000000000000000000000000000000000000000000000000000bb'
const NODE_C = '0x00000000000000000000000000000000000000000000000000000000000000cc'
const GONE = '0x00000000000000000000000000000000000000000000000000000000000000ee'
const DIGEST = '11111111111111111111111111111111'
const WAL = BigInt('1000000000')
const shards = (n: number) => Array.from({ length: n }, (_, i) => i)

function committeeJson(sizes: Record<string, number>) {
  return {
    pos0: { contents: Object.entries(sizes).map(([key, n]) => ({ key, value: shards(n) })) },
  }
}

function innerJson(next: Record<string, number> | null = null, epoch = 43) {
  return {
    id: '0x1',
    name: '4',
    value: {
      epoch,
      n_shards: 1000,
      epoch_duration: '1209600000',
      first_epoch_start: '1742914804744',
      committee: committeeJson({ [NODE_A]: 26, [NODE_B]: 7, [NODE_C]: 3 }),
      next_committee: next === null ? null : committeeJson(next),
    },
  }
}

const STATE: StakingState = stakingStateFrom(innerJson())

function poolJson(
  id: string,
  name: string,
  commission: number,
  pending: { key: number; value: string }[] = [],
  state: unknown = { '@variant': 'Active' }
) {
  return {
    id,
    state,
    node_info: { name },
    commission_rate: commission,
    pending_commission_rate: { pos0: { contents: pending } },
  }
}

const STAKING_JSON = {
  id: WALRUS_STAKING,
  version: WALRUS_VERSION,
  package_id: WALRUS_PACKAGE,
  new_package_id: null,
}

function ownedObject(
  id: string,
  principal: bigint,
  state: unknown,
  node = NODE_A,
  activation = 10,
  type = STAKED_WAL_TYPE
) {
  return {
    objectId: id,
    version: '5',
    digest: DIGEST,
    type,
    json: {
      id,
      state,
      node_id: node,
      principal: principal.toString(),
      activation_epoch: activation,
    },
  }
}

const STAKED = { '@variant': 'Staked' }
const withdrawing = (epoch: number) => ({ '@variant': 'Withdrawing', withdraw_epoch: epoch })

interface FakeChain {
  staking?: unknown
  inner?: unknown
  pools?: unknown[]
  owned?: unknown[]
  simulated?: unknown
}

function venueOver(chain: FakeChain = {}) {
  const built: Transaction[] = []
  const core = {
    getObject: vi.fn(async ({ objectId }: { objectId: string }) => ({
      object: {
        json:
          objectId === WALRUS_STAKING
            ? (chain.staking ?? STAKING_JSON)
            : (chain.inner ?? innerJson()),
      },
    })),
    getObjects: vi.fn(async () => ({
      objects: (
        chain.pools ?? [poolJson(NODE_A, 'Big Node', 6000), poolJson(NODE_B, 'Cheap Node', 60)]
      ).map((json) => ({ json })),
    })),
    listOwnedObjects: vi.fn(async () => ({
      objects: chain.owned ?? [],
      hasNextPage: false,
      cursor: null,
    })),
    simulateTransaction: vi.fn(
      async () => chain.simulated ?? { Transaction: { balanceChanges: [] } }
    ),
  }
  const build = vi.fn(async (tx: Transaction) => {
    built.push(tx)
    fund(tx)
    try {
      return toBase64(await tx.build())
    } catch {
      // A stake's coin is only resolved against a real chain. Its commands are read from `built`.
      return 'AA=='
    }
  })
  const deps = { client: () => ({ core }), build } as unknown as WalrusDeps
  return { venue: createWalrusVenue(deps), built, core, build }
}

function fund(tx: Transaction): void {
  tx.setGasPrice(1000)
  tx.setGasBudget(10_000_000)
  tx.setGasPayment([{ objectId: normalizeSuiAddress('0x99'), version: '1', digest: DIGEST }])
}

const stake = (amount: string, tokenIn = 'WAL'): ChainActionRequest => ({
  kind: 'stake',
  amount,
  tokenIn,
})
const unstake = (amount: string, tokenIn = 'WAL'): ChainActionRequest => ({
  kind: 'unstake',
  amount,
  tokenIn,
})

function calls(tx: Transaction): string[] {
  return tx.getData().commands.flatMap((c) => {
    if (c.$kind !== 'MoveCall') return []
    return [`${c.MoveCall.module}::${c.MoveCall.function}`]
  })
}

function position(overrides: Partial<Position> = {}): Position {
  return {
    objectId: normalizeSuiAddress('0x51'),
    version: '5',
    digest: DIGEST,
    nodeId: normalizeSuiAddress(NODE_A),
    principal: BigInt(10) * WAL,
    activationEpoch: 10,
    withdrawEpoch: undefined,
    ...overrides,
  }
}

function stakingRef(tx: Transaction, objectId = WALRUS_STAKING) {
  return tx.sharedObjectRef({ objectId, initialSharedVersion: '317862159', mutable: true })
}

function ownedRef(tx: Transaction, id: string) {
  return tx.objectRef({ objectId: normalizeSuiAddress(id), version: '5', digest: DIGEST })
}

const STAKE = `${WALRUS_PACKAGE}::staking::stake_with_pool`
const REQUEST = `${WALRUS_PACKAGE}::staking::request_withdraw_stake`
const WITHDRAW = `${WALRUS_PACKAGE}::staking::withdraw_stake`
const SPLIT = `${WALRUS_PACKAGE}::staked_wal::split`

async function built(edit: (tx: Transaction) => void, sender = ME): Promise<string> {
  const tx = new Transaction()
  tx.setSender(sender)
  fund(tx)
  edit(tx)
  return toBase64(await tx.build())
}

function goodStake(tx: Transaction, recipient = ME, staking = WALRUS_STAKING): void {
  const [staked] = tx.moveCall({
    target: STAKE,
    arguments: [stakingRef(tx, staking), ownedRef(tx, '0x77'), tx.pure.id(NODE_A)],
  })
  tx.transferObjects([staked as never], recipient)
}

function check(transaction: string, account = ME): void {
  assertWalrusSafe({ family: 'sui', transaction }, account)
}

describe('assertSafe', () => {
  it('passes the exact staking calls', async () => {
    await expect(built((tx) => goodStake(tx))).resolves.toBeDefined()
    check(await built((tx) => goodStake(tx)))
    check(
      await built((tx) => {
        tx.moveCall({ target: REQUEST, arguments: [stakingRef(tx), ownedRef(tx, '0x51')] })
      })
    )
    check(
      await built((tx) => {
        const [coin] = tx.moveCall({
          target: WITHDRAW,
          arguments: [stakingRef(tx), ownedRef(tx, '0x51')],
        })
        tx.transferObjects([coin as never], ME)
      })
    )
  })

  it('refuses a transaction from another account', async () => {
    const transaction = await built((tx) => goodStake(tx), THIEF)
    expect(() => check(transaction)).toThrow(/different account/)
  })

  it('refuses a fee paid by another account', async () => {
    const transaction = await built((tx) => {
      goodStake(tx)
      tx.setGasOwner(THIEF)
    })
    expect(() => check(transaction)).toThrow(/paid by a different account/)
  })

  it('refuses a StakedWal sent to someone else', async () => {
    const transaction = await built((tx) => goodStake(tx, THIEF))
    expect(() => check(transaction)).toThrow(/send funds to another address/)
  })

  it('refuses a split part sent to someone else', async () => {
    const transaction = await built((tx) => {
      const [part] = tx.moveCall({
        target: SPLIT,
        arguments: [ownedRef(tx, '0x51'), tx.pure.u64(WAL)],
      })
      tx.transferObjects([part as never], THIEF)
    })
    expect(() => check(transaction)).toThrow(/send funds to another address/)
  })

  it('refuses WAL paid out to someone else', async () => {
    const transaction = await built((tx) => {
      const [coin] = tx.moveCall({
        target: WITHDRAW,
        arguments: [stakingRef(tx), ownedRef(tx, '0x51')],
      })
      tx.transferObjects([coin as never], THIEF)
    })
    expect(() => check(transaction)).toThrow(/send funds to another address/)
  })

  it('refuses public_transfer, which moves anything without a transfer command', async () => {
    const transaction = await built((tx) => {
      tx.moveCall({
        target: '0x2::transfer::public_transfer',
        typeArguments: [STAKED_WAL_TYPE],
        arguments: [ownedRef(tx, '0x51'), tx.pure.address(THIEF)],
      })
    })
    expect(() => check(transaction)).toThrow(/public_transfer/)
  })

  it('refuses an unknown contract with the same module and function', async () => {
    const transaction = await built((tx) => {
      tx.moveCall({
        target: `${FOREIGN}::staking::stake_with_pool`,
        arguments: [stakingRef(tx), ownedRef(tx, '0x77'), tx.pure.id(NODE_A)],
      })
    })
    expect(() => check(transaction)).toThrow(/haven't confirmed/)
  })

  it('refuses the package as it was before the upgrade', async () => {
    const transaction = await built((tx) => {
      tx.moveCall({
        target: `${WALRUS_ORIGINAL_PACKAGE}::staking::withdraw_stake`,
        arguments: [stakingRef(tx), ownedRef(tx, '0x51')],
      })
    })
    expect(() => check(transaction)).toThrow(/haven't confirmed/)
  })

  it.each([
    ['staking', 'set_next_commission'],
    ['staking', 'register_candidate'],
    ['staking', 'set_commission_receiver'],
    ['staked_wal', 'join'],
    ['system', 'reserve_space'],
  ])('refuses %s::%s, which is not a staking call this venue makes', async (module, fn) => {
    const transaction = await built((tx) => {
      tx.moveCall({
        target: `${WALRUS_PACKAGE}::${module}::${fn}`,
        arguments: [stakingRef(tx)],
      })
    })
    expect(() => check(transaction)).toThrow(/haven't confirmed/)
  })

  it('refuses extra arguments', async () => {
    const transaction = await built((tx) => {
      tx.moveCall({
        target: WITHDRAW,
        arguments: [stakingRef(tx), ownedRef(tx, '0x51'), tx.pure.address(THIEF)],
      })
    })
    expect(() => check(transaction)).toThrow(/does not match/)
  })

  it('refuses a missing argument', async () => {
    const transaction = await built((tx) => {
      tx.moveCall({ target: WITHDRAW, arguments: [stakingRef(tx)] })
    })
    expect(() => check(transaction)).toThrow(/does not match/)
  })

  it('refuses a type argument, since no staking call takes one', async () => {
    const transaction = await built((tx) => {
      tx.moveCall({
        target: WITHDRAW,
        typeArguments: [WAL_TYPE],
        arguments: [stakingRef(tx), ownedRef(tx, '0x51')],
      })
    })
    expect(() => check(transaction)).toThrow(/does not match/)
  })

  it('refuses a staking object other than the Walrus one', async () => {
    const transaction = await built((tx) => goodStake(tx, ME, FOREIGN))
    expect(() => check(transaction)).toThrow(/staking object/)
  })

  it('refuses a staking object passed as something owned', async () => {
    const transaction = await built((tx) => {
      tx.moveCall({
        target: REQUEST,
        arguments: [ownedRef(tx, WALRUS_STAKING), ownedRef(tx, '0x51')],
      })
    })
    expect(() => check(transaction)).toThrow(/staking object/)
  })

  it('refuses a stake whose node is not a whole id', async () => {
    const transaction = await built((tx) => {
      const [staked] = tx.moveCall({
        target: STAKE,
        arguments: [stakingRef(tx), ownedRef(tx, '0x77'), tx.pure(bcs.u64().serialize(1))],
      })
      tx.transferObjects([staked as never], ME)
    })
    expect(() => check(transaction)).toThrow(/storage node/)
  })

  it('refuses a stake whose node is not literal', async () => {
    const transaction = await built((tx) => {
      const [staked] = tx.moveCall({
        target: STAKE,
        arguments: [stakingRef(tx), ownedRef(tx, '0x77'), ownedRef(tx, '0x78')],
      })
      tx.transferObjects([staked as never], ME)
    })
    expect(() => check(transaction)).toThrow(/storage node/)
  })

  it('refuses a split of nothing', async () => {
    const transaction = await built((tx) => {
      tx.moveCall({ target: SPLIT, arguments: [ownedRef(tx, '0x51'), tx.pure.u64(0)] })
    })
    expect(() => check(transaction)).toThrow(/amount/)
  })

  it('refuses a payload that is not Sui, or not bytes', () => {
    expect(() => assertWalrusSafe({ family: 'solana', transaction: 'AA==' }, ME)).toThrow(
      ChainActionRefused
    )
    expect(() => check('{"not":"bcs"}')).toThrow(ChainActionRefused)
    expect(() => check('')).toThrow(ChainActionRefused)
  })

  it('refuses a malformed account', async () => {
    const transaction = await built((tx) => goodStake(tx))
    expect(() => check(transaction, 'nope')).toThrow(/not a Sui address/)
  })
})

describe('reading the staking state', () => {
  it('reads the epoch and both committees', () => {
    const state = stakingStateFrom(innerJson({ [NODE_A]: 30 }))
    expect(state.epoch).toBe(43)
    expect(state.epochDurationMs).toBe(1_209_600_000)
    expect(state.committee.get(normalizeSuiAddress(NODE_B))).toBe(7)
    expect(state.nextCommittee?.get(normalizeSuiAddress(NODE_A))).toBe(30)
  })

  it.each([
    ['nothing', undefined],
    ['no value', { id: '0x1' }],
    ['a zero epoch length', { value: { ...innerJson().value, epoch_duration: '0' } }],
    ['a committee in another shape', { value: { ...innerJson().value, committee: [] } }],
    ['a next committee in another shape', { value: { ...innerJson().value, next_committee: 7 } }],
    ['no next committee field', { value: { ...innerJson().value, next_committee: undefined } }],
  ])('refuses %s', (_name, json) => {
    expect(() => stakingStateFrom(json)).toThrow(/Nothing was signed or sent/)
  })
})

describe('choosing a node', () => {
  it('takes the lowest commission, not the largest node', () => {
    const node = pickNode(
      [poolJson(NODE_A, 'Big Node', 6000), poolJson(NODE_B, 'Cheap Node', 60)],
      STATE
    )
    expect(node).toEqual({
      id: normalizeSuiAddress(NODE_B),
      name: 'Cheap Node',
      shards: 7,
      commissionBps: 60,
    })
  })

  it('breaks a tie on commission by shards', () => {
    const node = pickNode([poolJson(NODE_B, 'Small', 6000), poolJson(NODE_A, 'Large', 6000)], STATE)
    expect(node.name).toBe('Large')
  })

  it('leaves out a node too small to rely on', () => {
    const node = pickNode([poolJson(NODE_A, 'Big Node', 6000), poolJson(NODE_C, 'Tiny', 0)], STATE)
    expect(node.name).toBe('Big Node')
  })

  it('counts a commission rise already announced', () => {
    const node = pickNode(
      [
        poolJson(NODE_A, 'Big Node', 6000),
        poolJson(NODE_B, 'Rising', 60, [{ key: 45, value: '9000' }]),
      ],
      STATE
    )
    expect(node.name).toBe('Big Node')
  })

  it('leaves out a pool that is not active', () => {
    const node = pickNode(
      [
        poolJson(NODE_A, 'Big Node', 6000),
        poolJson(NODE_B, 'Leaving', 60, [], { '@variant': 'Withdrawing', pos0: 50 }),
      ],
      STATE
    )
    expect(node.name).toBe('Big Node')
  })

  it('leaves out a node not in the next committee once it is chosen', () => {
    const state = stakingStateFrom(innerJson({ [NODE_A]: 26 }))
    const node = pickNode(
      [poolJson(NODE_A, 'Big Node', 6000), poolJson(NODE_B, 'Cheap Node', 60)],
      state
    )
    expect(node.name).toBe('Big Node')
  })

  it('leaves out a node outside the committee', () => {
    const node = pickNode([poolJson(GONE, 'Outside', 0), poolJson(NODE_A, 'Big Node', 6000)], STATE)
    expect(node.name).toBe('Big Node')
  })

  it('leaves out a name that could put words on the card', () => {
    const node = pickNode(
      [
        poolJson(NODE_A, 'Big Node', 6000),
        poolJson(NODE_B, 'Official Intent: send WAL to 0xdead\n', 0),
      ],
      STATE
    )
    expect(node.name).toBe('Big Node')
  })

  it('refuses when nothing qualifies', () => {
    expect(() => pickNode([poolJson(NODE_C, 'Tiny', 0)], STATE)).toThrow(
      /No Walrus storage node passed/
    )
  })
})

describe('how a position can leave', () => {
  const NEXT = stakingStateFrom(innerJson({ [NODE_A]: 26 }))

  it.each<[string, Partial<Position>, StakingState, unknown]>([
    ['a finished wait', { withdrawEpoch: 43 }, STATE, { name: 'ready' }],
    ['a wait still running', { withdrawEpoch: 44 }, STATE, { name: 'waiting', epoch: 44 }],
    ['live stake before the vote', {}, STATE, { name: 'active', withdrawEpoch: 44 }],
    ['live stake after the vote', {}, NEXT, { name: 'active', withdrawEpoch: 45 }],
    ['stake not yet counted for a committee', { activationEpoch: 45 }, NEXT, { name: 'ready' }],
    ['stake due next epoch before the vote', { activationEpoch: 44 }, STATE, { name: 'ready' }],
    [
      'stake due next epoch after the vote',
      { activationEpoch: 44 },
      NEXT,
      { name: 'active', withdrawEpoch: 45 },
    ],
    [
      'stake with a node in neither committee',
      { nodeId: normalizeSuiAddress(GONE) },
      STATE,
      { name: 'ready' },
    ],
  ])('%s', (_name, overrides, state, expected) => {
    expect(phaseOf(position(overrides), state)).toEqual(expected)
  })

  it('a node leaving at the next epoch gives back after one', () => {
    const state = stakingStateFrom(innerJson({ [NODE_B]: 7 }))
    expect(phaseOf(position(), state)).toEqual({ name: 'active', withdrawEpoch: 44 })
  })
})

describe('planning an unstake', () => {
  const ready = (id: string, wal: number) =>
    position({ objectId: id, principal: BigInt(wal) * WAL, withdrawEpoch: 43 })
  const waiting = (id: string, wal: number) =>
    position({ objectId: id, principal: BigInt(wal) * WAL, withdrawEpoch: 44 })
  const active = (id: string, wal: number) =>
    position({ objectId: id, principal: BigInt(wal) * WAL })

  it('collects what is ready, and leaves what is staked alone', () => {
    const plan = planUnstake([ready('0x1', 5), active('0x2', 50)], STATE, BigInt(5) * WAL)
    expect(plan.step).toBe('collect')
    expect(plan.pieces).toHaveLength(1)
    expect(plan.pieces[0]?.split).toBeUndefined()
  })

  it('splits what is ready when less is asked for', () => {
    const plan = planUnstake([ready('0x1', 5)], STATE, BigInt(2) * WAL)
    expect(plan.step).toBe('collect')
    expect(plan.pieces[0]?.split).toBe(BigInt(2) * WAL)
  })

  it('starts a withdrawal when nothing is ready', () => {
    const plan = planUnstake([active('0x2', 50)], STATE, BigInt(50) * WAL)
    expect(plan).toMatchObject({ step: 'start', collectEpoch: 44, total: BigInt(50) * WAL })
    expect(plan.pieces[0]?.split).toBeUndefined()
  })

  it('never starts a second withdrawal of money already waiting', () => {
    expect(() =>
      planUnstake([waiting('0x1', 5), active('0x2', 50)], STATE, BigInt(5) * WAL)
    ).toThrow(/already on its way out.*epoch 44.*17 Nov 2026.*Nothing was signed/)
  })

  it('starts only the part not already waiting', () => {
    const plan = planUnstake([waiting('0x1', 5), active('0x2', 50)], STATE, BigInt(8) * WAL)
    expect(plan).toMatchObject({ step: 'start', total: BigInt(3) * WAL, waiting: BigInt(5) * WAL })
  })

  it('refuses to mix collecting with starting', () => {
    expect(() => planUnstake([ready('0x1', 5), active('0x2', 50)], STATE, BigInt(6) * WAL)).toThrow(
      /5 WAL is ready to collect now/
    )
  })

  it('refuses more than is staked', () => {
    expect(() => planUnstake([active('0x2', 5)], STATE, BigInt(6) * WAL)).toThrow(
      /You have 5 WAL staked/
    )
  })

  it('refuses when nothing is staked', () => {
    expect(() => planUnstake([], STATE, WAL)).toThrow(/no WAL staked/)
  })

  it('refuses a split the contract would abort', () => {
    expect(() => planUnstake([active('0x2', 5)], STATE, WAL / BigInt(2))).toThrow(/under 1 WAL/)
    expect(() => planUnstake([active('0x2', 5)], STATE, BigInt(5) * WAL - WAL / BigInt(2))).toThrow(
      /under 1 WAL/
    )
  })

  it('takes the largest position first', () => {
    const plan = planUnstake([active('0x1', 2), active('0x2', 9)], STATE, BigInt(9) * WAL)
    expect(plan.pieces.map((p) => p.position.objectId)).toEqual(['0x2'])
  })
})

describe('reading what a dry run pays', () => {
  const change = (coinType: string, address: string, amount: string) => ({
    coinType,
    address,
    amount,
  })

  it('reads WAL to the account', () => {
    expect(walPaid([change(WAL_TYPE, ME, '5')], ME)).toBe('5')
  })

  it.each([
    ['another coin', change('0x2::sui::SUI', ME, '5')],
    ['someone else', change(WAL_TYPE, THIEF, '5')],
    ['money leaving', change(WAL_TYPE, ME, '-5')],
    ['nothing', change(WAL_TYPE, ME, '0')],
  ])('ignores %s', (_name, entry) => {
    expect(walPaid([entry], ME)).toBeUndefined()
  })
})

describe('staking', () => {
  it('stakes WAL with the picked node and keeps the StakedWal with the person', async () => {
    const { venue, built: txs } = venueOver()
    const prepared = await venue.prepare(stake('10'), ME)
    const tx = txs[0] as Transaction
    expect(calls(tx)).toEqual(['staking::stake_with_pool'])
    const data = tx.getData()
    const transfer = data.commands.find((c) => c.$kind === 'TransferObjects')
    expect(transfer).toBeDefined()
    const address = transfer?.$kind === 'TransferObjects' ? transfer.TransferObjects.address : null
    const input = address?.$kind === 'Input' ? data.inputs[address.Input] : undefined
    expect(input?.$kind).toBe('Pure')
    if (input?.$kind === 'Pure') {
      const bytes = Uint8Array.from(Buffer.from(input.Pure.bytes, 'base64'))
      expect(normalizeSuiAddress(bcs.Address.parse(bytes))).toBe(normalizeSuiAddress(ME))
    }
    expect(prepared).toMatchObject({
      venueId: 'walrus',
      kind: 'stake',
      pay: { amount: '10', symbol: 'WAL' },
      receive: { amount: '10', symbol: 'StakedWAL', approximate: false },
    })
    expect(prepared.summary).toContain('Cheap Node')
    expect(prepared.apy).toBeUndefined()
  })

  it('says which node, what it keeps, when it starts, and how to get out', async () => {
    const { venue } = venueOver()
    const { notes } = await venue.prepare(stake('10'), ME)
    const text = notes.join(' ')
    expect(text).toContain('Cheap Node')
    expect(text).toContain(normalizeSuiAddress(NODE_B))
    expect(text).toContain('7 of 1000 shards')
    expect(text).toContain('keeps 0.6% of your rewards')
    expect(text).toContain('epoch 44, about 17 Nov 2026')
    expect(text).toContain('An epoch lasts 14 days')
    expect(text).toContain('up to 28 days')
    expect(text).toContain("not a coin, so it can't be swapped")
    expect(text).toContain('not showing a rate')
    expect(text).toContain('emergency upgrade key')
  })

  it('states the later start once the next committee is chosen', async () => {
    const { venue } = venueOver({ inner: innerJson({ [NODE_A]: 26, [NODE_B]: 7 }) })
    const { notes } = await venue.prepare(stake('10'), ME)
    expect(notes.join(' ')).toContain('epoch 45')
  })

  it('refuses another token', async () => {
    const { venue, build } = venueOver()
    await expect(venue.prepare(stake('10', 'SUI'), ME)).rejects.toThrow(/takes WAL, not SUI/)
    expect(build).not.toHaveBeenCalled()
  })

  it('refuses under the protocol minimum', async () => {
    const { venue, build } = venueOver()
    await expect(venue.prepare(stake('0.5'), ME)).rejects.toThrow(/at least 1 WAL/)
    expect(build).not.toHaveBeenCalled()
  })

  it('refuses a malformed account', async () => {
    const { venue } = venueOver()
    await expect(venue.prepare(stake('10'), 'nope')).rejects.toThrow(ChainActionRefused)
  })

  it.each([
    ['a new package', { ...STAKING_JSON, package_id: FOREIGN }],
    ['a new version', { ...STAKING_JSON, version: '5' }],
    ['an upgrade under way', { ...STAKING_JSON, new_package_id: FOREIGN }],
    ['an unreadable object', {}],
  ])('stays blocked on %s', async (_name, staking) => {
    const { venue, build } = venueOver({ staking })
    await expect(venue.prepare(stake('10'), ME)).rejects.toThrow(/stays blocked/)
    await expect(venue.prepare(unstake('10'), ME)).rejects.toThrow(/stays blocked/)
    expect(build).not.toHaveBeenCalled()
  })

  it('refuses when no node can be read', async () => {
    const { venue } = venueOver({ pools: [] })
    await expect(venue.prepare(stake('10'), ME)).rejects.toThrow(/No Walrus storage node/)
  })

  it('skips a node that failed to read', async () => {
    const { venue, core } = venueOver()
    core.getObjects.mockResolvedValueOnce({
      objects: [new Error('gone'), { json: poolJson(NODE_A, 'Big Node', 6000) }],
    } as never)
    const prepared = await venue.prepare(stake('10'), ME)
    expect(prepared.summary).toContain('Big Node')
  })

  it('quotes without building, and shows no rate', async () => {
    const { venue, build } = venueOver()
    const quote = await venue.quote?.(stake('10'), ME)
    expect(quote).toEqual({ receive: { amount: '10', symbol: 'StakedWAL' } })
    expect(build).not.toHaveBeenCalled()
  })

  it('can follow a swap only into WAL', async () => {
    const { venue } = venueOver()
    await expect(
      venue.assertCanFollow?.({ kind: 'stake', tokenIn: 'WAL' }, ME)
    ).resolves.toBeUndefined()
    await expect(venue.assertCanFollow?.({ kind: 'stake', tokenIn: 'USDC' }, ME)).rejects.toThrow(
      /takes WAL/
    )
  })
})

describe('unstaking', () => {
  const ID = normalizeSuiAddress('0x51')

  it('reads positions from the wallet by type', async () => {
    const { venue, core } = venueOver({ owned: [ownedObject(ID, BigInt(10) * WAL, STAKED)] })
    await venue.prepare(unstake('10'), ME)
    expect(core.listOwnedObjects).toHaveBeenCalledWith(
      expect.objectContaining({ owner: ME, type: STAKED_WAL_TYPE })
    )
  })

  it('reads every page of positions', async () => {
    const { venue, core } = venueOver()
    core.listOwnedObjects
      .mockResolvedValueOnce({
        objects: [ownedObject(ID, BigInt(3) * WAL, STAKED)],
        hasNextPage: true,
        cursor: 'next',
      } as never)
      .mockResolvedValueOnce({
        objects: [ownedObject(normalizeSuiAddress('0x52'), BigInt(7) * WAL, STAKED)],
        hasNextPage: false,
        cursor: null,
      } as never)
    const prepared = await venue.prepare(unstake('10'), ME)
    expect(prepared.pay.amount).toBe('10')
    expect(core.listOwnedObjects).toHaveBeenCalledTimes(2)
  })

  it('refuses rather than act on part of a list it could not finish', async () => {
    const { venue, core } = venueOver()
    core.listOwnedObjects.mockResolvedValue({
      objects: [ownedObject(ID, BigInt(3) * WAL, STAKED)],
      hasNextPage: true,
      cursor: 'next',
    } as never)
    await expect(venue.prepare(unstake('1'), ME)).rejects.toThrow(/more staked WAL positions/)
  })

  it('starts a withdrawal, and says when and how to collect', async () => {
    const { venue, built: txs } = venueOver({ owned: [ownedObject(ID, BigInt(10) * WAL, STAKED)] })
    const prepared = await venue.prepare(unstake('10'), ME)
    expect(calls(txs[0] as Transaction)).toEqual(['staking::request_withdraw_stake'])
    expect(prepared).toMatchObject({ kind: 'unstake', pay: { amount: '10', symbol: 'WAL' } })
    expect(prepared.receive).toBeUndefined()
    expect(prepared.summary).toContain('epoch 44, about 17 Nov 2026')
    const text = prepared.notes.join(' ')
    expect(text).toContain("can't be cancelled")
    expect(text).toContain('say "claim my WAL"')
    expect(() => venue.assertSafe(prepared.signing, ME)).not.toThrow()
  })

  it('splits part of a position off and keeps it with the person', async () => {
    const { venue, built: txs } = venueOver({ owned: [ownedObject(ID, BigInt(10) * WAL, STAKED)] })
    const prepared = await venue.prepare(unstake('4'), ME)
    const tx = txs[0] as Transaction
    expect(calls(tx)).toEqual(['staked_wal::split', 'staking::request_withdraw_stake'])
    expect(tx.getData().commands.some((c) => c.$kind === 'TransferObjects')).toBe(true)
    expect(() => venue.assertSafe(prepared.signing, ME)).not.toThrow()
    expect(() => venue.assertSafe(prepared.signing, THIEF)).toThrow(ChainActionRefused)
  })

  it('collects after the wait, for what a dry run says comes back', async () => {
    const { venue, built: txs } = venueOver({
      owned: [ownedObject(ID, BigInt(10) * WAL, withdrawing(43))],
      simulated: {
        Transaction: {
          balanceChanges: [{ coinType: WAL_TYPE, address: ME, amount: '10250000000' }],
        },
      },
    })
    const prepared = await venue.prepare(unstake('10'), ME)
    expect(calls(txs[0] as Transaction)).toEqual(['staking::withdraw_stake'])
    expect(prepared.receive).toEqual({ amount: '10.25', symbol: 'WAL', approximate: true })
    expect(prepared.summary).toContain('Collect 10 WAL')
    expect(() => venue.assertSafe(prepared.signing, ME)).not.toThrow()
  })

  it('refuses to collect when a dry run confirms nothing', async () => {
    const { venue } = venueOver({
      owned: [ownedObject(ID, BigInt(10) * WAL, withdrawing(43))],
      simulated: { FailedTransaction: {} },
    })
    await expect(venue.prepare(unstake('10'), ME)).rejects.toThrow(/couldn't confirm how much WAL/)
  })

  it('refuses during the wait, and says when', async () => {
    const { venue, build } = venueOver({
      owned: [ownedObject(ID, BigInt(10) * WAL, withdrawing(44))],
    })
    await expect(venue.prepare(unstake('10'), ME)).rejects.toThrow(/from epoch 44/)
    expect(build).not.toHaveBeenCalled()
  })

  it('refuses a wallet with no stake', async () => {
    const { venue } = venueOver()
    await expect(venue.prepare(unstake('10'), ME)).rejects.toThrow(/no WAL staked/)
  })

  it('refuses another token', async () => {
    const { venue } = venueOver({ owned: [ownedObject(ID, BigInt(10) * WAL, STAKED)] })
    await expect(venue.prepare(unstake('10', 'USDC'), ME)).rejects.toThrow(/takes WAL, not USDC/)
  })

  it.each([
    ['an object of another type', ownedObject(ID, WAL, STAKED, NODE_A, 10, `${FOREIGN}::x::Y`)],
    ['a state it does not know', ownedObject(ID, WAL, { '@variant': 'Slashed' })],
    ['a wait with no epoch', ownedObject(ID, WAL, { '@variant': 'Withdrawing' })],
    [
      'a principal that is no number',
      { ...ownedObject(ID, WAL, STAKED), json: { principal: 'x' } },
    ],
  ])('refuses %s rather than guess', async (_name, object) => {
    const { venue, build } = venueOver({ owned: [object] })
    await expect(venue.prepare(unstake('1'), ME)).rejects.toThrow(/couldn't read/)
    expect(build).not.toHaveBeenCalled()
  })
})

const objectId = (n: number) => normalizeSuiAddress(`0x${(n + 0x100).toString(16)}`)
const EPOCH_44 = 1742914804744 + 43 * 1_209_600_000
const paysBack = (amount: string) => ({
  Transaction: { balanceChanges: [{ coinType: WAL_TYPE, address: ME, amount }] },
})

function recipients(tx: Transaction): string[] {
  const data = tx.getData()
  return data.commands.flatMap((c) => {
    if (c.$kind !== 'TransferObjects') return []
    const address = c.TransferObjects.address
    const input = address.$kind === 'Input' ? data.inputs[address.Input] : undefined
    if (input?.$kind !== 'Pure') return ['unreadable']
    const bytes = Uint8Array.from(Buffer.from(input.Pure.bytes, 'base64'))
    return [normalizeSuiAddress(bcs.Address.parse(bytes))]
  })
}

function collectedObjects(tx: Transaction): string[] {
  const data = tx.getData()
  return data.commands.flatMap((c) => {
    if (c.$kind !== 'MoveCall' || c.MoveCall.function !== 'withdraw_stake') return []
    const argument = c.MoveCall.arguments[1]
    const input = argument?.$kind === 'Input' ? data.inputs[argument.Input] : undefined
    return input?.$kind === 'Object' && input.Object.$kind === 'ImmOrOwnedObject'
      ? [input.Object.ImmOrOwnedObject.objectId]
      : ['not a whole position']
  })
}

describe('what positions report', () => {
  const held = (overrides: Partial<Position>) => position(overrides)

  it('reads nothing as empty', () => {
    expect(venuePositionsFrom([], STATE)).toEqual([])
  })

  it('adds several stakes into one figure, to the last unit', () => {
    const found = venuePositionsFrom(
      [
        held({ objectId: '0x1', principal: BigInt('1234567891') }),
        held({ objectId: '0x2', principal: BigInt('2000000000') }),
      ],
      STATE
    )
    expect(found).toEqual([{ slot: 'staked', symbol: 'WAL', amount: '3.234567891' }])
  })

  it('tells staked, ready and waiting apart by the state on chain', () => {
    const found = venuePositionsFrom(
      [
        held({ objectId: '0x1', principal: BigInt(10) * WAL }),
        held({ objectId: '0x2', principal: BigInt(3) * WAL, withdrawEpoch: 42 }),
        held({ objectId: '0x3', principal: BigInt(4) * WAL, withdrawEpoch: 43 }),
        held({ objectId: '0x4', principal: BigInt(5) * WAL, withdrawEpoch: 44 }),
        held({ objectId: '0x5', principal: BigInt(6) * WAL, withdrawEpoch: 45 }),
      ],
      STATE,
      EPOCH_44 - 5 * 3_600_000
    )
    expect(found).toEqual([
      { slot: 'staked', symbol: 'WAL', amount: '10' },
      { slot: 'claimable', symbol: 'WAL', amount: '7' },
      { slot: 'cooling', symbol: 'WAL', amount: '5', readyInHours: 5 },
      { slot: 'cooling', symbol: 'WAL', amount: '6', readyInHours: 5 + 14 * 24 },
    ])
  })

  it.each<[string, Partial<Position>]>([
    ['a stake not yet earning', { activationEpoch: 44 }],
    ['a stake with a node that has left', { nodeId: normalizeSuiAddress(GONE) }],
  ])('counts %s as staked: nobody asked to end it', (_name, overrides) => {
    expect(phaseOf(position(overrides), STATE).name).toBe('ready')
    expect(venuePositionsFrom([position(overrides)], STATE)).toEqual([
      { slot: 'staked', symbol: 'WAL', amount: '10' },
    ])
  })

  it('never says under an hour for an epoch running late', () => {
    const found = venuePositionsFrom([position({ withdrawEpoch: 44 })], STATE, EPOCH_44 + 1000)
    expect(found[0]?.readyInHours).toBe(1)
  })

  it('reads the wallet through the venue', async () => {
    const { venue } = venueOver({
      owned: [
        ownedObject(objectId(1), BigInt(10) * WAL, STAKED),
        ownedObject(objectId(2), BigInt(3) * WAL, withdrawing(43)),
      ],
    })
    expect(await venue.positions?.(ME)).toEqual([
      { slot: 'staked', symbol: 'WAL', amount: '10' },
      { slot: 'claimable', symbol: 'WAL', amount: '3' },
    ])
  })

  it('throws when the wallet can not be read, never an empty list', async () => {
    const { venue, core } = venueOver()
    core.listOwnedObjects.mockRejectedValue(new Error('rpc down'))
    await expect(venue.positions?.(ME)).rejects.toThrow('rpc down')
  })

  it('throws when the epoch can not be read', async () => {
    const { venue, core } = venueOver()
    core.getObject.mockRejectedValue(new Error('rpc down'))
    await expect(venue.positions?.(ME)).rejects.toThrow('rpc down')
  })

  it('throws on a position it does not understand', async () => {
    const { venue } = venueOver({ owned: [ownedObject(ID_A, WAL, { '@variant': 'Slashed' })] })
    await expect(venue.positions?.(ME)).rejects.toThrow(/couldn't read/)
  })

  it('throws on a list it could not finish', async () => {
    const { venue, core } = venueOver()
    core.listOwnedObjects.mockResolvedValue({
      objects: [ownedObject(ID_A, WAL, STAKED)],
      hasNextPage: true,
      cursor: 'next',
    } as never)
    await expect(venue.positions?.(ME)).rejects.toThrow(/more staked WAL positions/)
  })

  it('throws on a malformed account', async () => {
    const { venue } = venueOver()
    await expect(venue.positions?.('nope')).rejects.toThrow(ChainActionRefused)
  })
})

describe('claiming', () => {
  const claim = (tokenIn = 'WAL', amount = 'all'): ChainActionRequest => ({
    kind: 'claim',
    amount,
    tokenIn,
  })
  const ready = (id: string, wal: number) =>
    position({ objectId: id, principal: BigInt(wal) * WAL, withdrawEpoch: 43 })
  const waiting = (id: string, wal: number, epoch = 44) =>
    position({ objectId: id, principal: BigInt(wal) * WAL, withdrawEpoch: epoch })

  it('the venue says it can', () => {
    expect(venueOver().venue.kinds).toContain('claim')
  })

  it('collects every finished withdrawal, whole, and pays only the person', async () => {
    const { venue, built: txs } = venueOver({
      owned: [
        ownedObject(objectId(1), BigInt(5) * WAL, withdrawing(43)),
        ownedObject(objectId(2), BigInt(7) * WAL, withdrawing(40)),
      ],
      simulated: paysBack('12300000000'),
    })
    const prepared = await venue.prepare(claim(), ME)
    const tx = txs[0] as Transaction
    expect(calls(tx)).toEqual(['staking::withdraw_stake', 'staking::withdraw_stake'])
    expect(collectedObjects(tx).sort()).toEqual([objectId(1), objectId(2)])
    expect(recipients(tx)).toEqual([normalizeSuiAddress(ME)])
    expect(prepared).toMatchObject({
      kind: 'claim',
      pay: { amount: '12', symbol: 'WAL' },
      receive: { amount: '12.3', symbol: 'WAL', approximate: true },
    })
    expect(() => venue.assertSafe(prepared.signing, ME)).not.toThrow()
    expect(() => venue.assertSafe(prepared.signing, THIEF)).toThrow(ChainActionRefused)
  })

  it('leaves alone a stake that could leave in one step, which nobody asked to end', async () => {
    const fresh = ownedObject(objectId(1), BigInt(9) * WAL, STAKED, NODE_A, 44)
    const { venue, built: txs } = venueOver({
      owned: [fresh, ownedObject(objectId(2), BigInt(2) * WAL, withdrawing(43))],
      simulated: paysBack('2000000000'),
    })
    await venue.prepare(claim(), ME)
    expect(collectedObjects(txs[0] as Transaction)).toEqual([objectId(2)])
  })

  it('refuses a fresh stake alone, rather than undo it', async () => {
    const { venue, build } = venueOver({
      owned: [ownedObject(objectId(1), BigInt(9) * WAL, STAKED, NODE_A, 44)],
    })
    await expect(venue.prepare(claim(), ME)).rejects.toThrow(/still staked.*unstake all WAL/)
    expect(build).not.toHaveBeenCalled()
  })

  it('says what else is still on its way', async () => {
    const { venue } = venueOver({
      owned: [
        ownedObject(objectId(1), BigInt(2) * WAL, withdrawing(43)),
        ownedObject(objectId(2), BigInt(8) * WAL, withdrawing(44)),
      ],
      simulated: paysBack('2000000000'),
    })
    const { notes } = await venue.prepare(claim(), ME)
    expect(notes.join(' ')).toMatch(/Another 8 WAL is on its way out/)
  })

  it('refuses with the time left when nothing is ready', () => {
    const in3Days = EPOCH_44 - 3 * 86_400_000
    expect(() => planClaim([waiting('0x1', 10)], STATE, in3Days)).toThrow(
      /Your 10 WAL on its way out is ready in about 3 days, at epoch 44, about 17 Nov 2026.*Nothing was signed or sent/
    )
    expect(() => planClaim([waiting('0x1', 10)], STATE, EPOCH_44 - 5 * 3_600_000)).toThrow(
      /in about 5 hours/
    )
    expect(() => planClaim([waiting('0x1', 10)], STATE, EPOCH_44 - 3_600_000)).toThrow(
      /in about 1 hour,/
    )
  })

  it('names the soonest when withdrawals finish at different times', () => {
    expect(() =>
      planClaim([waiting('0x1', 10, 45), waiting('0x2', 4, 44)], STATE, EPOCH_44 - 86_400_000)
    ).toThrow(/You have 14 WAL on its way out, and the first 4 WAL is ready in about 24 hours/)
  })

  it('refuses plainly when there is nothing at all, and does not build', async () => {
    const { venue, build } = venueOver()
    await expect(venue.prepare(claim(), ME)).rejects.toThrow(
      /nothing to collect from Walrus.*Nothing was signed or sent/
    )
    expect(build).not.toHaveBeenCalled()
  })

  it('takes the largest first when one transaction cannot hold them all, and says so', async () => {
    const many = Array.from({ length: MAX_POSITIONS_PER_TRANSACTION + 2 }, (_, i) =>
      ownedObject(objectId(i), BigInt(i + 1) * WAL, withdrawing(43))
    )
    const { venue } = venueOver({ owned: many, simulated: paysBack('1000000000') })
    const { notes, pay } = await venue.prepare(claim(), ME)
    const text = notes.join(' ')
    expect(text).toContain(
      `covers ${MAX_POSITIONS_PER_TRANSACTION} of your ${MAX_POSITIONS_PER_TRANSACTION + 2} Walrus positions`
    )
    expect(text).toContain('The other 3 WAL is still waiting to be collected')
    expect(Number(pay.amount)).toBeGreaterThan(3)
    const plan = planClaim([ready('0x1', 1), ready('0x2', 9), ready('0x3', 4)], STATE)
    expect(plan.pieces.map((p) => p.position.objectId)).toEqual(['0x2', '0x3', '0x1'])
    expect(plan.pieces.every((p) => p.split === undefined)).toBe(true)
  })

  it('refuses when a dry run confirms nothing', async () => {
    const { venue } = venueOver({
      owned: [ownedObject(objectId(1), WAL, withdrawing(43))],
      simulated: { FailedTransaction: {} },
    })
    await expect(venue.prepare(claim(), ME)).rejects.toThrow(/couldn't confirm how much WAL/)
  })

  it('refuses a set amount, since it takes everything ready', async () => {
    const { venue, build } = venueOver({ owned: [ownedObject(objectId(1), WAL, withdrawing(43))] })
    await expect(venue.prepare(claim('WAL', '1'), ME)).rejects.toThrow(/not a set amount/)
    expect(build).not.toHaveBeenCalled()
  })

  it('refuses another token, and says SUI from an unstake needs no claim', async () => {
    const { venue } = venueOver()
    await expect(venue.prepare(claim('USDC'), ME)).rejects.toThrow(/pays WAL, not USDC/)
    await expect(venue.prepare(claim('SUI'), ME)).rejects.toThrow(/by itself.*nothing to claim/)
  })

  it('stays blocked on an upgrade', async () => {
    const { venue, build } = venueOver({ staking: { ...STAKING_JSON, version: '5' } })
    await expect(venue.prepare(claim(), ME)).rejects.toThrow(/stays blocked/)
    expect(build).not.toHaveBeenCalled()
  })

  it('still collects when asked to unstake again, as the first card once said', async () => {
    const { venue, built: txs } = venueOver({
      owned: [ownedObject(objectId(1), BigInt(10) * WAL, withdrawing(43))],
      simulated: paysBack('10000000000'),
    })
    const prepared = await venue.prepare(unstake('10'), ME)
    expect(prepared.kind).toBe('unstake')
    expect(calls(txs[0] as Transaction)).toEqual(['staking::withdraw_stake'])
  })
})

describe('unstaking all of it', () => {
  const whole = (amount = '1'): ChainActionRequest => ({
    kind: 'unstake',
    amount,
    wholePosition: true,
    tokenIn: 'WAL',
  })

  it('starts a withdrawal of every stake in one transaction, splitting none', async () => {
    const { venue, built: txs } = venueOver({
      owned: [
        ownedObject(objectId(1), BigInt(2) * WAL, STAKED),
        ownedObject(objectId(2), BigInt(7) * WAL, STAKED),
        ownedObject(objectId(3), BigInt(3) * WAL, STAKED),
      ],
    })
    const prepared = await venue.prepare(whole('12'), ME)
    expect(calls(txs[0] as Transaction)).toEqual([
      'staking::request_withdraw_stake',
      'staking::request_withdraw_stake',
      'staking::request_withdraw_stake',
    ])
    expect(prepared.kind).toBe('unstake')
    expect(prepared.pay).toEqual({ amount: '12', symbol: 'WAL' })
    expect(prepared.receive).toBeUndefined()
    expect(prepared.summary).toContain('Start unstaking 12 WAL')
    expect(prepared.summary).toContain('epoch 44')
    expect(prepared.notes.join(' ')).not.toContain('covers')
    expect(() => venue.assertSafe(prepared.signing, ME)).not.toThrow()
  })

  it('uses what it reads now, not the figure it was handed', async () => {
    const { venue } = venueOver({ owned: [ownedObject(objectId(1), BigInt(5) * WAL, STAKED)] })
    const prepared = await venue.prepare(whole('1'), ME)
    expect(prepared.pay.amount).toBe('5')
  })

  it('does not stop at what is ready, as a plain amount would', async () => {
    const { venue, built: txs } = venueOver({
      owned: [
        ownedObject(objectId(1), BigInt(60) * WAL, withdrawing(43)),
        ownedObject(objectId(2), BigInt(50) * WAL, STAKED),
      ],
      simulated: paysBack('60000000000'),
    })
    const prepared = await venue.prepare(whole('50'), ME)
    const tx = txs[0] as Transaction
    expect(calls(tx)).toEqual(['staking::withdraw_stake', 'staking::request_withdraw_stake'])
    expect(recipients(tx)).toEqual([normalizeSuiAddress(ME)])
    expect(prepared.pay.amount).toBe('110')
    expect(prepared.receive).toEqual({ amount: '60', symbol: 'WAL', approximate: true })
    expect(prepared.summary).toMatch(/Collect 60 WAL.*now.*start unstaking 50 WAL/)
    expect(() => venue.assertSafe(prepared.signing, ME)).not.toThrow()
  })

  it('takes a stake that can leave in one step straight out', async () => {
    const { venue, built: txs } = venueOver({
      owned: [ownedObject(objectId(1), BigInt(9) * WAL, STAKED, NODE_A, 44)],
      simulated: paysBack('9000000000'),
    })
    const prepared = await venue.prepare(whole('9'), ME)
    expect(calls(txs[0] as Transaction)).toEqual(['staking::withdraw_stake'])
    expect(prepared.receive?.amount).toBe('9')
  })

  it('leaves what is already on its way, and says so', async () => {
    const { venue, built: txs } = venueOver({
      owned: [
        ownedObject(objectId(1), BigInt(5) * WAL, withdrawing(44)),
        ownedObject(objectId(2), BigInt(50) * WAL, STAKED),
      ],
    })
    const prepared = await venue.prepare(whole('50'), ME)
    expect(calls(txs[0] as Transaction)).toEqual(['staking::request_withdraw_stake'])
    expect(prepared.pay.amount).toBe('50')
    expect(prepared.notes.join(' ')).toContain('5 WAL is already on its way out')
  })

  it('refuses when all of it is already on its way, and says when', async () => {
    const { venue, build } = venueOver({ owned: [ownedObject(objectId(1), WAL, withdrawing(44))] })
    await expect(venue.prepare(whole(), ME)).rejects.toThrow(/already on its way out.*epoch 44/)
    expect(build).not.toHaveBeenCalled()
  })

  it('refuses when there is nothing', async () => {
    const { venue } = venueOver()
    await expect(venue.prepare(whole(), ME)).rejects.toThrow(/no WAL staked/)
  })

  it('says clearly what it covered when one transaction cannot hold them all', () => {
    const many = Array.from({ length: MAX_POSITIONS_PER_TRANSACTION + 3 }, (_, i) =>
      position({ objectId: objectId(i), principal: WAL + BigInt(i) })
    )
    const plan = planWholeUnstake(many, STATE)
    expect(plan.start).toHaveLength(MAX_POSITIONS_PER_TRANSACTION)
    expect(plan.left.count).toBe(3)
    expect(plan.left.total).toBe(BigInt(3) * WAL + BigInt(3))
  })

  it('names the cover on the card', async () => {
    const many = Array.from({ length: MAX_POSITIONS_PER_TRANSACTION + 1 }, (_, i) =>
      ownedObject(objectId(i), WAL, STAKED)
    )
    const { venue } = venueOver({ owned: many })
    const { notes } = await venue.prepare(whole(), ME)
    expect(notes.join(' ')).toContain(
      `covers ${MAX_POSITIONS_PER_TRANSACTION} of your ${MAX_POSITIONS_PER_TRANSACTION + 1} Walrus positions. The other 1 WAL is not touched by this`
    )
  })

  it('keeps what is ready when not everything fits', () => {
    const many = [
      ...Array.from({ length: MAX_POSITIONS_PER_TRANSACTION }, (_, i) =>
        position({ objectId: objectId(i), principal: BigInt(9) * WAL })
      ),
      position({ objectId: objectId(9000), principal: WAL, withdrawEpoch: 43 }),
    ]
    const plan = planWholeUnstake(many, STATE)
    expect(plan.collect).toHaveLength(1)
    expect(plan.start).toHaveLength(MAX_POSITIONS_PER_TRANSACTION - 1)
  })

  it('refuses a tampered copy that pays someone else', async () => {
    const transaction = await built((tx) => {
      tx.moveCall({ target: REQUEST, arguments: [stakingRef(tx), ownedRef(tx, '0x51')] })
      const [coin] = tx.moveCall({
        target: WITHDRAW,
        arguments: [stakingRef(tx), ownedRef(tx, '0x52')],
      })
      tx.transferObjects([coin as never], THIEF)
    })
    expect(() => check(transaction)).toThrow(/send funds to another address/)
  })
})

describe('through the same route the app uses', () => {
  function moduleOver(chain: FakeChain): ChainModule {
    const { venue } = venueOver(chain)
    const stakingOnly = {
      id: 'other',
      name: 'Other',
      kinds: ['stake', 'unstake'],
      positions: async () => [],
      prepare: async () => {
        throw new Error('went to the wrong venue')
      },
      assertSafe: () => undefined,
    } as unknown as ChainVenue
    return {
      chain: 'sui',
      tokens: WALRUS_TOKENS,
      venues: [stakingOnly, venue],
      defaultVenue: { unstake: 'other' },
      priceUsd: async () => 1,
      submit: async () => ({ ok: true, hash: 'h', explorerUrl: 'u' }),
      balances: async () => ({ tokens: [], complete: true }),
    } as unknown as ChainModule
  }

  it('"claim my WAL" reaches Walrus and collects', async () => {
    const asked = parseChainAction('claim my WAL') as ChainActionRequest
    const prepared = await prepareChainAction(
      moduleOver({
        owned: [ownedObject(objectId(1), BigInt(3) * WAL, withdrawing(43))],
        simulated: paysBack('3000000000'),
      }),
      asked,
      ME
    )
    expect(prepared).toMatchObject({ venueId: 'walrus', kind: 'claim', pay: { amount: '3' } })
  })

  it('"unstake all WAL" finds Walrus and starts all of it', async () => {
    const asked = parseChainAction('unstake all WAL') as ChainActionRequest
    const prepared = await prepareChainAction(
      moduleOver({
        owned: [
          ownedObject(objectId(1), BigInt(3) * WAL, STAKED),
          ownedObject(objectId(2), BigInt(4) * WAL, STAKED),
        ],
      }),
      asked,
      ME
    )
    expect(prepared).toMatchObject({ venueId: 'walrus', kind: 'unstake', pay: { amount: '7' } })
    expect(prepared.summary).toContain('Start unstaking 7 WAL')
  })

  it('"unstake 10 WAL" with a venue named still collects a finished withdrawal', async () => {
    const asked = parseChainAction('unstake 10 WAL from Walrus') as ChainActionRequest
    const prepared = await prepareChainAction(
      moduleOver({
        owned: [ownedObject(objectId(1), BigInt(10) * WAL, withdrawing(43))],
        simulated: paysBack('10000000000'),
      }),
      asked,
      ME
    )
    expect(prepared.summary).toContain('Collect 10 WAL')
  })
})

describe('what the app shows', () => {
  it('lists WAL as verified, with its decimals', () => {
    expect(WALRUS_TOKENS).toEqual([{ symbol: 'WAL', id: WAL_TYPE, decimals: 9, name: 'Walrus' }])
  })

  it('lists the venue as executing, with a logo', () => {
    expect(walrusListing).toMatchObject({
      id: 'walrus',
      family: 'sui',
      integration: 'executes',
      category: 'staking',
    })
    expect(existsSync(join(process.cwd(), 'public/images/venues/walrus.webp'))).toBe(true)
  })
})
