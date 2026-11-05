import { bcs } from '@mysten/sui/bcs'
import { coinWithBalance, Transaction } from '@mysten/sui/transactions'
import {
  deriveDynamicFieldID,
  fromBase64,
  normalizeStructTag,
  normalizeSuiAddress,
} from '@mysten/sui/utils'

import {
  ChainActionRefused,
  takesOnly,
  toBaseUnits,
  type ChainActionRequest,
  type ChainToken,
  type ChainVenue,
  type PreparedAction,
  type SigningPayload,
  type VenueQuote,
} from '../types'
import { assertSuiAccount, buildUnsigned, suiClient, withTimeout } from './client'
import { assertPtbSafe, moveTarget, type ParsedCall, type PtbPolicy, type ReadPure } from './safety'
import { displayAmount } from './tokens'

/**
 * The shared staking object, as `staking_object` in MystenLabs/walrus
 * setup/client_config_mainnet.yaml and on docs.wal.app/docs/usage/networks. On chain it is
 * shared, with this initial version and the type below.
 */
export const WALRUS_STAKING = '0x10b9d30c28448939ce6c4d6c6e0ffce4a7f8a4ada8248bdad09ef8b70e4a3904'
const WALRUS_STAKING_SHARED_VERSION = '317862159'

/**
 * The live package: `published-at` in MystenLabs/walrus mainnet-contracts/walrus/Published.toml,
 * version 4. The staking object's own `package_id` names the same one. Types keep the original id
 * from that file. `prepare` reads the staking object first, so an upgrade blocks this venue.
 */
export const WALRUS_PACKAGE = '0xa9ac4281c72b0ed3277c08e821ab77eccea7b187f2b402ffa3b33f548d4bbf1e'
export const WALRUS_ORIGINAL_PACKAGE =
  '0xfdc88f7d7cf30afab2f82e8380d11ee8f70efb90e863d1de8616fae1bb09ea77'
export const WALRUS_VERSION = '4'

/**
 * The WAL package on docs.wal.app/docs/usage/networks. Its coin metadata on chain reads symbol WAL,
 * name "WAL Token", 9 decimals, and `stake_with_pool` takes a `Coin` of exactly this type.
 */
export const WAL_TYPE =
  '0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL'
const WAL_DECIMALS = 9

export const WALRUS_TOKENS: ChainToken[] = [
  { symbol: 'WAL', id: WAL_TYPE, decimals: WAL_DECIMALS, name: 'Walrus' },
]

export const STAKED_WAL_TYPE = `${WALRUS_ORIGINAL_PACKAGE}::staked_wal::StakedWal`

const STAKE = moveTarget(WALRUS_PACKAGE, 'staking', 'stake_with_pool')
const REQUEST_WITHDRAW = moveTarget(WALRUS_PACKAGE, 'staking', 'request_withdraw_stake')
const WITHDRAW = moveTarget(WALRUS_PACKAGE, 'staking', 'withdraw_stake')
const SPLIT = moveTarget(WALRUS_PACKAGE, 'staked_wal', 'split')

/** Arguments each call takes in a transaction, signatures read on chain. `TxContext` isn't one. */
const ARGUMENT_COUNTS: ReadonlyMap<string, number> = new Map([
  [STAKE, 3],
  [REQUEST_WITHDRAW, 2],
  [WITHDRAW, 2],
  [SPLIT, 2],
])

/** `MIN_STAKING_THRESHOLD` in staked_wal.move. It also binds both sides of a split. */
const MIN_STAKE = BigInt('1000000000')

/** 0.5% of the network's 1,000 shards, so the pick isn't a node about to leave the committee. */
const MIN_NODE_SHARDS = 5
const BPS_PER_PERCENT = 100
/** A node's name is whatever its operator typed, and it goes on the card. */
const SAFE_NODE_NAME = /^[\p{L}\p{N} .,|()&'_-]{1,64}$/u
const DAY_MS = 86_400_000
const READ_TIMEOUT_MS = 10_000
const DRY_RUN_TIMEOUT_MS = 15_000
const OWNED_PAGE_SIZE = 50
const OWNED_MAX_PAGES = 10

const NOTHING_SENT = 'Nothing was signed or sent.'

function refuse(reason: string): never {
  throw new ChainActionRefused(`${reason} ${NOTHING_SENT}`)
}

function unreadable(): never {
  return refuse("I couldn't read Walrus's staking state, so I stopped. Try again shortly.")
}

function checkCall(call: ParsedCall, read: ReadPure): void {
  const expected = ARGUMENT_COUNTS.get(call.target)
  if (expected === undefined) return
  if (call.typeArguments.length > 0 || call.arguments.length !== expected) {
    refuse('This transaction does not match the Walrus call it names.')
  }
  try {
    if (call.target === STAKE) {
      const node = read(call.arguments[2])
      if (node?.length !== 32) refuse('This stake does not name a storage node.')
    }
    if (call.target === SPLIT) {
      const amount = read(call.arguments[1])
      if (amount?.length !== 8 || BigInt(bcs.u64().parse(amount)) === BigInt(0)) {
        refuse('This split does not name an amount.')
      }
    }
  } catch (e) {
    if (e instanceof ChainActionRefused) throw e
    refuse('This transaction does not match the Walrus call it names.')
  }
}

/** Only the exact staking calls. `join`, the node operator calls and anything else are refused. */
export const WALRUS_POLICY: PtbPolicy = {
  venueName: 'Walrus',
  allowedCalls: new Set(ARGUMENT_COUNTS.keys()),
  checkCall,
}

/**
 * `checkCall` sees only literal arguments, so the staking object is checked here, on the bytes.
 * Everything else that can move funds, a StakedWal included, has to pass `assertPtbSafe`: a
 * transfer to anyone but the account is refused and `public_transfer` isn't an allowed call.
 */
export function assertWalrusSafe(payload: SigningPayload, account: string): void {
  assertPtbSafe(payload, account, WALRUS_POLICY)
  if (payload.family !== 'sui') return
  const data = Transaction.from(fromBase64(payload.transaction)).getData()
  const staking = normalizeSuiAddress(WALRUS_STAKING)
  for (const command of data.commands) {
    if (command.$kind !== 'MoveCall' || command.MoveCall.module !== 'staking') continue
    const first = command.MoveCall.arguments[0]
    const input = first?.$kind === 'Input' ? data.inputs[first.Input] : undefined
    const object = input?.$kind === 'Object' ? input.Object : undefined
    const id = object?.$kind === 'SharedObject' ? object.SharedObject.objectId : undefined
    if (id === undefined || normalizeSuiAddress(id) !== staking) {
      refuse('This transaction uses a staking object other than the Walrus one.')
    }
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

function wholeNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : undefined
  return typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : undefined
}

function variantOf(value: unknown): string | undefined {
  const variant = record(value)?.['@variant']
  return typeof variant === 'string' ? variant : undefined
}

/** A `VecMap` as Sui's JSON gives it, wrapped in the single field of a Move tuple struct. */
function entriesOf(value: unknown): Record<string, unknown>[] | undefined {
  const contents = record(record(value)?.['pos0'])?.['contents']
  if (!Array.isArray(contents)) return undefined
  const entries = contents.map(record)
  return entries.every((e) => e !== undefined) ? (entries as Record<string, unknown>[]) : undefined
}

function committeeFrom(value: unknown): ReadonlyMap<string, number> | undefined {
  const entries = entriesOf(value)
  if (entries === undefined) return undefined
  const committee = new Map<string, number>()
  for (const entry of entries) {
    const shards = entry['value']
    if (typeof entry['key'] !== 'string' || !Array.isArray(shards)) return undefined
    committee.set(normalizeSuiAddress(entry['key']), shards.length)
  }
  return committee
}

export interface StakingState {
  epoch: number
  epochDurationMs: number
  firstEpochStartMs: number
  shardCount: number
  /** Node id to shards held. */
  committee: ReadonlyMap<string, number>
  /** Chosen halfway through an epoch, and absent until then. */
  nextCommittee: ReadonlyMap<string, number> | undefined
}

export function stakingStateFrom(json: unknown): StakingState {
  const value = record(record(json)?.['value'])
  const epoch = wholeNumber(value?.['epoch'])
  const epochDurationMs = wholeNumber(value?.['epoch_duration'])
  const firstEpochStartMs = wholeNumber(value?.['first_epoch_start'])
  const shardCount = wholeNumber(value?.['n_shards'])
  const committee = committeeFrom(value?.['committee'])
  const next = value?.['next_committee']
  const nextCommittee = next === null ? undefined : committeeFrom(next)
  if (
    epoch === undefined ||
    epochDurationMs === undefined ||
    epochDurationMs <= 0 ||
    firstEpochStartMs === undefined ||
    shardCount === undefined ||
    committee === undefined ||
    (next !== null && nextCommittee === undefined)
  ) {
    return unreadable()
  }
  return { epoch, epochDurationMs, firstEpochStartMs, shardCount, committee, nextCommittee }
}

function epochDate(state: StakingState, epoch: number): string {
  const startsAt = state.firstEpochStartMs + (epoch - 1) * state.epochDurationMs
  return new Date(startsAt).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

export interface StorageNode {
  id: string
  name: string
  shards: number
  commissionBps: number
}

/** What the pool's own object says, or nothing if any of it can't be trusted. */
function nodeFrom(
  json: unknown,
  state: StakingState
): (StorageNode & { worstCommissionBps: number }) | undefined {
  const pool = record(json)
  const rawId = pool?.['id']
  if (typeof rawId !== 'string' || variantOf(pool?.['state']) !== 'Active') return undefined
  const id = normalizeSuiAddress(rawId)
  const name = record(pool?.['node_info'])?.['name']
  const shards = state.committee.get(id)
  const commissionBps = wholeNumber(pool?.['commission_rate'])
  const pending = entriesOf(pool?.['pending_commission_rate'])
  if (typeof name !== 'string' || !SAFE_NODE_NAME.test(name) || shards === undefined)
    return undefined
  if (commissionBps === undefined || commissionBps > 100 * BPS_PER_PERCENT) return undefined
  if (pending === undefined) return undefined
  const rates = pending.map((p) => wholeNumber(p['value']))
  if (rates.some((r) => r === undefined)) return undefined
  const worstCommissionBps = Math.max(commissionBps, ...(rates as number[]))
  return { id, name, shards, commissionBps, worstCommissionBps }
}

/**
 * The rule: among active nodes in this epoch's committee, and the next one once chosen, holding at
 * least 5 shards, the lowest commission counting any rise already announced. Then the most shards,
 * then the lowest id, so the same chain state always gives the same node.
 */
export function pickNode(pools: readonly unknown[], state: StakingState): StorageNode {
  const candidates = pools
    .map((pool) => nodeFrom(pool, state))
    .filter((n) => n !== undefined)
    .filter(
      (n) =>
        n.shards >= MIN_NODE_SHARDS &&
        (state.nextCommittee === undefined || state.nextCommittee.has(n.id))
    )
    .sort(
      (a, b) =>
        a.worstCommissionBps - b.worstCommissionBps ||
        b.shards - a.shards ||
        a.id.localeCompare(b.id)
    )
  const best = candidates[0]
  if (best === undefined) {
    return refuse('No Walrus storage node passed my checks right now. Try again shortly.')
  }
  return { id: best.id, name: best.name, shards: best.shards, commissionBps: best.commissionBps }
}

export interface Position {
  objectId: string
  version: string
  digest: string
  nodeId: string
  principal: bigint
  activationEpoch: number
  /** Set once a withdrawal has started. */
  withdrawEpoch: number | undefined
}

function positionFrom(object: {
  objectId: string
  version: string
  digest: string
  type: string
  json?: unknown
}): Position {
  const json = record(object.json)
  const nodeId = json?.['node_id']
  const principal = json?.['principal']
  const activationEpoch = wholeNumber(json?.['activation_epoch'])
  const stateName = variantOf(json?.['state'])
  const withdrawEpoch = wholeNumber(record(json?.['state'])?.['withdraw_epoch'])
  if (
    normalizeStructTag(object.type) !== normalizeStructTag(STAKED_WAL_TYPE) ||
    typeof nodeId !== 'string' ||
    typeof principal !== 'string' ||
    !/^\d+$/.test(principal) ||
    activationEpoch === undefined ||
    (stateName !== 'Staked' && stateName !== 'Withdrawing') ||
    (stateName === 'Withdrawing' && withdrawEpoch === undefined)
  ) {
    return unreadable()
  }
  return {
    objectId: object.objectId,
    version: object.version,
    digest: object.digest,
    nodeId: normalizeSuiAddress(nodeId),
    principal: BigInt(principal),
    activationEpoch,
    withdrawEpoch: stateName === 'Withdrawing' ? withdrawEpoch : undefined,
  }
}

type Phase =
  | { name: 'ready' }
  | { name: 'waiting'; epoch: number }
  | { name: 'active'; withdrawEpoch: number }

/** `can_withdraw_early`, `request_withdraw_stake` and `withdraw_stake`, from the Move source. */
export function phaseOf(position: Position, state: StakingState): Phase {
  if (position.withdrawEpoch !== undefined) {
    return position.withdrawEpoch <= state.epoch
      ? { name: 'ready' }
      : { name: 'waiting', epoch: position.withdrawEpoch }
  }
  const inNext = state.nextCommittee?.has(position.nodeId) === true
  const inCurrent = state.committee.has(position.nodeId)
  const activation = position.activationEpoch
  const early = activation === state.epoch + 2 || (activation === state.epoch + 1 && !inNext)
  if (early || (!inCurrent && !inNext)) return { name: 'ready' }
  if (activation === state.epoch + 1) return { name: 'active', withdrawEpoch: activation + 1 }
  return { name: 'active', withdrawEpoch: inNext ? state.epoch + 2 : state.epoch + 1 }
}

function wal(base: bigint): string {
  return displayAmount(base.toString(), WAL_DECIMALS, WAL_DECIMALS)
}

interface Piece {
  position: Position
  /** Set when only part of the position is taken. */
  split: bigint | undefined
}

function sum(positions: readonly Position[]): bigint {
  return positions.reduce((total, p) => total + p.principal, BigInt(0))
}

/** Largest first, so the fewest objects move and the last one is split as little as possible. */
function takePieces(positions: readonly Position[], target: bigint): Piece[] {
  const pieces: Piece[] = []
  let remaining = target
  const ordered = [...positions].sort((a, b) =>
    a.principal === b.principal
      ? a.objectId.localeCompare(b.objectId)
      : a.principal > b.principal
        ? -1
        : 1
  )
  for (const position of ordered) {
    if (remaining === BigInt(0)) break
    if (position.principal <= remaining) {
      pieces.push({ position, split: undefined })
      remaining -= position.principal
      continue
    }
    if (remaining < MIN_STAKE || position.principal - remaining < MIN_STAKE) {
      refuse(
        `Walrus can't split a stake so that either side is under 1 WAL, and ${wal(target)} WAL would need that. Try a different amount.`
      )
    }
    pieces.push({ position, split: remaining })
    remaining = BigInt(0)
  }
  return pieces
}

export type UnstakePlan =
  | { step: 'collect'; pieces: Piece[]; total: bigint }
  | { step: 'start'; pieces: Piece[]; total: bigint; waiting: bigint; collectEpoch: number }

/**
 * An unstake takes two transactions, a wait apart. So what a request means depends on what the
 * person already holds: asking again after the wait must collect, and asking again during it must
 * not start a second withdrawal of the same money.
 */
export function planUnstake(
  positions: readonly Position[],
  state: StakingState,
  amount: bigint
): UnstakePlan {
  const ready: Position[] = []
  const waiting: Position[] = []
  const active: Position[] = []
  const collectEpochs = new Map<Position, number>()
  for (const position of positions) {
    const phase = phaseOf(position, state)
    if (phase.name === 'ready') ready.push(position)
    if (phase.name === 'waiting') {
      waiting.push(position)
      collectEpochs.set(position, phase.epoch)
    }
    if (phase.name === 'active') {
      active.push(position)
      collectEpochs.set(position, phase.withdrawEpoch)
    }
  }
  const latestEpoch = (held: readonly Position[]): number =>
    Math.max(...held.map((p) => collectEpochs.get(p) ?? state.epoch))

  const readyTotal = sum(ready)
  const waitingTotal = sum(waiting)
  const activeTotal = sum(active)

  if (readyTotal + waitingTotal + activeTotal === BigInt(0)) {
    return refuse('This wallet has no WAL staked with Walrus.')
  }
  if (amount <= readyTotal) {
    return { step: 'collect', pieces: takePieces(ready, amount), total: amount }
  }
  if (readyTotal > BigInt(0)) {
    return refuse(
      `${wal(readyTotal)} WAL is ready to collect now, which is less than you asked for. Try "unstake ${wal(readyTotal)} WAL" first.`
    )
  }
  if (amount <= waitingTotal) {
    const epoch = latestEpoch(waiting)
    return refuse(
      `${wal(waitingTotal)} WAL is already on its way out. You can collect it from epoch ${epoch}, about ${epochDate(state, epoch)}.`
    )
  }
  const toStart = amount - waitingTotal
  if (toStart > activeTotal) {
    return refuse(
      `You have ${wal(activeTotal + waitingTotal)} WAL staked with Walrus, which is less than ${wal(amount)}.`
    )
  }
  const pieces = takePieces(active, toStart)
  return {
    step: 'start',
    pieces,
    total: toStart,
    waiting: waitingTotal,
    collectEpoch: latestEpoch(pieces.map((p) => p.position)),
  }
}

/** How much WAL a dry run paid this account, in base units. */
export function walPaid(
  changes: readonly { coinType: string; address: string; amount: string }[] | undefined,
  account: string
): string | undefined {
  const paid = changes?.find(
    (c) =>
      normalizeStructTag(c.coinType) === normalizeStructTag(WAL_TYPE) &&
      normalizeSuiAddress(c.address) === normalizeSuiAddress(account)
  )
  return paid !== undefined && /^\d+$/.test(paid.amount) && BigInt(paid.amount) > BigInt(0)
    ? paid.amount
    : undefined
}

export interface WalrusDeps {
  client: () => ReturnType<typeof suiClient>
  build: typeof buildUnsigned
}

type Client = ReturnType<typeof suiClient>

/** The upgrade check comes first, so a new package refuses in plain words, not a failed dry run. */
async function readStakingState(client: Client): Promise<StakingState> {
  const { object } = await withTimeout(
    client.core.getObject({ objectId: WALRUS_STAKING, include: { json: true } }),
    READ_TIMEOUT_MS,
    "Reading Walrus's staking object"
  )
  const staking = record(object.json)
  const packageId = staking?.['package_id']
  if (
    typeof packageId !== 'string' ||
    normalizeSuiAddress(packageId) !== normalizeSuiAddress(WALRUS_PACKAGE) ||
    staking?.['version'] !== WALRUS_VERSION ||
    staking?.['new_package_id'] !== null
  ) {
    return refuse(
      'Walrus has upgraded its contracts, or is about to. This stays blocked until the new ones are checked.'
    )
  }
  const inner = await withTimeout(
    client.core.getObject({
      objectId: deriveDynamicFieldID(
        WALRUS_STAKING,
        'u64',
        bcs.u64().serialize(WALRUS_VERSION).toBytes()
      ),
      include: { json: true },
    }),
    READ_TIMEOUT_MS,
    "Reading Walrus's epoch"
  )
  return stakingStateFrom(inner.object.json)
}

async function readNode(client: Client, state: StakingState): Promise<StorageNode> {
  const { objects } = await withTimeout(
    client.core.getObjects({ objectIds: [...state.committee.keys()], include: { json: true } }),
    READ_TIMEOUT_MS,
    "Reading Walrus's storage nodes"
  )
  return pickNode(
    objects.flatMap((o) => (o instanceof Error ? [] : [o.json])),
    state
  )
}

async function readPositions(client: Client, account: string): Promise<Position[]> {
  const positions: Position[] = []
  let cursor: string | null = null
  for (let page = 0; page < OWNED_MAX_PAGES; page += 1) {
    const listed: Awaited<ReturnType<Client['core']['listOwnedObjects']>> = await withTimeout(
      client.core.listOwnedObjects({
        owner: account,
        type: STAKED_WAL_TYPE,
        limit: OWNED_PAGE_SIZE,
        cursor,
        include: { json: true },
      }),
      READ_TIMEOUT_MS,
      'Reading your staked WAL'
    )
    positions.push(...listed.objects.map(positionFrom))
    if (!listed.hasNextPage) return positions
    cursor = listed.cursor
  }
  return refuse('This wallet holds more staked WAL positions than I can read at once.')
}

function assertTakesWal(tokenIn: string): void {
  if (tokenIn.trim().toUpperCase() !== 'WAL') {
    refuse(`Walrus takes WAL, not ${tokenIn}. Try "stake 10 WAL with Walrus".`)
  }
}

function stakingArgument(tx: Transaction) {
  return tx.sharedObjectRef({
    objectId: WALRUS_STAKING,
    initialSharedVersion: WALRUS_STAKING_SHARED_VERSION,
    mutable: true,
  })
}

function positionArgument(tx: Transaction, position: Position) {
  return tx.objectRef({
    objectId: position.objectId,
    version: position.version,
    digest: position.digest,
  })
}

function splitOff(tx: Transaction, position: Position, amount: bigint) {
  const [part] = tx.moveCall({
    target: SPLIT,
    arguments: [positionArgument(tx, position), tx.pure.u64(amount)],
  })
  if (part === undefined) throw new Error('Splitting a stake returned nothing.')
  return part
}

function buildStake(amount: string, nodeId: string, account: string): Transaction {
  const tx = new Transaction()
  tx.setSender(account)
  const coin = tx.add(
    coinWithBalance({ type: WAL_TYPE, balance: BigInt(amount), useGasCoin: false })
  )
  const [staked] = tx.moveCall({
    target: STAKE,
    arguments: [stakingArgument(tx), coin, tx.pure.id(nodeId)],
  })
  if (staked === undefined) throw new Error('Staking returned nothing.')
  tx.transferObjects([staked], account)
  return tx
}

function buildCollect(pieces: readonly Piece[], account: string): Transaction {
  const tx = new Transaction()
  tx.setSender(account)
  const coins = pieces.map(({ position, split }) => {
    const stake =
      split === undefined ? positionArgument(tx, position) : splitOff(tx, position, split)
    const [coin] = tx.moveCall({ target: WITHDRAW, arguments: [stakingArgument(tx), stake] })
    if (coin === undefined) throw new Error('Withdrawing returned nothing.')
    return coin
  })
  tx.transferObjects(coins, account)
  return tx
}

function buildStart(pieces: readonly Piece[], account: string): Transaction {
  const tx = new Transaction()
  tx.setSender(account)
  for (const { position, split } of pieces) {
    const stake =
      split === undefined ? positionArgument(tx, position) : splitOff(tx, position, split)
    tx.moveCall({ target: REQUEST_WITHDRAW, arguments: [stakingArgument(tx), stake] })
    // A whole position stays where it is. A part split off is new, so it must go to its owner.
    if (split !== undefined) tx.transferObjects([stake], account)
  }
  return tx
}

const UPGRADE_NOTE =
  "Your WAL sits in Walrus's contracts, which can fail. They can be upgraded by a quorum of storage nodes or by one emergency upgrade key, and an upgrade can pause this route until the new contracts are checked."

export function createWalrusVenue(
  deps: WalrusDeps = { client: () => suiClient(), build: buildUnsigned }
): ChainVenue {
  async function checkedStake(request: ChainActionRequest, account: string) {
    assertSuiAccount(account)
    assertTakesWal(request.tokenIn)
    const amount = toBaseUnits(request.amount, WAL_DECIMALS)
    if (BigInt(amount) < MIN_STAKE) refuse('Walrus takes a stake of at least 1 WAL.')
    const client = deps.client()
    const state = await readStakingState(client)
    const node = await readNode(client, state)
    return { amount, client, state, node }
  }

  async function prepareStake(
    request: ChainActionRequest,
    account: string
  ): Promise<PreparedAction> {
    const { amount, client, state, node } = await checkedStake(request, account)
    const transaction = await deps.build(buildStake(amount, node.id, account), client, 'WAL')
    const activation = state.nextCommittee === undefined ? state.epoch + 1 : state.epoch + 2
    const epochDays = state.epochDurationMs / DAY_MS
    return {
      venueId: 'walrus',
      venueName: 'Walrus',
      kind: 'stake',
      summary: `Stake ${request.amount} WAL with ${node.name}, a Walrus storage node.`,
      pay: { amount: request.amount, symbol: 'WAL' },
      receive: { amount: request.amount, symbol: 'StakedWAL', approximate: false },
      notes: [
        `Your stake goes to ${node.name}, a node in the current Walrus committee holding ${node.shards} of ${state.shardCount} shards. Its operator chose that name, and its id is ${node.id}. I pick the committee node with at least ${MIN_NODE_SHARDS} shards that keeps the lowest commission.`,
        `${node.name} keeps ${node.commissionBps / BPS_PER_PERCENT}% of your rewards as commission today. A node can raise that with at least one epoch's notice.`,
        'Rewards are not guaranteed. I am not showing a rate because I do not read one from Walrus here.',
        `It starts earning at epoch ${activation}, about ${epochDate(state, activation)}. An epoch lasts ${epochDays} days.`,
        `You get a StakedWAL object in your wallet, not a coin, so it can't be swapped. Whoever holds it can collect the WAL, so don't send it to anyone.`,
        `To get out, ask to unstake. That starts a withdrawal, which takes one to two epochs (up to ${epochDays * 2} days) and can't be cancelled. Then ask again to collect your WAL and rewards.`,
        UPGRADE_NOTE,
      ],
      signing: { family: 'sui', transaction },
    }
  }

  async function prepareUnstake(
    request: ChainActionRequest,
    account: string
  ): Promise<PreparedAction> {
    assertSuiAccount(account)
    assertTakesWal(request.tokenIn)
    const amount = BigInt(toBaseUnits(request.amount, WAL_DECIMALS))
    const client = deps.client()
    const state = await readStakingState(client)
    const plan = planUnstake(await readPositions(client, account), state, amount)

    if (plan.step === 'collect') {
      const transaction = await deps.build(buildCollect(plan.pieces, account), client, 'WAL')
      const simulated = await withTimeout(
        client.core.simulateTransaction({
          transaction: fromBase64(transaction),
          include: { balanceChanges: true },
        }),
        DRY_RUN_TIMEOUT_MS,
        'Checking the withdrawal'
      )
      const received = walPaid(simulated.Transaction?.balanceChanges, account)
      if (received === undefined) {
        return refuse(
          "I couldn't confirm how much WAL this would return, so I stopped. Try again shortly."
        )
      }
      return {
        venueId: 'walrus',
        venueName: 'Walrus',
        kind: 'unstake',
        summary: `Collect ${wal(plan.total)} WAL from Walrus, with any rewards it earned.`,
        pay: { amount: wal(plan.total), symbol: 'WAL' },
        receive: {
          amount: displayAmount(received, WAL_DECIMALS),
          symbol: 'WAL',
          approximate: true,
        },
        notes: [
          'This takes your WAL out now, with no further wait.',
          'Stake taken out before it started earning comes back with no rewards.',
          UPGRADE_NOTE,
        ],
        signing: { family: 'sui', transaction },
      }
    }

    const transaction = await deps.build(buildStart(plan.pieces, account), client, 'WAL')
    const date = epochDate(state, plan.collectEpoch)
    return {
      venueId: 'walrus',
      venueName: 'Walrus',
      kind: 'unstake',
      summary: `Start unstaking ${wal(plan.total)} WAL from Walrus. You can collect it from epoch ${plan.collectEpoch}, about ${date}.`,
      pay: { amount: wal(plan.total), symbol: 'WAL' },
      notes: [
        `This only starts the withdrawal. No WAL arrives yet, and it can't be cancelled. It earns until epoch ${plan.collectEpoch}.`,
        `From epoch ${plan.collectEpoch}, about ${date}, ask to unstake ${wal(plan.total)} WAL again to collect it with its rewards. An epoch lasts ${state.epochDurationMs / DAY_MS} days. Dates can slip a little, since an epoch ends when the network moves on.`,
        ...(plan.waiting > BigInt(0)
          ? [
              `${wal(plan.waiting)} WAL is already on its way out, so this starts only the other ${wal(plan.total)}.`,
            ]
          : []),
        UPGRADE_NOTE,
      ],
      signing: { family: 'sui', transaction },
    }
  }

  /** No apyPercent: no rate is read from Walrus here, and a rate is never invented. */
  async function quote(request: ChainActionRequest, account: string): Promise<VenueQuote> {
    const { amount } = await checkedStake(request, account)
    return { receive: { amount: displayAmount(amount, WAL_DECIMALS), symbol: 'StakedWAL' } }
  }

  return {
    id: 'walrus',
    name: 'Walrus',
    kinds: ['stake', 'unstake'],
    assertCanFollow: takesOnly('Walrus', ['WAL']),
    quote,
    prepare: (request, account) =>
      request.kind === 'unstake'
        ? prepareUnstake(request, account)
        : prepareStake(request, account),
    assertSafe: (payload: SigningPayload, account: string) => assertWalrusSafe(payload, account),
  }
}

export const walrusVenue: ChainVenue = createWalrusVenue()
