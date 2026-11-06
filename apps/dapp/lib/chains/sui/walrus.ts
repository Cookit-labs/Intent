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
  type VenuePosition,
  type VenueQuote,
  WHOLE_AMOUNT,
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
const HOUR_MS = 3_600_000
const HOURS_SHOWN_AS_HOURS = 48
const READ_TIMEOUT_MS = 10_000
const DRY_RUN_TIMEOUT_MS = 15_000
const OWNED_PAGE_SIZE = 200
const OWNED_MAX_PAGES = 5
/**
 * Whole positions one transaction may move. A dry run of 488 on mainnet passed at 72 KB of the chain's
 * 128 KB limit and 0.17 SUI of computation, so this leaves room, and the rest is a second ask.
 */
export const MAX_POSITIONS_PER_TRANSACTION = 500

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

function epochStart(state: StakingState, epoch: number): number {
  return state.firstEpochStartMs + (epoch - 1) * state.epochDurationMs
}

function epochDate(state: StakingState, epoch: number): string {
  return new Date(epochStart(state, epoch)).toLocaleDateString('en-GB', {
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

/** Never under an hour: an epoch can run a little past its date, and it still hasn't turned. */
function hoursUntil(state: StakingState, epoch: number, now: number): number {
  return Math.max(1, Math.ceil((epochStart(state, epoch) - now) / HOUR_MS))
}

function timeLeft(hours: number): string {
  if (hours >= HOURS_SHOWN_AS_HOURS) return `about ${Math.ceil(hours / 24)} days`
  return `about ${hours} ${hours === 1 ? 'hour' : 'hours'}`
}

function isCollectable(position: Position, state: StakingState): boolean {
  return position.withdrawEpoch !== undefined && phaseOf(position, state).name === 'ready'
}

/** Exits on their way, soonest first, each with what it will free up. */
function coolingByEpoch(
  positions: readonly Position[],
  state: StakingState
): { epoch: number; total: bigint }[] {
  const totals = new Map<number, bigint>()
  for (const position of positions) {
    const phase = phaseOf(position, state)
    if (phase.name !== 'waiting') continue
    totals.set(phase.epoch, (totals.get(phase.epoch) ?? BigInt(0)) + position.principal)
  }
  return [...totals].map(([epoch, total]) => ({ epoch, total })).sort((a, b) => a.epoch - b.epoch)
}

/**
 * Only a withdrawal someone asked for is `claimable`. A stake that could leave in one step, because
 * it hasn't started earning or its node has left, stays `staked`: nobody asked to end it, and it
 * comes out through an unstake. Amounts are principal, since rewards are only worked out on
 * collecting, where a dry run shows them.
 */
export function venuePositionsFrom(
  positions: readonly Position[],
  state: StakingState,
  now: number = Date.now()
): VenuePosition[] {
  const staked = sum(positions.filter((p) => p.withdrawEpoch === undefined))
  const claimable = sum(positions.filter((p) => isCollectable(p, state)))
  const found: VenuePosition[] = []
  if (staked > BigInt(0)) found.push({ slot: 'staked', symbol: 'WAL', amount: wal(staked) })
  if (claimable > BigInt(0)) {
    found.push({ slot: 'claimable', symbol: 'WAL', amount: wal(claimable) })
  }
  for (const { epoch, total } of coolingByEpoch(positions, state)) {
    found.push({
      slot: 'cooling',
      symbol: 'WAL',
      amount: wal(total),
      readyInHours: hoursUntil(state, epoch, now),
    })
  }
  return found
}

interface Piece {
  position: Position
  /** Set when only part of the position is taken. */
  split: bigint | undefined
}

function sum(positions: readonly Position[]): bigint {
  return positions.reduce((total, p) => total + p.principal, BigInt(0))
}

function largestFirst(positions: readonly Position[]): Position[] {
  return [...positions].sort((a, b) =>
    a.principal === b.principal
      ? a.objectId.localeCompare(b.objectId)
      : a.principal > b.principal
        ? -1
        : 1
  )
}

function wholePieces(positions: readonly Position[]): Piece[] {
  return positions.map((position) => ({ position, split: undefined }))
}

/** Largest first, so the fewest objects move and the last one is split as little as possible. */
function takePieces(positions: readonly Position[], target: bigint): Piece[] {
  const pieces: Piece[] = []
  let remaining = target
  for (const position of largestFirst(positions)) {
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

function sortedByPhase(positions: readonly Position[], state: StakingState) {
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
  return { ready, waiting, active, latestEpoch }
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
  const { ready, waiting, active, latestEpoch } = sortedByPhase(positions, state)
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
      `${wal(readyTotal)} WAL is ready to collect now, which is less than you asked for. Say "claim my WAL" first.`
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

export interface WholeUnstakePlan {
  /** Pays out in this transaction: withdrawals that are ready, and stake that can leave in one step. */
  collect: Piece[]
  /** Starts a withdrawal, to collect later. */
  start: Piece[]
  collectTotal: bigint
  startTotal: bigint
  /** The epoch all of `start` can be collected by. */
  collectEpoch: number | undefined
  /** Already on its way out, so nothing here can speed it up. */
  waiting: bigint
  /** What one transaction couldn't hold, and stays as it is. */
  left: { count: number; total: bigint }
}

/**
 * All of it, whatever state each piece is in. Money that is ready goes first if not everything fits,
 * since it is the part that can actually reach the wallet now.
 */
export function planWholeUnstake(
  positions: readonly Position[],
  state: StakingState
): WholeUnstakePlan {
  const { ready, waiting, active, latestEpoch } = sortedByPhase(positions, state)
  const waitingTotal = sum(waiting)
  if (ready.length + active.length === 0) {
    if (waitingTotal === BigInt(0)) return refuse('This wallet has no WAL staked with Walrus.')
    const epoch = latestEpoch(waiting)
    return refuse(
      `${wal(waitingTotal)} WAL is already on its way out. You can collect it from epoch ${epoch}, about ${epochDate(state, epoch)}.`
    )
  }
  const collect = largestFirst(ready).slice(0, MAX_POSITIONS_PER_TRANSACTION)
  const start = largestFirst(active).slice(0, MAX_POSITIONS_PER_TRANSACTION - collect.length)
  const taken = new Set([...collect, ...start])
  const notTaken = [...ready, ...active].filter((p) => !taken.has(p))
  return {
    collect: wholePieces(collect),
    start: wholePieces(start),
    collectTotal: sum(collect),
    startTotal: sum(start),
    collectEpoch: start.length === 0 ? undefined : latestEpoch(start),
    waiting: waitingTotal,
    left: { count: notTaken.length, total: sum(notTaken) },
  }
}

export interface ClaimPlan {
  pieces: Piece[]
  total: bigint
  left: { count: number; total: bigint }
}

/** Everything ready that one transaction holds, and a refusal saying how long if nothing is. */
export function planClaim(
  positions: readonly Position[],
  state: StakingState,
  now: number = Date.now()
): ClaimPlan {
  const ready = largestFirst(positions.filter((p) => isCollectable(p, state)))
  if (ready.length === 0) {
    const cooling = coolingByEpoch(positions, state)
    const first = cooling[0]
    if (first !== undefined) {
      const when = `in ${timeLeft(hoursUntil(state, first.epoch, now))}, at epoch ${first.epoch}, about ${epochDate(state, first.epoch)}`
      return refuse(
        cooling.length === 1
          ? `Nothing is ready to collect yet. Your ${wal(first.total)} WAL on its way out is ready ${when}.`
          : `Nothing is ready to collect yet. You have ${wal(cooling.reduce((all, c) => all + c.total, BigInt(0)))} WAL on its way out, and the first ${wal(first.total)} WAL is ready ${when}.`
      )
    }
    const staked = sum(positions)
    return refuse(
      staked > BigInt(0)
        ? `Nothing is ready to collect. Your ${wal(staked)} WAL is still staked, so it has to be unstaked first. Say "unstake all WAL" to start that.`
        : 'This wallet has nothing to collect from Walrus.'
    )
  }
  const taken = ready.slice(0, MAX_POSITIONS_PER_TRANSACTION)
  const notTaken = ready.slice(MAX_POSITIONS_PER_TRANSACTION)
  return {
    pieces: wholePieces(taken),
    total: sum(taken),
    left: { count: notTaken.length, total: sum(notTaken) },
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

/** Aftermath's and SpringSui's SUI arrives unasked, so someone may well try to claim it here. */
function assertClaimsWal(tokenIn: string): void {
  const token = tokenIn.trim().toUpperCase()
  if (token === 'WAL') return
  const paidByItself =
    token === 'SUI' || token === 'AFSUI' || token === 'SSUI'
      ? ' SUI from unstaking with Aftermath or SpringSui comes to your wallet by itself, so there is nothing to claim.'
      : ''
  refuse(`Only Walrus has something to claim here, and it pays WAL, not ${tokenIn}.${paidByItself}`)
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

function addCollect(tx: Transaction, pieces: readonly Piece[], account: string): void {
  const coins = pieces.map(({ position, split }) => {
    const stake =
      split === undefined ? positionArgument(tx, position) : splitOff(tx, position, split)
    const [coin] = tx.moveCall({ target: WITHDRAW, arguments: [stakingArgument(tx), stake] })
    if (coin === undefined) throw new Error('Withdrawing returned nothing.')
    return coin
  })
  tx.transferObjects(coins, account)
}

function addStart(tx: Transaction, pieces: readonly Piece[], account: string): void {
  for (const { position, split } of pieces) {
    const stake =
      split === undefined ? positionArgument(tx, position) : splitOff(tx, position, split)
    tx.moveCall({ target: REQUEST_WITHDRAW, arguments: [stakingArgument(tx), stake] })
    // A whole position stays where it is. A part split off is new, so it must go to its owner.
    if (split !== undefined) tx.transferObjects([stake], account)
  }
}

function buildExit(
  collect: readonly Piece[],
  start: readonly Piece[],
  account: string
): Transaction {
  const tx = new Transaction()
  tx.setSender(account)
  if (collect.length > 0) addCollect(tx, collect, account)
  addStart(tx, start, account)
  return tx
}

function startNotes(state: StakingState, collectEpoch: number, total: bigint): string[] {
  const date = epochDate(state, collectEpoch)
  return [
    `This only starts the withdrawal of ${wal(total)} WAL. None of that arrives yet, and it can't be cancelled. It earns until epoch ${collectEpoch}.`,
    `From epoch ${collectEpoch}, about ${date}, say "claim my WAL" to collect it with its rewards. An epoch lasts ${state.epochDurationMs / DAY_MS} days. Dates can slip a little, since an epoch ends when the network moves on.`,
  ]
}

function waitingNote(waiting: bigint, started: bigint): string[] {
  return waiting > BigInt(0)
    ? [
        `${wal(waiting)} WAL is already on its way out, so this starts only the other ${wal(started)}.`,
      ]
    : []
}

function leftNote(
  left: { count: number; total: bigint },
  covered: number,
  state: string
): string[] {
  return left.count > 0
    ? [
        `One transaction can only hold so much, so this covers ${covered} of your ${covered + left.count} Walrus positions. The other ${wal(left.total)} WAL is ${state}. Ask again after this lands to do the rest.`,
      ]
    : []
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
        `To get out, ask to unstake. That starts a withdrawal, which takes one to two epochs (up to ${epochDays * 2} days) and can't be cancelled. Then say "claim my WAL" to collect your WAL and rewards.`,
        UPGRADE_NOTE,
      ],
      signing: { family: 'sui', transaction },
    }
  }

  /** What a dry run says comes back. A transaction that pays out is never shown without this. */
  async function confirmedPayout(
    client: Client,
    transaction: string,
    account: string
  ): Promise<string> {
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
    return displayAmount(received, WAL_DECIMALS)
  }

  async function prepareUnstake(
    request: ChainActionRequest,
    account: string
  ): Promise<PreparedAction> {
    assertSuiAccount(account)
    assertTakesWal(request.tokenIn)
    if (request.wholePosition === true) return prepareWholeUnstake(account)
    const amount = BigInt(toBaseUnits(request.amount, WAL_DECIMALS))
    const client = deps.client()
    const state = await readStakingState(client)
    const plan = planUnstake(await readPositions(client, account), state, amount)

    if (plan.step === 'collect') {
      const transaction = await deps.build(buildExit(plan.pieces, [], account), client, 'WAL')
      const received = await confirmedPayout(client, transaction, account)
      return {
        venueId: 'walrus',
        venueName: 'Walrus',
        kind: 'unstake',
        summary: `Collect ${wal(plan.total)} WAL from Walrus, with any rewards it earned.`,
        pay: { amount: wal(plan.total), symbol: 'WAL' },
        receive: { amount: received, symbol: 'WAL', approximate: true },
        notes: [
          'This takes your WAL out now, with no further wait.',
          'Stake taken out before it started earning comes back with no rewards.',
          UPGRADE_NOTE,
        ],
        signing: { family: 'sui', transaction },
      }
    }

    const transaction = await deps.build(buildExit([], plan.pieces, account), client, 'WAL')
    return {
      venueId: 'walrus',
      venueName: 'Walrus',
      kind: 'unstake',
      summary: `Start unstaking ${wal(plan.total)} WAL from Walrus. You can collect it from epoch ${plan.collectEpoch}, about ${epochDate(state, plan.collectEpoch)}.`,
      pay: { amount: wal(plan.total), symbol: 'WAL' },
      notes: [
        ...startNotes(state, plan.collectEpoch, plan.total),
        ...waitingNote(plan.waiting, plan.total),
        UPGRADE_NOTE,
      ],
      signing: { family: 'sui', transaction },
    }
  }

  async function prepareWholeUnstake(account: string): Promise<PreparedAction> {
    const client = deps.client()
    const state = await readStakingState(client)
    const plan = planWholeUnstake(await readPositions(client, account), state)
    const { collect, start, collectTotal, startTotal, collectEpoch } = plan
    const transaction = await deps.build(buildExit(collect, start, account), client, 'WAL')
    const received =
      collect.length === 0 ? undefined : await confirmedPayout(client, transaction, account)
    const startText =
      collectEpoch === undefined
        ? ''
        : `You can collect it from epoch ${collectEpoch}, about ${epochDate(state, collectEpoch)}.`
    return {
      venueId: 'walrus',
      venueName: 'Walrus',
      kind: 'unstake',
      summary:
        start.length === 0
          ? `Collect ${wal(collectTotal)} WAL from Walrus, with any rewards it earned.`
          : collect.length === 0
            ? `Start unstaking ${wal(startTotal)} WAL from Walrus. ${startText}`
            : `Collect ${wal(collectTotal)} WAL from Walrus now, with any rewards it earned, and start unstaking ${wal(startTotal)} WAL. ${startText}`,
      pay: { amount: wal(collectTotal + startTotal), symbol: 'WAL' },
      ...(received === undefined
        ? {}
        : { receive: { amount: received, symbol: 'WAL', approximate: true } }),
      notes: [
        ...(collect.length === 0
          ? []
          : [
              `${wal(collectTotal)} WAL comes to your wallet in this transaction. Stake taken out before it started earning comes back with no rewards.`,
            ]),
        ...(collectEpoch === undefined ? [] : startNotes(state, collectEpoch, startTotal)),
        ...waitingNote(plan.waiting, startTotal),
        ...leftNote(plan.left, collect.length + start.length, 'not touched by this'),
        UPGRADE_NOTE,
      ],
      signing: { family: 'sui', transaction },
    }
  }

  async function prepareClaim(
    request: ChainActionRequest,
    account: string
  ): Promise<PreparedAction> {
    assertSuiAccount(account)
    assertClaimsWal(request.tokenIn)
    if (request.amount !== WHOLE_AMOUNT) {
      refuse('A claim collects everything that is ready, not a set amount. Say "claim my WAL".')
    }
    const client = deps.client()
    const state = await readStakingState(client)
    const held = await readPositions(client, account)
    const plan = planClaim(held, state)
    const transaction = await deps.build(buildExit(plan.pieces, [], account), client, 'WAL')
    const received = await confirmedPayout(client, transaction, account)
    const cooling = coolingByEpoch(held, state)
    const soonest = cooling[0]
    return {
      venueId: 'walrus',
      venueName: 'Walrus',
      kind: 'claim',
      summary: `Collect ${wal(plan.total)} WAL from Walrus, with any rewards it earned.`,
      pay: { amount: wal(plan.total), symbol: 'WAL' },
      receive: { amount: received, symbol: 'WAL', approximate: true },
      notes: [
        'This takes your WAL out now, with no further wait. Stake you have not asked to unstake is left alone.',
        ...(soonest === undefined
          ? []
          : [
              `Another ${wal(cooling.reduce((all, c) => all + c.total, BigInt(0)))} WAL is on its way out and isn't part of this. The first of it is ready in ${timeLeft(hoursUntil(state, soonest.epoch, Date.now()))}.`,
            ]),
        ...leftNote(plan.left, plan.pieces.length, 'still waiting to be collected'),
        UPGRADE_NOTE,
      ],
      signing: { family: 'sui', transaction },
    }
  }

  async function positions(account: string): Promise<VenuePosition[]> {
    assertSuiAccount(account)
    const client = deps.client()
    const [state, held] = await Promise.all([
      readStakingState(client),
      readPositions(client, account),
    ])
    return venuePositionsFrom(held, state)
  }

  /** No apyPercent: no rate is read from Walrus here, and a rate is never invented. */
  async function quote(request: ChainActionRequest, account: string): Promise<VenueQuote> {
    const { amount } = await checkedStake(request, account)
    return { receive: { amount: displayAmount(amount, WAL_DECIMALS), symbol: 'StakedWAL' } }
  }

  return {
    id: 'walrus',
    name: 'Walrus',
    kinds: ['stake', 'unstake', 'claim'],
    assertCanFollow: takesOnly('Walrus', ['WAL']),
    quote,
    positions,
    prepare: (request, account) => {
      if (request.kind === 'claim') return prepareClaim(request, account)
      return request.kind === 'unstake'
        ? prepareUnstake(request, account)
        : prepareStake(request, account)
    },
    assertSafe: (payload: SigningPayload, account: string) => assertWalrusSafe(payload, account),
  }
}

export const walrusVenue: ChainVenue = createWalrusVenue()
