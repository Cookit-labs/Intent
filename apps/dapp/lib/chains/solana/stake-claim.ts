import { isAddress, type Address, type Instruction } from '@solana/kit'
import { z } from 'zod'

import {
  ChainActionRefused,
  WHOLE_AMOUNT,
  type ChainActionRequest,
  type PreparedAction,
  type VenuePosition,
} from '../types'
import { SYSTEM_PROGRAM } from './assert-safe'
import {
  accountRoles,
  CLOCK_SYSVAR,
  compileForSigning,
  computeBudget,
  readAccount,
  readAccounts,
  readAddress,
  readU32,
  readU64,
  STAKE_HISTORY_SYSVAR,
  STAKE_PROGRAM,
  stakeExitAddresses,
  unreadable,
  type InstructionRule,
  type SolanaRpc,
  type StakeShape,
} from './stake-pool'
import { fromBaseUnits } from './tokens'

/**
 * The last step of an unstake that leaves the person a stake account: once it has cooled, the stake
 * program's Withdraw pays its whole balance to the wallet and closes it.
 *
 * The accounts are found by address, not by asking a node for "all stake accounts of this wallet":
 * see `STAKE_EXIT_SLOTS`. Those addresses can only be made with this wallet's signature, and an
 * unstake can only build at one of them, so an exit made here can't fall out of sight.
 */

const { readonly, signer, writable } = accountRoles

/** `StakeStateV2::size_of()` in https://github.com/solana-program/stake, `interface/src/state.rs`. */
const STAKE_ACCOUNT_BYTES = 200
const STATE_INITIALIZED = 1
const STATE_DELEGATED = 2
const NOT_DEACTIVATED = BigInt('18446744073709551615')

/** The fifth variant of `StakeInstruction`, and a u64 of lamports. */
const WITHDRAW = 4
const WITHDRAW_PREFIX = '04000000'

/**
 * `TOWER_WARMUP_COOLDOWN_RATE_BPS` in the stake program's `warmup_cooldown_allowance.rs`: the share
 * of the network's effective stake that may stop being effective per epoch.
 */
const COOLDOWN_RATE_BPS = BigInt(900)
const BASIS_POINTS = BigInt(10_000)

/** About 400ms a slot, Solana's target. A cooling time is an estimate whatever this says. */
const SECONDS_PER_SLOT = 0.4
const MOST_EPOCHS_PROJECTED = 8

/** Each one adds 52 bytes, and this keeps well inside the 1232 a transaction may be. */
export const MAX_CLAIMS_AT_ONCE = 10
/** Withdrawing one measured about 9,600 with its budget in simulation on 5 November 2026. */
const COMPUTE_UNITS_EACH = 20_000

export interface StakeAccountState {
  delegated: boolean
  withdrawer: string
  lockedUp: boolean
  stake: bigint
  deactivationEpoch: bigint
}

/** Any lockup at all counts: the unstakes here never set one, so one means someone else did. */
export function decodeStakeAccount(data: Uint8Array): StakeAccountState | undefined {
  if (data.length !== STAKE_ACCOUNT_BYTES) return undefined
  const state = readU32(data, 0)
  if (state !== STATE_INITIALIZED && state !== STATE_DELEGATED) return undefined
  const delegated = state === STATE_DELEGATED
  return {
    delegated,
    withdrawer: readAddress(data, 44),
    lockedUp:
      readU64(data, 76) !== BigInt(0) ||
      readU64(data, 84) !== BigInt(0) ||
      readAddress(data, 92) !== SYSTEM_PROGRAM,
    stake: delegated ? readU64(data, 156) : BigInt(0),
    deactivationEpoch: delegated ? readU64(data, 172) : NOT_DEACTIVATED,
  }
}

export interface ClusterStake {
  effective: bigint
  deactivating: bigint
}

export type StakeHistory = ReadonlyMap<bigint, ClusterStake>

/** A count, then per epoch its number and the effective, activating and deactivating stake. */
export function decodeStakeHistory(data: Uint8Array): StakeHistory | undefined {
  if (data.length < 8) return undefined
  const count = Number(readU64(data, 0))
  if (8 + count * 32 > data.length) return undefined
  const history = new Map<bigint, ClusterStake>()
  for (let i = 0; i < count; i += 1) {
    const at = 8 + i * 32
    history.set(readU64(data, at), {
      effective: readU64(data, at + 8),
      deactivating: readU64(data, at + 24),
    })
  }
  return history
}

function cooledInAnEpoch(stake: bigint, cluster: ClusterStake): bigint {
  if (cluster.deactivating === BigInt(0)) return BigInt(0)
  const allowance =
    (stake * cluster.effective * COOLDOWN_RATE_BPS) / (cluster.deactivating * BASIS_POINTS)
  return allowance < BigInt(1) ? BigInt(1) : allowance
}

/**
 * The stake that still counts as active, which is what Withdraw holds back. This follows
 * `stake_activating_and_deactivating` in the stake program, taking the stake as fully active when it
 * stopped, which can only overstate it. The chain has the last word: a claim is simulated first.
 */
export function stakeStillCooling(
  stake: bigint,
  deactivationEpoch: bigint,
  epoch: bigint,
  history: StakeHistory
): bigint {
  if (epoch <= deactivationEpoch) return stake
  if (!history.has(deactivationEpoch)) return BigInt(0)
  let left = stake
  for (let at = deactivationEpoch; at < epoch; at += BigInt(1)) {
    const cluster = history.get(at)
    if (cluster === undefined || cluster.deactivating === BigInt(0)) return left
    const cooled = cooledInAnEpoch(left, cluster)
    if (cooled >= left) return BigInt(0)
    left -= cooled
  }
  return left
}

const EpochReply = z.object({
  epoch: z.number().int().nonnegative(),
  slotIndex: z.number().int().nonnegative(),
  slotsInEpoch: z.number().int().positive(),
})

type EpochNow = z.infer<typeof EpochReply>

async function readEpochNow(rpc: SolanaRpc): Promise<EpochNow> {
  const reply = EpochReply.safeParse(await rpc('getEpochInfo', [{ commitment: 'confirmed' }]))
  return reply.success ? reply.data : unreadable()
}

/** Rounded up, and assuming the network's recent pace of leaving holds. */
function hoursUntilCooled(left: bigint, now: EpochNow, history: StakeHistory): number {
  const latest = history.get(BigInt(now.epoch - 1))
  let epochsMore = 0
  let rest = left
  while (latest !== undefined && epochsMore < MOST_EPOCHS_PROJECTED) {
    const cooled = cooledInAnEpoch(rest, latest)
    if (cooled >= rest || cooled === BigInt(0)) break
    rest -= cooled
    epochsMore += 1
  }
  const slots = now.slotsInEpoch - now.slotIndex + epochsMore * now.slotsInEpoch
  return Math.max(1, Math.ceil((slots * SECONDS_PER_SLOT) / 3600))
}

interface ReadyExit {
  address: string
  lamports: bigint
}

interface CoolingExit {
  lamports: bigint
  readyInHours: number
}

export interface StakeExits {
  ready: ReadyExit[]
  cooling: CoolingExit[]
  /** Accounts at these addresses this can't pay out, and why. */
  anotherWallet: number
  lockedUp: number
  delegatedAgain: number
}

/** Throws if anything can't be read, because a missing account here would read as no money. */
export async function readStakeExits(rpc: SolanaRpc, account: string): Promise<StakeExits> {
  if (!isAddress(account)) throw new ChainActionRefused('That is not a Solana wallet address.')
  const addresses = stakeExitAddresses(account)
  const accounts = await readAccounts(rpc, addresses)
  const exits: StakeExits = {
    ready: [],
    cooling: [],
    anotherWallet: 0,
    lockedUp: 0,
    delegatedAgain: 0,
  }
  const found = accounts.flatMap((held, slot) => {
    if (held === undefined || held.owner !== STAKE_PROGRAM) return []
    const state = decodeStakeAccount(held.data)
    const address = addresses[slot]
    return state === undefined || address === undefined
      ? []
      : [{ address, lamports: held.lamports, state }]
  })
  const payable = found.filter(({ state }) => {
    if (state.withdrawer !== account) exits.anotherWallet += 1
    else if (state.lockedUp) exits.lockedUp += 1
    else if (state.delegated && state.deactivationEpoch === NOT_DEACTIVATED) {
      exits.delegatedAgain += 1
    } else return true
    return false
  })
  if (payable.length === 0) return exits

  const now = await readEpochNow(rpc)
  const epoch = BigInt(now.epoch)
  const history = payable.some(({ state }) => state.delegated)
    ? decodeStakeHistory((await readAccount(rpc, STAKE_HISTORY_SYSVAR)).data)
    : new Map<bigint, ClusterStake>()
  if (history === undefined) return unreadable()
  for (const { address, lamports, state } of payable) {
    const left = state.delegated
      ? stakeStillCooling(state.stake, state.deactivationEpoch, epoch, history)
      : BigInt(0)
    if (left === BigInt(0)) exits.ready.push({ address, lamports })
    else exits.cooling.push({ lamports, readyInHours: hoursUntilCooled(left, now, history) })
  }
  return exits
}

const solText = (lamports: bigint): string => fromBaseUnits(lamports.toString(), 9)

const total = (exits: readonly { lamports: bigint }[]): bigint =>
  exits.reduce((sum, exit) => sum + exit.lamports, BigInt(0))

export function stakeExitPositions(exits: StakeExits): VenuePosition[] {
  return [
    ...exits.ready.map(
      ({ lamports }): VenuePosition => ({
        slot: 'claimable',
        symbol: 'SOL',
        amount: solText(lamports),
      })
    ),
    ...exits.cooling.map(
      ({ lamports, readyInHours }): VenuePosition => ({
        slot: 'cooling',
        symbol: 'SOL',
        amount: solText(lamports),
        readyInHours,
      })
    ),
  ]
}

function coolingText(cooling: readonly CoolingExit[]): string {
  const soonest = Math.min(...cooling.map((exit) => exit.readyInHours))
  const hours = `about ${soonest} ${soonest === 1 ? 'hour' : 'hours'} from now`
  return `${solText(total(cooling))} SOL is still cooling, ${hours}, or longer if an unusual amount of the network is leaving at once.`
}

function nothingReady(venueName: string, exits: StakeExits): never {
  let sentence = `You have no ${venueName} unstake waiting to be claimed.`
  if (exits.cooling.length > 0) sentence = coolingText(exits.cooling)
  else if (exits.anotherWallet > 0) {
    sentence =
      'A stake account from your unstake can now only be paid out by another wallet, so I can’t claim it.'
  } else if (exits.lockedUp > 0) {
    sentence = 'A stake account from your unstake is locked, so I can’t claim it.'
  } else if (exits.delegatedAgain > 0) {
    sentence =
      'A stake account from your unstake has been delegated again, so it isn’t cooling. Deactivate it in a wallet that manages stake accounts, then claim once it has cooled.'
  }
  throw new ChainActionRefused(`${sentence} Nothing was signed or sent.`)
}

/** Clock and stake history by position: the form the program has always taken, and still does. */
export function withdrawStakeAccount(
  account: string,
  stakeAccount: string,
  lamports: bigint
): Instruction {
  const data = new DataView(new ArrayBuffer(12))
  data.setUint32(0, WITHDRAW, true)
  data.setBigUint64(4, lamports, true)
  return {
    programAddress: STAKE_PROGRAM as Address,
    accounts: [
      writable(stakeAccount),
      writable(account),
      readonly(CLOCK_SYSVAR),
      readonly(STAKE_HISTORY_SYSVAR),
      signer(account),
    ],
    data: new Uint8Array(data.buffer),
  }
}

const Simulated = z.object({ value: z.object({ err: z.unknown() }) })

export interface StakeClaim {
  rpc: SolanaRpc
  venueId: string
  venueName: string
  /** What was unstaked, which a person may well name when asking for the SOL. */
  stakedSymbol: string
  request: ChainActionRequest
  account: string
}

export async function prepareStakeClaim(claim: StakeClaim): Promise<PreparedAction> {
  const { rpc, venueId, venueName, stakedSymbol, request, account } = claim
  const asked = request.tokenIn.trim().toUpperCase()
  if (asked !== 'SOL' && asked !== stakedSymbol.toUpperCase()) {
    throw new ChainActionRefused(
      `${venueName} pays a claim in SOL here, not ${request.tokenIn}. Nothing was signed or sent.`
    )
  }
  if (request.amount !== WHOLE_AMOUNT) {
    throw new ChainActionRefused(
      `A claim collects everything that is ready, not a set amount. Try "claim SOL from ${venueName}". Nothing was signed or sent.`
    )
  }
  const exits = await readStakeExits(rpc, account)
  const taken = exits.ready.slice(0, MAX_CLAIMS_AT_ONCE)
  if (taken.length === 0) return nothingReady(venueName, exits)

  const transaction = await compileForSigning(rpc, account, [
    ...computeBudget(COMPUTE_UNITS_EACH * taken.length),
    ...taken.map(({ address, lamports }) => withdrawStakeAccount(account, address, lamports)),
  ])
  const simulated = Simulated.safeParse(
    await rpc('simulateTransaction', [
      transaction,
      {
        encoding: 'base64',
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: 'confirmed',
      },
    ])
  )
  if (!simulated.success) return unreadable()
  if (simulated.data.value.err !== null) {
    throw new ChainActionRefused(
      'Collecting this would fail on the chain right now. Keep a little SOL in your wallet for the network fee, and try again shortly. Nothing was signed or sent.'
    )
  }

  const amount = solText(total(taken))
  const accounts = taken.map(({ address }) => address).join(', ')
  const left = exits.ready.length - taken.length
  return {
    venueId,
    venueName,
    kind: 'claim',
    summary: `Collect ${amount} SOL from what your ${venueName} unstake left waiting, paid to your wallet now.`,
    pay: { amount, symbol: 'SOL' },
    receive: { amount, symbol: 'SOL', approximate: false },
    notes: [
      `This withdraws the whole balance of ${taken.length === 1 ? 'your stake account' : 'your stake accounts'} ${accounts} to this wallet and closes ${taken.length === 1 ? 'it' : 'them'}, which also returns the deposit that held ${taken.length === 1 ? 'it' : 'them'} open.`,
      'It calls Solana’s own stake program and needs only your signature. Your wallet pays a small network fee, so it must hold a little SOL.',
      ...(exits.cooling.length > 0 ? [coolingText(exits.cooling)] : []),
      ...(left > 0
        ? [`There are ${left} more ready after this, so claim again once this lands.`]
        : []),
    ],
    signing: { family: 'solana', transaction },
  }
}

/** Only ever to the signer, from an address only an unstake by this signer could have made. */
export function stakeClaimShapes(account: string): readonly StakeShape[] {
  const own = new Set(stakeExitAddresses(account))
  const rule: InstructionRule = {
    program: STAKE_PROGRAM,
    prefix: WITHDRAW_PREFIX,
    length: 12,
    accountCount: 5,
    accounts: { 1: account, 2: CLOCK_SYSVAR, 3: STAKE_HISTORY_SYSVAR, 4: account },
    also: ({ accounts, data }) => own.has(accounts[0] ?? '') && readU64(data, 4) > BigInt(0),
  }
  return Array.from({ length: MAX_CLAIMS_AT_ONCE }, (_, i) => ({
    rules: Array.from({ length: i + 1 }, () => rule),
    also: (instructions) =>
      new Set(instructions.map(({ accounts }) => accounts[0])).size === instructions.length
        ? undefined
        : 'This transaction claims the same stake account more than once.',
  }))
}
