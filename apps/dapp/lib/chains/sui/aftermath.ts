import { bcs } from '@mysten/sui/bcs'
import { coinWithBalance, Transaction } from '@mysten/sui/transactions'
import { deriveDynamicFieldID, normalizeSuiAddress } from '@mysten/sui/utils'

import {
  ChainActionRefused,
  toBaseUnits,
  type ChainActionRequest,
  type ChainToken,
  type ChainVenue,
  type PreparedAction,
  type SigningPayload,
  type VenuePosition,
  type VenueQuote,
} from '../types'
import { assertSuiAccount, buildUnsigned, suiClient, withTimeout } from './client'
import {
  assertPinnedObjects,
  creditedAmount,
  dryRun,
  percentText,
  readAddress,
  readObjectJson,
  readU64,
  stakesAfterSwap,
  SUI_SYSTEM_STATE,
  u64Field,
} from './haedal'
import { assertPtbSafe, moveTarget, type ParsedCall, type PtbPolicy, type ReadPure } from './safety'
import { displayAmount } from './tokens'

/**
 * All from aftermath.finance/api/addresses (the `staking` section), which aftermath-ts-sdk 6.4.0
 * reads. Its docs' Contracts page lists the same objects, but shifts the package rows by one, so
 * this package reads as `afsui` there. On chain: this is the upgraded LSD package at version 2,
 * its `staked_sui_vault` takes these object types, and live stakes call it.
 */
export const AFTERMATH_PACKAGE =
  '0x1575034d2729907aefca1ac757d6ccfcd3fc7e9e77927523c06007d8353ad836'
export const AFTERMATH_VAULT = '0x2f8f6d5da7f13ea37daa397724280483ed062769813b6f31e9788e59cc88994d'
export const AFTERMATH_VAULT_STATE =
  '0x55486449e41d89cfbdb20e005c1c5c1007858ad5b4d5d7c047d2b3b592fe8791'
export const AFTERMATH_SAFE = '0xeb685899830dd5837b47007809c76d91a098d52aabbf61e8ac467c59e5cc4610'
export const AFTERMATH_REFERRAL_VAULT =
  '0x4ce9a19b594599536c53edb25d22532f82f18038dc8ef618afd00fbbfb9845ef'
/** `aftermathValidator` in the same API. On chain it is active, named Aftermath, with a fee of 0 here. */
export const AFTERMATH_VALIDATOR =
  '0xd30018ec3f5ff1a3c75656abf927a87d7f0529e6dc89c7ddd1bd27ecb05e3db2'
/** On chain, `Safe` holds this coin's TreasuryCap, and its metadata says afSUI, 9 decimals. */
export const AFSUI_TYPE =
  '0xf325ce1300e8dac124071d3152c5c5ee6174914f8bc2161e88329cf579246efc::afsui::AFSUI'

export const AFTERMATH_TOKENS: ChainToken[] = [
  { symbol: 'afSUI', id: AFSUI_TYPE, decimals: 9, name: 'Aftermath Staked SUI' },
]

const SUI_DECIMALS = 9
const AFSUI_DECIMALS = 9
/** The vault's fees are fixed point with 18 decimals. */
const FEE_ONE = BigInt('1000000000000000000')
const SYSTEM_READ_TIMEOUT_MS = 10_000
const MS_PER_HOUR = 3_600_000
const PENDING_BATCH = 50
/** Only a few unstakes wait in any one epoch on chain. Far more than that can't be read in time. */
const PENDING_MAX_RECORDS = 500

const REQUEST_STAKE = moveTarget(AFTERMATH_PACKAGE, 'staked_sui_vault', 'request_stake')
const REQUEST_UNSTAKE = moveTarget(AFTERMATH_PACKAGE, 'staked_sui_vault', 'request_unstake')

function fail(reason: string): never {
  throw new ChainActionRefused(`${reason} Nothing was signed or sent.`)
}

interface VaultReading {
  minimum: bigint
  /** The whole fee a delayed unstake pays on its amount, as a fraction with 18 decimals. */
  feeOnAmount: bigint
  rewardShare: { rewards: bigint; total: bigint }
}

async function readVault(): Promise<VaultReading> {
  const state = await readObjectJson(AFTERMATH_VAULT_STATE)
  const config = state?.['protocol_config'] as Record<string, unknown> | undefined
  const unstakeFee = config?.['default_unstake_protocol_fee'] as Record<string, unknown> | undefined
  const minimum = u64Field(config?.['min_staking_threshold'])
  const totalFee = u64Field(unstakeFee?.['total_fee'])
  const rewards = u64Field(state?.['total_rewards_amount'])
  const total = u64Field(state?.['total_sui_amount'])
  if (
    minimum === undefined ||
    totalFee === undefined ||
    rewards === undefined ||
    total === undefined ||
    total === BigInt(0)
  ) {
    fail("I couldn't read Aftermath's fees, so I stopped. Try again shortly.")
  }
  const share = rewards > total ? total : rewards
  return {
    minimum,
    feeOnAmount: (totalFee * share) / total,
    rewardShare: { rewards, total },
  }
}

function feePercent(vault: VaultReading): number {
  return (Number(vault.feeOnAmount) / Number(FEE_ONE)) * 100
}

/** The chain's epoch, and the hours until the next one, rounded up, from its own clock. */
async function readEpochClock(
  now: number = Date.now()
): Promise<{ epoch: string; hoursToNext: number }> {
  const { systemState } = await withTimeout(
    suiClient().core.getCurrentSystemState(),
    SYSTEM_READ_TIMEOUT_MS,
    'Reading the epoch'
  )
  const started = Number(systemState.epochStartTimestampMs)
  const length = Number(systemState.parameters.epochDurationMs)
  if (!Number.isFinite(started) || !Number.isFinite(length) || length <= 0) {
    fail("I couldn't read when this Sui epoch ends, so I stopped. Try again shortly.")
  }
  return {
    epoch: systemState.epoch,
    hoursToNext: Math.max(1, Math.ceil((started + length - now) / MS_PER_HOUR)),
  }
}

/**
 * afSUI this account has asked to unstake and hasn't been paid for yet. `request_unstake` pushes a
 * record naming the sender onto this `TableVec`, and the epoch step pops each one and pays it. Its
 * entries sit at the keys 0 to size - 1, so exactly those are read, and any that can't be is a throw.
 */
async function readPendingAfsui(
  records: Record<string, unknown> | undefined,
  account: string
): Promise<bigint> {
  const tableId = records?.['id']
  const size = u64Field(records?.['size'])
  if (typeof tableId !== 'string' || size === undefined) {
    throw new Error("Aftermath's waiting unstakes are unreadable")
  }
  if (size > BigInt(PENDING_MAX_RECORDS)) throw new Error('Too many waiting Aftermath unstakes')

  const ids = Array.from({ length: Number(size) }, (_, index) =>
    deriveDynamicFieldID(tableId, 'u64', bcs.u64().serialize(index).toBytes())
  )
  const batches = Array.from({ length: Math.ceil(ids.length / PENDING_BATCH) }, (_, batch) =>
    ids.slice(batch * PENDING_BATCH, (batch + 1) * PENDING_BATCH)
  )
  const reads = await Promise.all(
    batches.map((objectIds) =>
      withTimeout(
        suiClient().core.getObjects({ objectIds, include: { json: true } }),
        SYSTEM_READ_TIMEOUT_MS,
        "Reading Aftermath's waiting unstakes"
      )
    )
  )

  const me = normalizeSuiAddress(account)
  let pending = BigInt(0)
  for (const object of reads.flatMap((read) => read.objects)) {
    if (object instanceof Error) throw object
    const value = (object.json as Record<string, unknown> | null | undefined)?.['value'] as
      | Record<string, unknown>
      | undefined
    const requester = value?.['requester']
    const amount = u64Field(value?.['afsui_amount'])
    // No requester is Aftermath's own bookkeeping for an instant unstake, and nobody's money.
    if (amount === undefined || (requester !== null && typeof requester !== 'string')) {
      throw new Error('An Aftermath waiting unstake is unreadable')
    }
    if (requester !== null && normalizeSuiAddress(requester) === me) pending += amount
  }
  return pending
}

/**
 * afSUI in the wallet to the last unit, whose count doesn't grow, so an "all" using this figure
 * leaves no dust. Also what is on its way: there is nothing to claim, the contract pays by itself.
 */
async function readPositions(account: string): Promise<VenuePosition[]> {
  assertSuiAccount(account)
  const [{ balance }, state] = await Promise.all([
    withTimeout(
      suiClient().core.getBalance({ owner: account, coinType: AFSUI_TYPE }),
      SYSTEM_READ_TIMEOUT_MS,
      'Reading your afSUI'
    ),
    readObjectJson(AFTERMATH_VAULT_STATE),
  ])
  const held = u64Field(balance.balance)
  if (held === undefined) throw new Error('afSUI balance unreadable')
  const records = state?.['pending_unstake_records'] as Record<string, unknown> | undefined
  const pending = await readPendingAfsui(
    records?.['contents'] as Record<string, unknown> | undefined,
    account
  )

  const found: VenuePosition[] = []
  if (held > BigInt(0)) {
    found.push({
      slot: 'staked',
      symbol: 'afSUI',
      amount: displayAmount(held.toString(), AFSUI_DECIMALS, AFSUI_DECIMALS),
    })
  }
  if (pending > BigInt(0)) {
    const { epoch, hoursToNext } = await readEpochClock()
    // Requests are only taken in the epoch the vault is on, so if the chain has moved past it these
    // are already due, and wait only on the epoch step being run.
    const overdue = state?.['active_epoch'] !== epoch
    found.push({
      slot: 'cooling',
      symbol: 'afSUI',
      amount: displayAmount(pending.toString(), AFSUI_DECIMALS, AFSUI_DECIMALS),
      readyInHours: overdue ? 1 : hoursToNext,
    })
  }
  return found
}

async function checkedStake(request: ChainActionRequest, account: string) {
  assertSuiAccount(account)
  if (request.tokenIn.trim().toUpperCase() !== 'SUI') {
    throw new ChainActionRefused(
      `Aftermath stakes SUI, not ${request.tokenIn}. Try "stake 1 SUI with Aftermath".`
    )
  }
  const amount = toBaseUnits(request.amount, SUI_DECIMALS)
  const vault = await readVault()
  if (BigInt(amount) < vault.minimum) {
    fail(`Aftermath stakes at least ${displayAmount(String(vault.minimum), SUI_DECIMALS)} SUI.`)
  }

  const tx = new Transaction()
  tx.setSender(account)
  const [sui] = tx.splitCoins(tx.gas, [BigInt(amount)])
  if (sui === undefined) throw new Error('Splitting a coin returned nothing.')
  const [minted] = tx.moveCall({
    target: REQUEST_STAKE,
    arguments: [
      tx.object(AFTERMATH_VAULT),
      tx.object(AFTERMATH_SAFE),
      tx.object(SUI_SYSTEM_STATE),
      tx.object(AFTERMATH_REFERRAL_VAULT),
      sui,
      tx.pure.address(AFTERMATH_VALIDATOR),
    ],
  })
  if (minted === undefined) throw new Error('Staking returned nothing.')
  tx.transferObjects([minted], account)

  const transaction = await buildUnsigned(tx, suiClient(), 'SUI')
  const simulated = await dryRun(transaction, 'Checking the stake')
  const received = creditedAmount(simulated.Transaction?.balanceChanges, AFSUI_TYPE, account)
  if (received === undefined) {
    fail(
      "I couldn't confirm how much afSUI this stake would return, so I stopped. Try again shortly."
    )
  }
  return { transaction, receive: displayAmount(received, AFSUI_DECIMALS), vault }
}

/**
 * `request_unstake` pays nothing in this transaction: the contract holds the afSUI, and pays the
 * sender when the next epoch is processed. So the amount is worked out from the same two readings
 * the contract uses then, and can't be read from the dry run.
 */
async function checkedUnstake(request: ChainActionRequest, account: string) {
  assertSuiAccount(account)
  if (request.tokenIn.trim().toUpperCase() !== 'AFSUI') {
    throw new ChainActionRefused(
      `Aftermath unstakes afSUI, not ${request.tokenIn}. Try "unstake 1 afSUI with Aftermath".`
    )
  }
  const amount = toBaseUnits(request.amount, AFSUI_DECIMALS)
  const vault = await readVault()
  const value = await readU64(
    account,
    moveTarget(AFTERMATH_PACKAGE, 'staked_sui_vault', 'afsui_to_sui'),
    (tx) => [tx.object(AFTERMATH_VAULT), tx.object(AFTERMATH_SAFE), tx.pure.u64(BigInt(amount))]
  )
  if (value === undefined) {
    fail("I couldn't read what this afSUI is worth, so I stopped. Try again shortly.")
  }
  if (value < vault.minimum) {
    fail(
      `Aftermath unstakes at least ${displayAmount(String(vault.minimum), SUI_DECIMALS)} SUI worth of afSUI. To get out of less than that, swap it: "swap ${request.amount} afSUI to SUI".`
    )
  }

  const tx = new Transaction()
  tx.setSender(account)
  const coin = tx.add(
    coinWithBalance({ type: AFSUI_TYPE, balance: BigInt(amount), useGasCoin: false })
  )
  tx.moveCall({
    target: REQUEST_UNSTAKE,
    arguments: [tx.object(AFTERMATH_VAULT), tx.object(AFTERMATH_SAFE), coin],
  })

  const transaction = await buildUnsigned(tx, suiClient(), 'afSUI')
  const simulated = await dryRun(transaction, 'Checking the unstake')
  if (simulated.Transaction === undefined) {
    fail('This unstake would fail if sent right now, so I stopped. Try again shortly.')
  }
  const fee = (value * vault.feeOnAmount) / FEE_ONE
  return {
    transaction,
    receive: displayAmount(String(value - fee), SUI_DECIMALS),
    vault,
  }
}

const SHARED_RISKS = [
  "Your SUI sits in contracts Aftermath can upgrade through a vote of its signers. Aftermath's admin key can change the fees alone: on chain it is a single signer, not a multisig.",
  'Aftermath Perps, a separate product, lost about $1.14M in April 2026 through a flaw in its withdrawals. Aftermath is reported to have said it was confined to perps. This uses staking, not perps.',
]

/** No apyPercent: no rate can be read from Aftermath here, and a rate is never invented. */
async function quote(request: ChainActionRequest, account: string): Promise<VenueQuote> {
  const { receive } = await checkedStake(request, account)
  return { receive: { amount: receive, symbol: 'afSUI' } }
}

async function prepareStake(request: ChainActionRequest, account: string): Promise<PreparedAction> {
  const { transaction, receive, vault } = await checkedStake(request, account)
  return {
    venueId: 'aftermath',
    venueName: 'Aftermath',
    kind: 'stake',
    summary: `Stake ${request.amount} SUI with Aftermath for about ${receive} afSUI.`,
    pay: { amount: request.amount, symbol: 'SUI' },
    receive: { amount: receive, symbol: 'afSUI', approximate: true },
    notes: [
      'Staking rewards are not guaranteed. They depend on the validators, and I am not showing a rate because I could not read one from Aftermath.',
      "afSUI is worth more than SUI over time, so you get fewer of them, and it can trade below its value on the market. This stake goes to Aftermath's own validator.",
      `To get out, unstake here. The SUI comes at the start of the next Sui epoch, within about 24 hours. The fee is about ${percentText(feePercent(vault))}% of the whole amount right now. The contract works it out from the rewards the whole pool has earned, not yours, so it is charged even if you unstake soon after staking.`,
      ...SHARED_RISKS,
    ],
    signing: { family: 'sui', transaction },
  }
}

async function prepareUnstake(
  request: ChainActionRequest,
  account: string
): Promise<PreparedAction> {
  const { transaction, receive, vault } = await checkedUnstake(request, account)
  const { hoursToNext: hours } = await readEpochClock()
  return {
    venueId: 'aftermath',
    venueName: 'Aftermath',
    kind: 'unstake',
    summary: `Unstake ${request.amount} afSUI with Aftermath. About ${receive} SUI comes to this wallet at the next Sui epoch.`,
    pay: { amount: request.amount, symbol: 'afSUI' },
    receive: { amount: receive, symbol: 'SUI', approximate: true },
    notes: [
      `The SUI does not come in this transaction. It comes at the start of the next Sui epoch, in about ${hours} ${hours === 1 ? 'hour' : 'hours'}, and can't be cancelled once sent.`,
      `You sign nothing more, and there is nothing to claim. The contract pays this wallet when that epoch is processed. Aftermath runs a bot for that, and anyone else can run it too. That is usually minutes into the epoch, but on 1 Nov 2026 it ran about 15 hours in, so the SUI can come later than the epoch alone.`,
      `The fee is about ${percentText(feePercent(vault))}% of the whole amount, already taken off the amount shown. The contract works it out from the rewards the whole pool has earned, not yours. The final amount can move slightly with the next epoch's rate.`,
      'Aftermath also has an instant unstake, with a different fee that depends on its reserves. This app does not use it.',
      ...SHARED_RISKS,
    ],
    signing: { family: 'sui', transaction },
  }
}

const PINS: ReadonlyMap<string, readonly (string | undefined)[]> = new Map([
  [
    REQUEST_STAKE,
    [
      AFTERMATH_VAULT,
      AFTERMATH_SAFE,
      SUI_SYSTEM_STATE,
      AFTERMATH_REFERRAL_VAULT,
      undefined,
      undefined,
    ],
  ],
  [REQUEST_UNSTAKE, [AFTERMATH_VAULT, AFTERMATH_SAFE, undefined]],
])

function checkAftermathCall(call: ParsedCall, read: ReadPure): void {
  if (call.target !== REQUEST_STAKE && call.target !== REQUEST_UNSTAKE) return
  if (call.typeArguments.length > 0) fail('This Aftermath call names a token it should not.')
  if (
    call.target === REQUEST_STAKE &&
    readAddress(read, call.arguments[5]) !== AFTERMATH_VALIDATOR
  ) {
    fail('This stake names a validator I did not choose.')
  }
}

export const AFTERMATH_POLICY: PtbPolicy = {
  venueName: 'Aftermath',
  allowedCalls: new Set([REQUEST_STAKE, REQUEST_UNSTAKE]),
  checkCall: checkAftermathCall,
}

export const aftermathVenue: ChainVenue = {
  id: 'aftermath',
  name: 'Aftermath',
  kinds: ['stake', 'unstake'],
  assertCanFollow: stakesAfterSwap('Aftermath'),
  quote,
  positions: readPositions,
  prepare: (request, account) =>
    request.kind === 'unstake' ? prepareUnstake(request, account) : prepareStake(request, account),
  assertSafe: (payload: SigningPayload, account: string) => {
    assertPtbSafe(payload, account, AFTERMATH_POLICY)
    assertPinnedObjects(payload, PINS, 'Aftermath')
  },
}
